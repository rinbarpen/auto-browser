---
name: auto-browser
description: >-
  Full-stack browser automation system with CLI, HTTP API, Chromium MV3 extension, Electron desktop shell, and Next.js web UI. Dual-LLM architecture (planner + executor) with TUI watch mode, credential auto-fill, Cloudflare/CAPTCHA bypass, and cookie persistence. Use this skill whenever the user wants to automate browser tasks — form filling, data extraction, login flows, navigation, scraping, testing — whether they ask for "browser automation", "Playwright", "headless browser", "web scraping", "auto-fill", or just say "I need a bot to do X on this website". Also use when the user wants to interact with the control service API, set up the Chrome extension, or configure the credential store. Do NOT use this for low-level agent-browser CLI commands (agent-browser open/click/fill etc.) — those are handled by the agent-browser skill. This skill covers the product-layer auto-browser CLI and its full ecosystem.
allowed-tools: Bash(agent-browser:*), Bash(auto-browser:*), Bash(cp:*), Bash(mkdir:*), Bash(echo:*)
---

# Auto Browser

Auto Browser is a product-layer browser automation system. It wraps the low-level `agent-browser` kernel with a dual-LLM architecture (planner model drafts plans, executor model takes per-step actions), a control service, CLI, HTTP/SSE API, TUI, Chrome extension, Electron desktop, and a Next.js web app.

## Quick Start

```bash
# Start the control service
auto-browser serve --port 4317

# Submit a task and approve it immediately
auto-browser run --goal "open example.com and tell me the title" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash

# Submit with TUI live watch mode
auto-browser run --goal "search for weather in Tokyo" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --tui

# Two-step: submit then approve
auto-browser submit --goal "log into github and check notifications" \
  --planner-model deepseek-v4-pro
auto-browser approve --task-id <task-id> --executor-model deepseek-v4-flash
```

## CLI Reference

### Commands

| Command | Description |
|---------|-------------|
| `serve` | Start the local control service |
| `state` | Show service state (conversations, tasks, active task) |
| `submit` | Submit a goal → planner drafts plan → status: `draft` |
| `run` | Submit + immediately approve in one step |
| `approve` | Approve a drafted task → executes with executor model |
| `handoff` | Enter handoff mode for human intervention |
| `resume` | Replan and resume a handed-off task |
| `completion` | Print shell completion script (bash/zsh) |

### Common Options

