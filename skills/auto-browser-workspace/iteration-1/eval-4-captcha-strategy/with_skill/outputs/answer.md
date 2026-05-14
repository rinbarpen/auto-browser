# 淘宝 & 虾皮(Shopee) 消息收集自动化方案

## 问题分析

淘宝和虾皮的反爬/验证码体系非常成熟，主要包括：

| 验证类型 | 淘宝 | 虾皮(Shopee) |
|----------|------|-------------|
| 滑块验证码 | 阿里滑块（行为验证） | 滑块验证 |
| 设备指纹检测 | 强（WebGL、Canvas、字体等） | 中等 |
| 短信验证 | 频繁（异地/新设备登录触发） | 偶发 |
| 登录验证码 | 图片点选（滑块+点选组合） | reCAPTCHA / 滑块 |
| 风控检测 | 基于行为轨迹的实时风控 | 基于 IP/频次的限流 |
| Cookie 有效期 | 相对较长（数天到数周） | 数小时到数天 |

**核心结论**：淘宝的阿里滑块和腾讯滑块属于 auto-browser 内置能力不支持的验证码类型。直接硬碰硬做全自动登录是不现实的。最可靠的方案是利用 cookie 持久化，绕过登录环节。

---

## 推荐方案（三层递进策略）

### 第一优先级：Cookie 复用（最佳方案 — 全自动、最快）

**原理**：完成一次认证后，将浏览器的会话 cookie 持久化下来。后续所有任务复用这些 cookie，网站识别为已登录用户，**直接跳过所有验证码**——滑块、短信、设备指纹全部绕开。

```
首次登录（人工参与一次）
  │
  ├─ headed 模式打开浏览器
  ├─ AI 导航到登录页 + 自动填表
  ├─ 你手动完成滑块/短信验证码
  ├─ 登录成功后，cookie 自动保存到文件
  │
后续任务（全自动，零人工）
  ├─ 自动加载 cookie
  ├─ 直接访问消息页面（已登录状态）
  └─ 提取消息内容
```

**为什么这是最靠谱的方案**：
1. 电商站点的登录态通常持续数天到数周
2. 已登录用户的 API 请求和页面访问几乎不触发风控
3. 不需要和验证码正面交锋
4. 完全避开设备指纹检测问题
5. 执行速度快（跳过了整个登录流程）

### 第二优先级：Handoff 模式（半自动回退方案）

当 cookie 过期或需要重新登录时使用。AI 负责填表导航，验证码留给真人处理。

**流程**：
1. AI 导航到登录页面
2. AI 从 `credentials.json` 读取并填充用户名/密码
3. 遇到验证码 → AI 检测到 blocker → 自动触发 handoff
4. 你手动完成滑块/短信/点选验证码
5. 执行 `auto-browser resume` 恢复任务
6. AI 继续执行消息收集

### 第三优先级：全自动（兜底方案）

仅适用于 auto-browser 内置支持的验证码类型（Cloudflare Turnstile、reCAPTCHA v2、简单图片验证码）。**对淘宝/虾皮不适用**——它们的滑块属于阿里/腾讯系私有协议，自动绕过成功率极低且风险高。

---

## 具体实施步骤

### Step 1: 准备凭证文件

创建 `~/.auto-browser/credentials.json`（文件权限 0600）：

```json
{
  "sites": {
    "taobao.com": {
      "username": "your_taobao_account",
      "password": "your_password"
    },
    "shopee.tw": {
      "username": "your_shopee_account",
      "password": "your_password"
    },
    "shopee.co.id": {
      "username": "your_shopee_account",
      "password": "your_password"
    }
  }
}
```

系统会根据域名自动匹配对应凭证（支持子域名 fallback，例如 `login.taobao.com` → `taobao.com`）。

### Step 2: 启动控制服务

```bash
auto-browser serve --port 4317
```

### Step 3: 首次登录 — 建立 Cookie 持久化

分别对淘宝和虾皮各执行一次 headed 登录（需要你手动完成验证码）：

**淘宝**：
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

**虾皮（以台湾站为例）**：
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

首次登录时，AI 会自动：
- 从 `credentials.json` 匹配对应站点的用户名密码
- 检测页面上的用户名/密码输入框（支持中文和英文关键词）
- 自动填充账号密码
- 遇到登录按钮自动点击
- 检测到滑块验证码/短信验证 → 自动触发 handoff，TUI 中显示提示
- 你在浏览器窗口中手动完成验证码
- 执行 resume 后 AI 继续

