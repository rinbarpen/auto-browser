# Auto-Browser CLI Workflow: Login and Dashboard Automation Guide

## Overview

Auto-Browser is a product-layer browser automation system with a dual-LLM architecture: a **planner model** drafts a multi-step plan from your goal, and an **executor model** drives each step through the browser via Playwright/Chromium. The CLI (`auto-browser`) is the primary way to submit and run automation tasks from the terminal.

### Key Architecture Points

- **Planner Model** (`--planner-model`): Drafts the execution plan from a natural-language goal
- **Executor Model** (`--executor-model`): Makes per-step decisions (click ref, fill field, scroll, etc.)
- **Control Service**: An HTTP/SSE server running on port 4317 by default that manages task state and LLM communication
- **LLM Router**: External LLM gateway at `127.0.0.1:18000` that proxies model requests

### Task Lifecycle

```
Submit goal --> draft (plan drafted) --> ready (approved) --> running (execute loop) --> completed | handoff | failed
```

The executor loop runs up to 20 iterations of observe-decide-act:
1. Observer captures page snapshot, refs, and visible text
2. LLM decides next action (navigate, click_ref, fill_ref, scroll, finish, handoff, etc.)
3. Action is applied to the page via Playwright

## Prerequisites

Before running any automation task, you need:

### 1. Working LLM Router

The LLM router must be running at `http://127.0.0.1:18000` (default). This is where the planner and executor models live. Verify it with:

```bash
curl http://127.0.0.1:18000/v1/models
```

### 2. Verified Models

The CLI validates model availability at startup. You can check your available models:

```bash
auto-browser state
```

The project has model tiers defined in `.model-tiers.json`:
- **max**: gpt-5.5 (planner + executor + vision)
- **standard**: gpt-5.5-nano (planner) + gpt-4o (executor)
- **economy**: deepseek-v4-pro (planner) + deepseek-v4-flash (executor)
- **free**: openrouter free models

### 3. Browser

Auto-browser works in two modes:
- **managed** (default): Downloads Playwright Chromium on first run. No Chrome installation needed.
- **system**: Uses your locally installed Google Chrome, Chromium, or Edge.

If you have Chrome installed, use system mode for better compatibility with logged-in sessions:

```bash
# Check what browsers are detected
auto-browser state
```

## Step 1: Set Up Credentials

Auto-browser can **auto-fill login forms** if you configure credentials for the target website. It detects username/password fields using Chinese and English keywords and matches credentials by hostname.

Create or edit `~/.auto-browser/credentials.json`:

```json
{
  "sites": {
    "example.com": {
      "username": "your-email@example.com",
      "password": "your-password"
    },
    "app.myservice.com": {
      "username": "myuser",
      "password": "mypassword"
    }
  }
}
```

The file permissions should be `0600` (owner read/write only):

```bash
chmod 600 ~/.auto-browser/credentials.json
```

**Hostname matching rules**:
- Exact match: `example.com` matches `https://example.com/login`
- Subdomain-to-domain suffix match: `app.example.com` falls back to `example.com` if no exact match
- `www.` prefix is stripped before matching
- Bidirectional matching: `login.example.com` matches `example.com` and vice versa

You can also specify a custom credentials path per task with `--credentials-path`.

## Step 2: Start the Control Service

The control service is the backend that manages tasks, browser instances, and LLM communication. You can either:

### Option A: Let the CLI auto-start it

The CLI will auto-spawn the control service when you run any command (submit, run, approve, state). It waits up to 8 seconds for the service to become ready. No manual step needed if you are running a single workflow.

### Option B: Start it manually (recommended for repeated use)

```bash
auto-browser serve --port 4317
```

or with explicit models:

```bash
auto-browser serve \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --port 4317
```

or via the npm script:

```bash
npm run dev:control-service
```

Check the service is healthy:

```bash
curl http://127.0.0.1:4317/api/state
```

## Step 3: Run Your Automation Task

There are two main approaches:

### Approach A: One-shot `run` command (simplest)

The `run` command submits a goal AND immediately approves and executes it in a single step:

```bash
auto-browser run --goal "navigate to https://example.com/login, log in with saved credentials, and check the dashboard"
```

This:
1. Creates a conversation
2. Submits the goal and drafts a plan
3. Approves the plan and begins execution
4. Returns the final result (blocking, waits until completion)

### Approach B: Two-step submit + approve (more control)

```bash
# Step 1: Submit goal, get a drafted plan
auto-browser submit --goal "log into example.com and check dashboard" --json

# Review the plan, then approve:
auto-browser approve --task-id <task-id-from-submit>
```

This is useful when you want to review the plan steps before execution begins.

### Using TUI Watch Mode (real-time progress)

Add `--tui` to the `run` command for a live terminal dashboard:

```bash
auto-browser run \
  --goal "open example.com, log in, and check dashboard" \
  --tui
```

The TUI shows:
- Task ID and status badge
- Plan steps with completion markers
- Status bar (iteration, URL, page title)
- Action history (last 8 actions in a table)
- LLM details (raw completion + token counts)
- Keyboard shortcuts: `q`/`Esc` to quit, `c` to cancel, `r` to re-run

### Full Command with All Relevant Options