| Option | Description |
|--------|-------------|
| `--port <n>` | Control service port (default: 4317) |
| `--planner-model <id>` | Model for plan drafting/replanning |
| `--executor-model <id>` | Model for per-step action decisions |
| `--model-tier <tier>` | Preset: `standard`, `premium`, `economy` |
| `--router-base-url <url>` | LLM router URL (default: http://127.0.0.1:18000) |
| `--router-api-key <key>` | LLM router API key |
| `--json` | Output as JSON |
| `--goal "<text>"` | Task goal (also accepts positional arg) |
| `--context "<text>"` | Extra context for the LLM |
| `--conversation-id <id>` | Reuse existing conversation |
| `--task-id <id>` | Target task for approve/handoff/resume |
| `--tui` | Interactive TUI watch mode |
| `--headless` / `--headed` | Force browser mode |
| `--browser-family <type>` | chrome, chromium, edge |
| `--executable-path <path>` | Custom browser executable |
| `--profile-path <path>` | Browser profile path |
| `--cookies-path <path>` | Cookies persistence path |
| `--credentials-path <path>` | Credentials JSON path |
| `--extension-enabled` / `--no-extension-enabled` | Toggle extension |
| `--preview-enabled` / `--no-preview-enabled` | Toggle preview |

### Model Tiers

| Tier | Planner | Executor |
|------|---------|----------|
| `standard` | deepseek-v4-pro | deepseek-v4-flash |
| `premium` | deepseek-v4-pro | deepseek-v4-pro |
| `economy` | deepseek-v4-flash | deepseek-v4-flash |

Override individual models via `--planner-model` / `--executor-model` or env vars.

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Usage error |
| 3 | Configuration error (missing/invalid model) |
| 4 | Control service startup failure |
| 5 | API request failure |

### Shell Completion

```bash
auto-browser completion bash > ~/.local/share/bash-completion/completions/auto-browser
auto-browser completion zsh > ~/.zfunc/_auto-browser
```

## Architecture

```
User Interfaces → CLI / TUI / Electron / Chrome Extension / Next.js App

Control Layer  → HTTP/SSE Server (port 4317)
               → InMemoryControlService
               → Task lifecycle: draft → ready → running → completed|handoff|failed

Execution      → AgentLoopExecutionDriver (LLM observe-decide-act, 20 iterations max)
               → BrowserExecutionDriver (simple search)
               → Extension execution (background.js loop)

LLM            → LlmRouterClient → external router at 127.0.0.1:18000
               → LlmPlanner (plan drafting + replanning)
               → LlmExecutorDecider (per-step action decisions)

Browser        → ManagedBrowser (Playwright Chromium, auto-downloaded)
               → System mode (local Chrome at configured path)
               → Auto mode: system Chrome preferred, falls back to managed
```

### Task Lifecycle

1. **Submit** → planner drafts a plan → status: `draft`
2. **Approve** → status: `ready` → `running`
3. **Execute** → observe-decide-act loop (max 20 iterations):
   - Observer captures page snapshot, refs, visible text
   - Credential auto-fill (early iterations, from `~/.auto-browser/credentials.json`)
   - Cloudflare bypass (human-like mouse, turnstile, verify clicks, 60s wait)
   - CAPTCHA solving (reCAPTCHA v2 token injection, image captcha solver)
   - LLM decides next action: navigate/click_ref/click_point/fill_ref/press_key/scroll/wait_for/finish/handoff
   - Action applied via Playwright
   - Visual observations triggered for canvas-heavy pages
   - Cookie persistence: load at start, save on completion
4. **Complete** or **Handoff** — result summary or human intervention

## HTTP API

The control service runs at `http://127.0.0.1:<port>` with CORS enabled.

### REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | Full state (conversations, tasks, active task, events) |
| GET | `/api/events` | SSE stream of TaskEvent objects |
| GET | `/api/browser-runtime/defaults` | Detected browser runtime defaults |
| GET | `/api/runtime-config` | Planner/executor config status |
| POST | `/api/conversations` | Create a conversation |
| PATCH | `/api/conversations/:id` | Update conversation title |
| DELETE | `/api/conversations/:id` | Delete conversation (blocks if active task) |
| POST | `/api/conversations/:id/messages` | Submit goal → returns drafted task |
| POST | `/api/tasks/:id/approve` | Approve task (blocking) |
| POST | `/api/tasks/:id/run` | Run task (non-blocking, streams via SSE) |
| POST | `/api/tasks/:id/approve-extension` | Mark task as extension-executable |
| POST | `/api/tasks/:id/decide` | Extension: request next action from LLM |
| POST | `/api/tasks/:id/report` | Extension: report execution progress |
| POST | `/api/tasks/:id/handoff` | Request human handoff |
| POST | `/api/tasks/:id/resume` | Replan and resume a handed-off task |
| POST | `/api/tasks/:id/cancel` | Cancel a running task |
| POST | `/api/force-clear-active` | Force-clear the active task lock |

### SSE Event Types

Connect to `GET /api/events`. Events are `data: {json}\n\n` formatted:

- `conversation.created` — new conversation
- `task.drafted` — plan drafted after goal submission
- `task.ready` — task approved with executor model
- `task.running` — execution loop started
- `task.execution.iteration.started` — each iteration (includes URL, title)
- `task.execution.llm.completion` — after LLM decide call (raw content, tokens)
- `task.execution.iteration.completed` — after action applied
- `task.execution.action_started` / `action_completed` — extension progress
- `task.execution.blocked` — extension blocked (e.g., missing site permission)
- `task.completed` — finished successfully
- `task.failed` — execution error
- `task.handoff` — human intervention needed
- `task.cancelled` — task cancelled
- `task.replanned` — task was replanned (on resume)

### Example: Programmatic Task Execution

```bash
# 1. Create conversation
curl -X POST http://127.0.0.1:4317/api/conversations
# → {"id": "conv-abc", ...}

# 2. Submit goal
curl -X POST http://127.0.0.1:4317/api/conversations/conv-abc/messages \
  -H 'content-type: application/json' \
  -d '{"content": "find the pricing page and summarize plans", "browserConfig": {"launchMode": "headless"}, "plannerModel": "deepseek-v4-pro"}'

# 3. Approve and execute
curl -X POST http://127.0.0.1:4317/api/tasks/<task-id>/approve \
  -H 'content-type: application/json' \
  -d '{"executorModel": "deepseek-v4-flash"}'

# 4. Stream events
curl -N http://127.0.0.1:4317/api/events
```

## Browser Configuration

### Browser Modes

| Mode | Description |
|------|-------------|
| `managed` | Playwright Chromium (auto-downloaded on first run) |
| `system` | Local Chrome at `AUTO_BROWSER_EXECUTABLE_PATH` |

### Launch Modes

| Mode | Description |
|------|-------------|
| `auto` | Let the system decide based on environment |
| `headless` | No visible browser window (default for managed runs) |
| `headed` | Show browser window (useful for debugging) |

### Cookie Persistence

Cookies are loaded from the configured path at task start and saved on completion. Use `--cookies-path` or `AUTO_BROWSER_COOKIES_PATH` to set.

## Credential Store

Credentials are stored at `~/.auto-browser/credentials.json` (permissions `0600`):

```json
{
  "sites": {
    "example.com": { "username": "user@example.com", "password": "secret123" },
    "github.com": { "username": "myuser", "password": "ghp_token" }
  }
}
```

Auto-fill triggers on early execution iterations when login forms are detected. Matching supports subdomain-to-domain fallback. Use `--credentials-path` to override.

## CAPTCHA & Anti-Detection Strategy

**诚实评估**：auto-browser 的内置反检测能力很有限。对于淘宝、虾皮(Shopee)这类强风控平台，不要指望全自动通过验证码。下面按可靠度从高到低说明实际可行的方案。

### Tier 1: Cookie Reuse（唯一可靠的全自动方案）

这是唯一能稳定绕过所有验证码的方式：用真实浏览器完成一次登录，保存认证会话，后续任务直接复用。

```bash
# Step 1: 用真实浏览器完成首次登录（你需要手动处理验证码）
auto-browser run --goal "登录淘宝并访问消息页面" \
  --headed \
  --cookies-path ./taobao-cookies.json

# Step 2: 后续任务全自动执行，无需登录，无验证码
auto-browser run --goal "查看淘宝消息中心的最新消息" \
  --cookies-path ./taobao-cookies.json
```

**原理**：Cookies 在任务开始时自动加载（`cookie-manager.ts` → Playwright `context.addCookies()`），完成时自动保存（含 finally 保底，失败也不会丢）。这是 Playwright 原生机制，工作稳定。

**最佳实践**：不要用 auto-browser 做首次登录。用你自己的真实 Chrome 浏览器登录网站，然后用 EditThisCookie 扩展导出 cookies.json，再用项目自带的工具转换：
```bash
npx tsx src/auto-browser/cookie-manager.ts import ./edit-this-cookie-export.json -o ./taobao-cookies.json
```

**Cookie 有效期**：淘宝约 1-7 天，虾皮约 1-7 天，过期后需要重新导出。

### Tier 2: Handoff Mode（半自动 — AI 填表，人处理验证码）

当 Cookie 过期或首次运行需要登录时使用。AI 自动填写凭据，卡在验证码时暂停任务，你处理完验证码后恢复。

**重要：当前 handoff 的浏览器关闭行为**。执行循环遇到无法处理的验证码时（Cloudflare 超时、LLM 决定 handoff），会在 `finally` 块中保存 cookie 后**关闭浏览器**（`control-service.ts` 第 1091-1093 行）。所以 handoff 不能让你在打开的浏览器页面上"直接过个滑块就继续"。

实际可行的流程：

```bash
# 方案 A：Handoff → 外部登录 → 导出 cookie → resume（推荐）
auto-browser run --goal "登录淘宝查看消息" \
  --credentials-path ./taobao-creds.json \
  --cookies-path ./taobao-cookies.json \
  --tui

# → AI 填账号密码 → 卡在验证码 → handoff
# → 你用真实 Chrome 手动登录淘宝（过滑块/短信）
# → 用 EditThisCookie 导出新 cookies → cookie-manager.ts import
# → resume 加载新 cookies，已登录状态：
auto-browser resume --task-id <task-id> --planner-model deepseek-v4-pro
```

```bash
# 方案 B：Handoff → headed 模式观察 → 手动操作浏览器后 resume
auto-browser run --goal "登录 1688 并搜索商品" \
  --credentials-path ./1688-creds.json \
  --cookies-path ./1688-cookies.json \
  --headed \
  --tui

# → AI 导航到登录页 → 填好账号密码 → 卡在滑块 → handoff
# → 浏览器关闭前你可以看到最后一屏状态
# → 手动打开浏览器完成登录
# → resume
```

**凭据自动填充的限制**（`credential-store.ts` + `control-service.ts`）：
- 只在执行循环的第 0-1 轮触发，延迟出现的登录表单不会填充
- 只支持简单的用户名+密码表单，OAuth/SSO/多步登录/2FA 不支持
- 依赖 Playwright snapshot refs 检测表单，iframe/Shadow DOM 可能漏检
- 填完后如果没有检测到 submit 按钮，需要靠 LLM 自己决定怎么提交

**Handoff 触发的条件**（`control-service.ts` 第 1009-1044 行）：
- LLM 返回 `action: 'handoff'`（AI 自己觉得搞不定）
- Cloudflare 交互 60s 超时（`detectCloudflareChallenge` 全部重试用完）
- LLM 决定 `action: 'finish'` 但 observer 判断登录还没成功（`humanInterventionReason`）
- canvas 为主的页面需要视觉能力但不可用
- 迭代次数超过 20 次上限

### Tier 3: Fully Automatic（能力有限，不要依赖）

auto-browser 内置的自动化解验证码能力覆盖范围很窄：

| 类型 | 支持情况 | 说明 |
|------|----------|------|
| **Cloudflare Turnstile** (checkbox) | ⚠️ 有限支持 | 检测 `challenges.cloudflare.com`，模拟鼠标轨迹+找 iframe checkbox 点击+点 verify/continue 按钮，60s 超时后 handoff。仅限**复选框级别**，交互式拼图不支持 |
| **Cloudflare JS 计算挑战** | ❌ 不支持 | 没有 JS 执行引擎来解题 |
| **reCAPTCHA v2** | ⚠️ 需配置 | 设置 `AUTO_BROWSER_CAPTCHA_API_KEY`（2captcha 服务），自动提取 siteKey，提交到人工打码平台，注入 token。需要付费 |
| **reCAPTCHA v3 / hCaptcha** | ❌ 不支持 | 虽然 hcaptcha 在检测关键词列表里，但没有 solver 逻辑 |
| **图片验证码 OCR** | ⚠️ 脆弱 | 通过 2captcha，实现依赖页面 visibleText 正则提取，成功率低 |
| **淘宝阿里滑块** | ❌ 不支持 | 不是标准 reCAPTCHA/hCaptcha，无任何 solver |
| **腾讯滑块/点选** | ❌ 不支持 | 同上 |
| **设备指纹检测** | ❌ **未做任何对抗** | Playwright 启动时**未设置任何反检测参数**：没有 `--disable-blink-features=AutomationControlled`，没有 navigator.webdriver 覆盖，没有 WebGL/Canvas 指纹伪造。浏览器会被淘宝/虾皮秒识破 |
| **IP 轮换** | ❌ 不支持 | 仅支持静态代理（`AGENT_BROWSER_PROXY`），无 IP 池、无自动轮换、无故障切换 |

自动化解验证码的**检测机制**（`captcha-solver.ts`）通过关键词扫描页面文本：`captcha`、`recaptcha`、`hcaptcha`、`verify you are human`、`验证码`、`人机验证`、`图形验证码`、`安全验证`。Cloudflare 检测（`control-service.ts`）检查：`checking your browser`、`just a moment`、`challenges.cloudflare.com` 等。

### 针对电商平台的实际方案

| 场景 | 推荐方案 | 人工参与 |
|------|----------|----------|
| 日常定时消息收集 | **真实 Chrome 导出 cookie → `--cookies-path` 复用** | 只需首次手动登录 |
| Cookie 过期后的续期 | 重复 Tier 1 的导出流程，或使用 Handoff | 需要手动过验证码 |
| 首次从零开始 | Handoff：AI 填表 → 人过验证码 → resume | 需要参与验证码步骤 |
| 全自动突破验证码 | **目前不支持**，不要抱期望 | - |

**核心建议**：对于淘宝/虾皮这类强风控站点，auto-browser 的价值在于**登录后的自动化操作**（消息收集、订单查询、页面数据提取），而不是在于突破验证码。认证部分用真实浏览器完成，操作部分交给 auto-browser。

## Extension Mode

The Chrome extension provides an independent execution path that runs inside the actual browser page (no Playwright).

### Setup

1. Start the control service: `auto-browser serve`
2. Open `chrome://extensions`, enable Developer mode, load `extension/` unpacked
3. Open the sidepanel from the toolbar action

### Flow

1. Enter goal in sidepanel → optionally set start URL + model IDs
2. Start execution → dedicated tab created, task approved as `extension` source
3. Extension observes page → sends `{ observation, history }` to `POST /api/tasks/:id/decide`
4. Receives action → executes in-page (DOM only, no system mouse)
5. Reports progress via `POST /api/tasks/:id/report`
6. Visual overlay: virtual cursor, target highlight, click pulse, status

### Extension Actions

`navigate`, `click_ref`, `fill_ref` (redacted via `textPreview`), `press_key`, `scroll`, `wait_for`

### Sidepanel

Chat-style operator console: create tasks, grant site access, view timeline with action-started/completed/blocked events. Sources state from `/api/state` and `/api/events`.

## TUI Watch Mode

```bash
auto-browser run --goal "..." --tui
```

Blocks until completion, renders a live terminal UI:
- **Header**: task ID, status badge, elapsed time
- **PlanSteps**: ✓/▶/○ markers for each step
- **StatusBar**: current iteration, URL, page title
- **ActionHistory**: last 8 actions table
- **LlmDetails**: raw LLM completion + token counts
- **Footer**: keyboard shortcuts
- **Keyboard**: `q`/`Esc` = quit, `c` = cancel, `r` = re-run
- **Reconnection**: up to 3 retries with "Reconnecting..." indicator

## Desktop Shell

An Electron desktop app at `desktop/` provides a ChatGPT-style interface:

```bash
npm run dev:desktop-preview    # Static preview (no Electron)
```

For full Electron: `cd desktop && npm start` (requires Electron installed).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_BROWSER_CONTROL_PORT` | `4317` | Control service port |
| `AUTO_BROWSER_LLM_ROUTER_BASE_URL` | `http://127.0.0.1:18000` | LLM router URL |
| `AUTO_BROWSER_LLM_ROUTER_API_KEY` | `""` | LLM router API key |
| `AUTO_BROWSER_PLANNER_MODEL` | `deepseek-v4-pro` | Default planner model |
| `AUTO_BROWSER_EXECUTOR_MODEL` | `deepseek-v4-flash` | Default executor model |
| `AUTO_BROWSER_MODEL_TIER` | `""` | Model tier preset |
| `AUTO_BROWSER_EXECUTABLE_PATH` | `""` | Local Chrome path (system mode) |
| `AUTO_BROWSER_EXECUTION_TIMEOUT_MS` | `120000` | Max execution time |
| `AGENT_BROWSER_PROXY` | `""` | Proxy for browser traffic |
| `AGENT_BROWSER_PROXY_BYPASS` | `""` | Proxy bypass hosts |

## Next.js Web App (app/)

The `app/` sub-project is a separate Next.js app for resource collection:

```bash
cd app && npm run dev       # Start dev server
cd app && npm run crawl     # Run resource crawler
```

Features: SQLite storage, Playwright crawler with login + QR code support, WebSocket screencast, flow recording/replay.

## Common Workflows

### Submit → Review → Approve

```bash
# Submit a goal to see the plan before approving
auto-browser submit --goal "fill out this contact form and submit" \
  --planner-model deepseek-v4-pro

# Review the plan output, then approve
auto-browser approve --task-id <task-id> \
  --executor-model deepseek-v4-flash
```

### One-Step Run with TUI

```bash
auto-browser run --goal "scrape product prices from example.com" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --tui
```

### Handoff and Resume

```bash
# When a task needs human help (auth, CAPTCHA, unsupported browser)
auto-browser handoff --task-id <task-id>

# After manual intervention, resume with replan
auto-browser resume --task-id <task-id> --planner-model deepseek-v4-pro
```

### Headless High-Volume Scraping

```bash
auto-browser run --goal "extract all article titles and URLs from the blog" \
  --headless \
  --planner-model deepseek-v4-flash \
  --executor-model deepseek-v4-flash
```

### Using Saved Browser Profile

```bash
auto-browser run --goal "check my gmail inbox" \
  --profile-path /path/to/chrome-profile \
  --headed
```

## Development Commands

```bash
npm run build                     # TypeScript compile
npm run dev:control-service       # Start control service (tsx watch, port 4317)
npm test                          # Run tests (vitest)
npm run typecheck                 # TypeScript type check
npx vitest run src/auto-browser/cli.test.ts  # Single test file
```

## Executor Actions

The agent loop decides between these actions:

| Action | Description |
|--------|-------------|
| `navigate` | Go to a URL |
| `click_ref` | Click element by snapshot ref |
| `click_point` | Click at viewport coordinates (canvas fallback) |
| `fill_ref` | Type text into a field |
| `press_key` | Keyboard press |
| `scroll` | Scroll up/down |
| `wait_for` | Wait for text or timeout |
| `finish` | Mark task complete |
| `handoff` | Request human intervention |

## Detecting Available Models

```bash
# Check which models are configured
curl http://127.0.0.1:4317/api/runtime-config

# The CLI validates models against the router at startup
# If a model isn't available, it auto-suggests alternatives
```