Cookies 在任务完成时自动保存到指定路径。

### Step 4: 每日消息收集（全自动）

Cookie 建立后，后续任务全部自动化：

**淘宝消息收集**：
```bash
auto-browser run \
  --goal "打开淘宝消息中心，读取所有未读消息，提取每条消息的发送者、内容和时间" \
  --cookies-path ./taobao-cookies.json \
  --headless \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash
```

**虾皮聊聊/消息收集**：
```bash
auto-browser run \
  --goal "打开虾皮聊聊/消息页面，读取所有未读消息，提取每条消息的买家、内容和时间" \
  --cookies-path ./shopee-cookies.json \
  --headless \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash
```

### Step 5: Cron 定时调度

```bash
# 每天上午10点执行淘宝消息收集
0 10 * * * /path/to/auto-browser run \
  --goal "打开淘宝消息中心，读取今天的未读消息并保存结果" \
  --cookies-path /path/to/taobao-cookies.json \
  --headless \
  --json > /var/log/auto-browser/taobao-$(date +\%Y\%m\%d).json

# 每天下午3点执行虾皮消息收集
0 15 * * * /path/to/auto-browser run \
  --goal "打开虾皮聊聊页面，读取今天的未读消息并保存结果" \
  --cookies-path /path/to/shopee-cookies.json \
  --headless \
  --json > /var/log/auto-browser/shopee-$(date +\%Y\%m\%d).json
```

---

## Cookie 过期处理机制

### 如何检测 cookie 过期
- AI 在执行任务时会检测是否被重定向到登录页面
- 如果检测到登录表单，且 cookie 无法维持登录态，自动标记为 handoff

### 处理流程
```bash
# Cookie 过期后重新登录
auto-browser run \
  --goal "登录淘宝" \
  --headed \
  --cookies-path ./taobao-cookies.json \
  --credentials-path ~/.auto-browser/credentials.json \
  --tui
```

### Cookie 维护建议
- 每周用 headed 模式主动刷新一次 cookie（访问任意需要登录的页面，系统会自动保存新的 cookie）
- 或当任务检测到需要重新登录时，触发告警然后手动恢复

---

## 额外建议

### 1. 降低风控风险

- **使用固定的浏览器 profile**：保持一致的浏览器指纹特征，避免被风控系统标记为异常设备
  ```bash
  auto-browser run --profile-path ./taobao-profile --cookies-path ./taobao-cookies.json ...
  ```

- **使用国内代理（如果需要从非大陆 IP 访问淘宝）**：
  ```bash
  AGENT_BROWSER_PROXY="http://proxy-server:port" auto-browser run ...
  ```

- **控制访问频率**：不要秒级高频刷新页面，自然执行即可

### 2. 使用 TUI 实时监控

对于重要的任务，建议使用 TUI 模式实时观察执行状态：
```bash
auto-browser run --goal "..." --cookies-path ./taobao-cookies.json --tui
```

### 3. Extension 模式作为备选

如果 Playwright 驱动的 managed 模式仍然被检测到，可以尝试 Extension 模式——它在真实 Chrome 浏览器中运行，设备指纹完全真实：

1. 启动控制服务 `auto-browser serve`
2. 在 Chrome 中加载 `extension/` 目录
3. 通过侧边栏提交任务，执行过程在真实浏览器页面中进行

---

## 方案总结

| 阶段 | 操作 | 人工参与 | 频率 |
|------|------|----------|------|
| 首次登录 | headed 模式 + 手动验证码 | 需要（仅在验证码环节） | 一次 |
| Cookie 建立 | 任务完成时自动保存 | 不需要 | 自动 |
| 日常收集 | headless 模式 + cookie 复用 | 不需要 | 每日/按需 |
| Cookie 过期 | 重新执行首次登录流程 | 需要 | 数天到数周一次 |
| 持续维护 | 定期 headed 模式刷新 cookie | 不需要（可自动化） | 每周 |

**一句话总结**：对于淘宝和虾皮这种强反爬站点，不要试图和验证码正面硬刚。用一次人工参与的 headed 登录把 cookie 拿到，之后全部靠 cookie 复用全自动跑——这是经过验证的、最靠谱的策略。