```bash
auto-browser run \
  --goal "navigate to https://app.example.com/login, sign in, and check the dashboard" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --model-tier economy \
  --executable-path "/usr/bin/google-chrome-stable" \
  --profile-path "$HOME/.cache/auto-browser/profiles/my-profile" \
  --cookies-path "$HOME/.auto-browser/cookies.json" \
  --credentials-path "$HOME/.auto-browser/credentials.json" \
  --headed \
  --tui
```

## Step 4: Cookie Persistence (Stay Logged In)

Auto-browser supports cookie persistence to avoid re-logging in on every task:

```bash
# Save cookies after login in one task, reuse in subsequent tasks
auto-browser run \
  --goal "log into example.com" \
  --cookies-path "./my-cookies.json"

# Reuse the saved cookies
auto-browser run \
  --goal "check my example.com dashboard" \
  --cookies-path "./my-cookies.json"
```

The project already has a `cookies.json` at the project root (190KB) which you can reference.

## Credential Auto-Fill Behavior

During execution, the system automatically:
1. Detects login forms by scanning page snapshot refs for username/email/phone fields and password fields (Chinese and English keywords)
2. Matches credentials from `~/.auto-browser/credentials.json` by hostname
3. Auto-fills the detected fields on early iterations
4. If no explicit username field matches, falls back to the first non-password textbox

## Cloudflare / CAPTCHA Handling

The executor includes built-in handling for:
- **Cloudflare challenges**: Waits up to 60s with human-like mouse movements, turnstile checkbox clicking in iframes, verify/continue button clicking
- **reCAPTCHA v2**: Attempts token injection by extracting the `grecaptcha` site key

## API Endpoints You Can Use Directly

If you prefer `curl` over the CLI:

```bash
# Create conversation
curl -s -X POST http://127.0.0.1:4317/api/conversations | jq

# Submit goal
curl -s -X POST http://127.0.0.1:4317/api/conversations/<conv-id>/messages \
  -H "content-type: application/json" \
  -d '{"content":"log into example.com and check dashboard", "plannerModel":"deepseek-v4-pro"}' | jq

# Approve and run (blocking)
curl -s -X POST http://127.0.0.1:4317/api/tasks/<task-id>/approve \
  -H "content-type: application/json" \
  -d '{"executorModel":"deepseek-v4-flash"}' | jq

# Run non-blocking
curl -s -X POST http://127.0.0.1:4317/api/tasks/<task-id>/run \
  -H "content-type: application/json" \
  -d '{"executorModel":"deepseek-v4-flash"}' | jq

# Stream events (SSE)
curl -N http://127.0.0.1:4317/api/events

# View state
curl -s http://127.0.0.1:4317/api/state | jq
```

## Common Troubleshooting

### "Planner model is required"
Pass `--planner-model <id>` or set `AUTO_BROWSER_PLANNER_MODEL` env var.

### "Executor model is required"
Pass `--executor-model <id>` or set `AUTO_BROWSER_EXECUTOR_MODEL` env var. Required for `run` and `approve` commands.

### "model is not available in the configured LLM router"
The model name must match exactly what the LLM router provides. Check available models with `curl http://127.0.0.1:18000/v1/models` and ensure your `--planner-model` and `--executor-model` values are exact matches.

### "Timed out waiting for control service"
The control service didn't start in time. Try:
1. Start it manually: `auto-browser serve &`
2. Check if port 4317 is in use: `lsof -i :4317`
3. Build the project first: `npm run build`

### "Control service entrypoint not found"
Run `npm run build` first -- the compiled `dist/auto-browser/server.js` is missing.

### Task gets stuck on login
Make sure:
1. `~/.auto-browser/credentials.json` exists with the correct hostname (matching rules above)
2. Or pass `--credentials-path` with the correct path
3. The credentials file has 0600 permissions
4. The username/password are correct for the site

### Browser opens headless by default
Use `--headed` to see the browser window. Without this flag, the browser runs headless.

## Environment Variables Summary

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_BROWSER_CONTROL_PORT` | 4317 | Control service port |
| `AUTO_BROWSER_LLM_ROUTER_BASE_URL` | http://127.0.0.1:18000 | LLM router URL |
| `AUTO_BROWSER_LLM_ROUTER_API_KEY` | (empty) | LLM router API key |
| `AUTO_BROWSER_PLANNER_MODEL` | deepseek-v4-pro | Default planner model |
| `AUTO_BROWSER_EXECUTOR_MODEL` | deepseek-v4-flash | Default executor model |
| `AUTO_BROWSER_VISION_MODEL` | (empty) | Vision-capable model for screenshots |
| `AUTO_BROWSER_EXECUTABLE_PATH` | (auto-detect) | Path to Chrome/Chromium binary |
| `AUTO_BROWSER_EXECUTION_TIMEOUT_MS` | 120000 | Max execution time (2 min) |
| `AGENT_BROWSER_PROXY` | (empty) | Proxy for browser traffic |
| `AGENT_BROWSER_PROXY_BYPASS` | (empty) | Proxy bypass hosts |

## CLI Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Usage error (wrong arguments) |
| 3 | Configuration error (missing model, invalid model) |
| 4 | Control service startup failure |
| 5 | API request failure |
