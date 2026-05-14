# 淘宝 & 虾皮消息收集 — 命令示例

## 一、初次配置

### 1.1 配置凭证文件

```bash
mkdir -p ~/.auto-browser
cat > ~/.auto-browser/credentials.json << 'EOF'
{
  "sites": {
    "taobao.com": {
      "username": "your_taobao_account",
      "password": "your_taobao_password"
    },
    "shopee.tw": {
      "username": "your_shopee_account",
      "password": "your_shopee_password"
    },
    "shopee.sg": {
      "username": "your_shopee_sg_account",
      "password": "your_shopee_sg_password"
    }
  }
}
EOF
chmod 600 ~/.auto-browser/credentials.json
```

### 1.2 使用真实 Chrome Profile 执行首次登录（推荐方案）

```bash
# 启动控制服务（后台运行）
auto-browser serve --port 4317 &

# 淘宝 — 首次登录并保存 cookie
auto-browser run \
  --goal "登录淘宝(taobao.com)，访问卖家中心的消息页面，确认能正常看到消息列表" \
  --browser-family chrome \
  --executable-path "/usr/bin/google-chrome" \
  --profile-path "$HOME/.config/google-chrome" \
  --cookies-path "./cookies/taobao-cookies.json" \
  --credentials-path ~/.auto-browser/credentials.json \
  --headed \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --tui

# 虾皮 — 首次登录并保存 cookie
auto-browser run \
  --goal "登录虾皮卖家中心(shopee.tw 或 shopee.sg)，访问消息/聊聊页面，确认能正常看到买家消息" \
  --browser-family chrome \
  --executable-path "/usr/bin/google-chrome" \
  --profile-path "$HOME/.config/google-chrome" \
  --cookies-path "./cookies/shopee-cookies.json" \
  --credentials-path ~/.auto-browser/credentials.json \
  --headed \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --tui
```

> 执行过程中如果遇到滑块/短信验证，AI 会自动触发 handoff。
> 你在浏览器中手动完成验证后，运行：
> ```bash
> auto-browser resume --task-id <task-id> --planner-model deepseek-v4-pro
> ```
> AI 将继续执行后续步骤。登录成功后 cookies 自动保存。

## 二、日常自动化收集

### 2.1 淘宝消息收集（Cookie 有效时全自动）

```bash
auto-browser run \
  --goal "访问淘宝卖家中心的消息列表，逐条收集所有未读消息。对每条消息记录：发送者昵称、消息内容、发送时间、商品链接（如有）。收集完成后输出完整列表。" \
  --cookies-path "./cookies/taobao-cookies.json" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --json > taobao-messages-$(date +%Y%m%d-%H%M).json
```

### 2.2 虾皮消息收集

```bash
auto-browser run \
  --goal "访问虾皮卖家中心聊聊(Chat)页面，逐条收集所有未回复的买家消息。对每条消息记录：买家用户名、消息内容、发送时间、关联商品、订单号（如有）。收集完成后输出完整列表。" \
  --cookies-path "./cookies/shopee-cookies.json" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --json > shopee-messages-$(date +%Y%m%d-%H%M).json
```

### 2.3 Headless 模式（确认 cookie 有效后的纯后台执行）

```bash
# 仅当确认 cookie 有效时使用 headless
auto-browser run \
  --goal "快速收集淘宝消息中心未读消息列表" \
  --cookies-path "./cookies/taobao-cookies.json" \
  --headless \
  --planner-model deepseek-v4-flash \
  --executor-model deepseek-v4-flash \
  --json
```

## 三、Cookie 有效期健康检查

### 3.1 检查脚本

```bash
#!/bin/bash
# check-cookie-health.sh — 检查 cookie 是否仍然有效

check_site() {
  local NAME="$1"
  local COOKIE_PATH="$2"
  local LOGIN_URL="$3"
  local SUCCESS_SIGNAL="$4"

  echo "[$(date)] 检查 ${NAME} cookie 状态..."

  RESULT=$(auto-browser run \
    --goal "打开该页面。如果页面显示'${SUCCESS_SIGNAL}'（已登录状态），直接回答 'OK'。如果跳转到登录页面或显示'${LOGIN_URL}'相关登录界面，回答 'EXPIRED'。" \
    --cookies-path "${COOKIE_PATH}" \
    --headless \
    --planner-model deepseek-v4-flash \
    --executor-model deepseek-v4-flash \
    --json 2>&1)

  echo "[$(date)] ${NAME}: ${RESULT}"

  if echo "${RESULT}" | grep -qi "EXPIRED\|handoff"; then
    echo "[ALERT] ${NAME} cookie 已过期，需要重新登录！"
    # 在这里触发通知（可接入企业微信/钉钉/飞书/邮件）
    # curl -X POST "https://your-notify-webhook" -d "{\"text\":\"${NAME} Cookie 过期\"}"
    return 1
  fi
  return 0
}

# 淘宝检查
check_site "淘宝" "./cookies/taobao-cookies.json" "login.taobao.com" "消息"

# 虾皮检查
check_site "虾皮" "./cookies/shopee-cookies.json" "shopee.tw/buyer/login" "聊聊"
```

