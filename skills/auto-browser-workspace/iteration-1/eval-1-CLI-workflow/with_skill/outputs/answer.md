# Setting Up and Running a Login + Dashboard Browser Automation with Auto-Browser CLI

## Overview

The auto-browser CLI lets you automate browser tasks using natural language goals. It uses a dual-LLM architecture: a **planner model** drafts a step-by-step plan, and an **executor model** decides each action (click, fill, scroll, navigate, etc.) during execution. The system includes built-in credential auto-fill, cookie persistence, Cloudflare/CAPTCHA bypass, and a live TUI watch mode.

To automate logging into a website and checking your dashboard, you follow this workflow:

1. Start the control service
2. Set up credentials for the target site
3. Run the task with the CLI
4. Monitor progress via TUI or JSON output
5. Handle any handoff (CAPTCHA) if needed

## Prerequisites

Your project at `/home/rczx/workspace/rinbarpen/projects/auto-browser` already has:

- **CLI binary built**: `dist/auto-browser/cli.js` is compiled and available as `auto-browser` or `npx auto-browser`
- **Credential store exists**: `~/.auto-browser/credentials.json` is already set up with example entries (weibo.com, example.com, zcool.com.cn)
- **Cookie store exists**: `~/.auto-browser/gmail-cookies.json` is present, showing cookie persistence already works

Before running, ensure two things are available:

1. **LLM Router**: The system sends LLM requests to `http://127.0.0.1:18000` by default. Ensure your LLM router is running. Configure via:
   - `--router-base-url` flag or `AUTO_BROWSER_LLM_ROUTER_BASE_URL` env var
   - `--router-api-key` flag or `AUTO_BROWSER_LLM_ROUTER_API_KEY` env var

2. **Browser**: Playwright Chromium auto-downloads on first use. Or point to a local Chrome with `--executable-path` or `AUTO_BROWSER_EXECUTABLE_PATH`.

## Step-by-Step Setup

### 1. Add Your Site Credentials

Edit `~/.auto-browser/credentials.json` and add an entry for your target website:

```json
{
  "sites": {
    "weibo.com": {
      "username": "test_user_001",
      "password": "test_pass_001"
    },
    "example.com": {
      "username": "demo@example.com",
      "password": "demo_pass_123"
    },
    "zcool.com.cn": {
      "username": "zcool_designer",
      "password": "zcool_pass_456"
    },
    "your-site.com": {
      "username": "your-username-or-email",
      "password": "your-password"
    }
  }
}
```

The credential store supports hostname matching (exact match, www-stripping, subdomain-to-domain suffix fallback). The auto-fill triggers on early execution iterations when login forms are detected, using Chinese and English keyword matching (username/email/phone, password, sign-in/login/submit buttons).

### 2. Start the Control Service

The control service is the central server that manages conversations, tasks, and the browser. Start it in a terminal:

```bash
auto-browser serve --port 4317
```

Alternative using the project's dev script:

```bash
cd /home/rczx/workspace/rinbarpen/projects/auto-browser
npm run dev:control-service
```

Keep this running. The service provides:
- REST API at `http://127.0.0.1:4317`
- SSE event stream at `GET /api/events`
- CORS support for extension/web app integration

### 3. Run the Automation Task

The simplest approach is the one-step `run` command, which submits the goal and immediately approves it:

```bash
auto-browser run \
  --goal "Navigate to https://example.com/login, log in with saved credentials, then go to the dashboard and summarize what you see" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --tui
```

**What happens:**
1. The planner model drafts a plan (e.g., navigate to login page, fill username, fill password, click login, navigate to dashboard, observe and summarize)
2. The task is immediately approved for execution
3. The AgentLoopExecutionDriver enters the observe-decide-act loop (max 20 iterations)
4. On early iterations, the observer captures page snapshot refs and detects login forms
5. Credentials are auto-filled from `~/.auto-browser/credentials.json` matched by hostname
6. The LLM executor decides per-step actions: `navigate`, `click_ref`, `fill_ref`, `scroll`, `finish`
7. The TUI shows live progress: plan steps, current URL/title, action history, LLM completions, token usage

**If you don't have model names configured**, use a model tier preset instead:

```bash
auto-browser run \
  --goal "Navigate to https://example.com/login, log in, then check the dashboard" \
  --model-tier standard \
  --tui
```

Model tiers map to:
- `standard`: planner=deepseek-v4-pro, executor=deepseek-v4-flash
- `premium`: planner=deepseek-v4-pro, executor=deepseek-v4-pro
- `economy`: planner=deepseek-v4-flash, executor=deepseek-v4-flash

### 4. Alternative: Two-Step Workflow (Submit Then Approve)

If you want to review the plan before execution:

```bash
# Step A: Submit (plans only, does not execute)
auto-browser submit \
  --goal "Log into example.com and check the dashboard" \
  --planner-model deepseek-v4-pro \
  --json

# Step B: After reviewing the plan, approve with the task-id from step A
auto-browser approve \
  --task-id <task-id> \
  --executor-model deepseek-v4-flash \
  --tui
```

## Cookie Persistence Strategy (Recommended for Repeated Use)

For sites you will visit repeatedly, use cookie persistence to bypass login entirely after the first run:

```bash
# First run: headed mode so you can manually handle any CAPTCHA
auto-browser run \
  --goal "Log into example.com and visit the dashboard" \
  --headed \
  --cookies-path ~/.auto-browser/example-cookies.json

# All subsequent runs: reuse saved cookies, can be headless
auto-browser run \
  --goal "Check my example.com dashboard for new notifications" \
  --cookies-path ~/.auto-browser/example-cookies.json \
  --headless
```

This is the **most reliable approach**. Cookies are loaded at task start and saved on completion, so authenticated sessions persist across runs. This bypasses ALL verification (login CAPTCHAs, sliders, SMS codes, device fingerprinting).

## Handling CAPTCHA and Handoff

The system has three layers of CAPTCHA handling:

1. **Best - Cookie Reuse**: If you've already logged in once and saved cookies, subsequent runs skip login entirely
2. **Fallback - Handoff Mode**: AI fills credentials automatically, then pauses for you to manually complete any CAPTCHA. Resume afterwards
3. **Last Resort - Automatic**: Built-in support for Cloudflare Turnstile (mouse movement simulation + 60s wait), reCAPTCHA v2 token injection, and image CAPTCHA solving

When a handoff occurs:

```bash
# The TUI shows "handoff" status with instructions
# Manually complete the CAPTCHA in the browser window
# Then resume:
auto-browser resume --task-id <task-id> --planner-model deepseek-v4-pro
```

## Using the TUI Watch Mode

The TUI (Terminal UI) is the recommended way to monitor execution:

```bash
auto-browser run --goal "..." --tui
```

The TUI displays:
- **Header**: Task ID, status badge (draft/running/completed/handoff/failed), elapsed time
- **PlanSteps**: Each step with checkmarks (completed), arrows (in progress), or circles (pending)
- **StatusBar**: Current iteration number, URL, page title
- **ActionHistory**: Last 8 actions with type, target, and text preview
- **LlmDetails**: Raw LLM completions and token counts (promptTokens, completionTokens, totalTokens)
- **Footer**: Keyboard shortcuts (`q`/`Esc` quit, `c` cancel task, `r` re-run)

## Checking State

Monitor the control service state at any time:

```bash
auto-browser state --json
```

This shows all conversations, tasks, active task, and recent events. Useful for debugging or checking status programmatically.

## Troubleshooting

### "Configuration error" (exit code 3)
Your planner or executor model is not recognized. Check available models:
```bash
curl http://127.0.0.1:4317/api/runtime-config
```

### "API request failure" (exit code 5)
The control service is not running or unreachable. Verify:
```bash
curl http://127.0.0.1:4317/api/state
```

### Login form not detected
The credential auto-fill uses keyword matching for login forms. If your site uses non-standard field names, add explicit instructions in the goal:
```bash
auto-browser run --goal "On the login page, fill the field labeled 'Account Number' with my credentials, then fill the 'Passcode' field, click 'Enter', then check the dashboard"
```

### Force-clear stuck active task
```bash
curl -X POST http://127.0.0.1:4317/api/force-clear-active
```
