# 淘宝 & 虾皮消息收集 — 命令示例

## 环境准备

### 1. 凭证文件 `~/.auto-browser/credentials.json`

```bash
cat > ~/.auto-browser/credentials.json << 'EOF'
{
  "sites": {
    "taobao.com": {
      "username": "your_taobao_account",
      "password": "your_password"
    },
    "shopee.tw": {
      "username": "your_shopee_account",
      "password": "your_password"
    }
  }
}
EOF
chmod 0600 ~/.auto-browser/credentials.json
```

### 2. 启动控制服务

```bash
auto-browser serve --port 4317
```

---

## 首次登录（建立 Cookie）

### 淘宝 — 首次登录并保存 Cookie

```bash
auto-browser run \
  --goal "打开淘宝登录页面，填写账号密码登录，然后进入消息页面确认登录成功" \
  --headed \
  --cookies-path ./taobao-cookies.json \
  --credentials-path ~/.auto-browser/credentials.json \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-pro \
  --tui
```

执行时 AI 会自动填表，遇到验证码会触发 handoff。你手动在浏览器窗口中完成滑块/短信验证，然后：

```bash
auto-browser resume --task-id <task-id> --planner-model deepseek-v4-pro
```

### 虾皮 — 首次登录并保存 Cookie

```bash
auto-browser run \
  --goal "打开虾皮卖家中心登录页面，填写账号密码登录，访问聊聊/消息中心确认登录成功" \
  --headed \
  --cookies-path ./shopee-cookies.json \
  --credentials-path ~/.auto-browser/credentials.json \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-pro \
  --tui
```

遇到验证码时同上，手动完成后 resume。

---

## 日常消息收集（全自动，复用 Cookie）

### 淘宝消息收集

```bash
auto-browser run \
  --goal "打开淘宝消息中心，读取所有未读消息，提取每条消息的发送者、内容和时间" \
  --cookies-path ./taobao-cookies.json \
  --headless \
  --json \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash
```

### 虾皮聊聊/消息收集

```bash
auto-browser run \
  --goal "打开虾皮聊聊页面，读取所有未读会话的消息，提取买家昵称、消息内容和时间" \
  --cookies-path ./shopee-cookies.json \
  --headless \
  --json \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash
```

---

## Bearer/已登录 Cookie 刷新（每周维护）

```bash
# 淘宝 — 带着已有 cookie 访问，刷新登录态
auto-browser run \
  --goal "打开淘宝首页，确认已登录，访问消息页面确保可正常访问" \
  --cookies-path ./taobao-cookies.json \
  --headed \
  --tui

# 虾皮 — 同理
auto-browser run \
  --goal "打开虾皮首页，确认已登录，访问聊聊页面确保可正常访问" \
  --cookies-path ./shopee-cookies.json \
  --headed \
  --tui
```

---

## Cookie 过期后重新登录

```bash
# 淘宝重新登录
auto-browser run \
  --goal "登录淘宝" \
  --headed \
  --cookies-path ./taobao-cookies.json \
  --credentials-path ~/.auto-browser/credentials.json \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-pro \
  --tui

# 虾皮重新登录
auto-browser run \
  --goal "登录虾皮卖家中心" \
  --headed \
  --cookies-path ./shopee-cookies.json \
  --credentials-path ~/.auto-browser/credentials.json \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-pro \
  --tui
```

---

## 通过 HTTP API 程序化调用

```bash
# 1. Create conversation
curl -s -X POST http://127.0.0.1:4317/api/conversations | jq -r '.id'
# → conv-xxx

# 2. Submit goal (淘宝消息收集)
curl -s -X POST http://127.0.0.1:4317/api/conversations/conv-xxx/messages \
  -H 'content-type: application/json' \
  -d '{
    "content": "打开淘宝消息中心，读取所有未读消息",
    "browserConfig": {
      "launchMode": "headless",
      "cookiesPath": "./taobao-cookies.json"
    },
    "plannerModel": "deepseek-v4-pro"
  }' | jq '.taskId'
# → task-yyy

# 3. Run task (non-blocking, events via SSE)
curl -s -X POST http://127.0.0.1:4317/api/tasks/task-yyy/run \
  -H 'content-type: application/json' \
  -d '{"executorModel": "deepseek-v4-flash"}'

# 4. Monitor events
curl -N http://127.0.0.1:4317/api/events
```

---

## 高级配置

### 使用固定浏览器 Profile（减少风控）

```bash
auto-browser run \
  --goal "..." \
  --cookies-path ./taobao-cookies.json \
  --profile-path ./taobao-profile \
  --headless
```

### 通过代理访问

```bash
AGENT_BROWSER_PROXY="http://your-proxy:8080" \
auto-browser run \
  --goal "..." \
  --cookies-path ./taobao-cookies.json \
  --headless
```

### 集成到脚本（获取 JSON 输出）

```bash
#!/bin/bash
# collect-taobao-messages.sh
RESULT=$(auto-browser run \
  --goal "打开淘宝消息中心，读取今天的所有消息并返回JSON格式结果" \
  --cookies-path /home/user/auto-browser-cookies/taobao-cookies.json \
  --headless \
  --json \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash 2>/dev/null)

echo "$RESULT" | tee -a /var/log/auto-browser/taobao-messages.log
```