### 3.2 通过 Crontab 定时检查

```bash
# 每天早上 8:55 检查 cookie，确保 9:00 收集任务可以正常运行
55 8 * * * /home/user/scripts/check-cookie-health.sh >> /var/log/cookie-health.log 2>&1

# 每 6 小时执行一次消息收集
0 9,15,21 * * * /home/user/scripts/collect-messages.sh >> /var/log/message-collect.log 2>&1
```

## 四、Cookie 过期时重新登录

### 4.1 Handoff 重新登录

```bash
# 当 cookie 过期时，用 headed 模式重新登录
auto-browser run \
  --goal "登录淘宝(taobao.com)" \
  --browser-family chrome \
  --executable-path "/usr/bin/google-chrome" \
  --profile-path "$HOME/.config/google-chrome" \
  --credentials-path ~/.auto-browser/credentials.json \
  --cookies-path "./cookies/taobao-cookies.json" \
  --headed \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --tui

# 遇到验证码 → AI 触发 handoff → 你在浏览器手动完成
# 然后 resume:
auto-browser resume --task-id <task-id> --planner-model deepseek-v4-pro
# Cookie 自动保存，下次任务恢复全自动
```

## 五、使用代理提升伪装度

### 5.1 配置住宅代理

```bash
# 使用代理访问（降低同一 IP 频繁访问的风险）
export AGENT_BROWSER_PROXY="http://proxy-user:proxy-pass@residential-proxy.example.com:8080"
export AGENT_BROWSER_PROXY_BYPASS="localhost,127.0.0.1,::1"

auto-browser run \
  --goal "收集淘宝消息中心的最新消息" \
  --cookies-path "./cookies/taobao-cookies.json" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --headless \
  --json
```

> 注意：使用代理时 cookie 可能与 IP 绑定，频繁切换代理 IP 反而会触发风控。建议使用固定 IP 的住宅代理。

## 六、完整自动化脚本示例

```bash
#!/bin/bash
# collect-messages.sh — 完整的消息收集脚本

set -euo pipefail

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_DIR="./outputs/${TIMESTAMP}"
mkdir -p "${OUTPUT_DIR}" "./cookies"

# 检查控制服务
if ! curl -s http://127.0.0.1:4317/api/state > /dev/null 2>&1; then
  echo "启动控制服务..."
  auto-browser serve --port 4317 &
  sleep 3
fi

# 收集淘宝消息
echo "[${TIMESTAMP}] 收集淘宝消息..."
auto-browser run \
  --goal "访问淘宝卖家中心，收集所有未读消息，以 JSON 格式列出每条消息的发送者、内容、时间" \
  --cookies-path "./cookies/taobao-cookies.json" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --json 2>&1 | tee "${OUTPUT_DIR}/taobao-result.json"

# 判断结果
if grep -qi "handoff\|expired\|登录" "${OUTPUT_DIR}/taobao-result.json"; then
  echo "[WARN] 淘宝 cookie 可能已过期，标记需要重新登录"
  echo "TAOBAO_EXPIRED=1" >> "${OUTPUT_DIR}/status.txt"
fi

# 收集虾皮消息
echo "[${TIMESTAMP}] 收集虾皮消息..."
auto-browser run \
  --goal "访问虾皮卖家中心聊聊页面，收集所有未回复的买家消息，以 JSON 格式列出每条消息的买家、内容、时间、关联商品" \
  --cookies-path "./cookies/shopee-cookies.json" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --json 2>&1 | tee "${OUTPUT_DIR}/shopee-result.json"

if grep -qi "handoff\|expired\|登录" "${OUTPUT_DIR}/shopee-result.json"; then
  echo "[WARN] 虾皮 cookie 可能已过期，标记需要重新登录"
  echo "SHOPEE_EXPIRED=1" >> "${OUTPUT_DIR}/status.txt"
fi

echo "[${TIMESTAMP}] 消息收集完成，结果保存在 ${OUTPUT_DIR}/"
```
