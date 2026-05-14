# CLI Commands for Auto-Browser Login + Dashboard Workflow

## Step 1: Start the Control Service

In one terminal, start the control service (it must run for the duration of your automation):

```bash
auto-browser serve --port 4317
```

Or if you prefer to keep it in the foreground visible:

```bash
cd /home/rczx/workspace/rinbarpen/projects/auto-browser
npm run dev:control-service
```

## Step 2: Set Up Credentials (One-Time)

Create or edit `~/.auto-browser/credentials.json` with your site credentials:

```bash
mkdir -p ~/.auto-browser
cat > ~/.auto-browser/credentials.json << 'CREF'
{
  "sites": {
    "example.com": {
      "username": "your-email@example.com",
      "password": "your-password"
    }
  }
}
CREF
chmod 600 ~/.auto-browser/credentials.json
```

**Important:** The file must have `0600` permissions for security. The auto-browser will auto-detect login forms and fill credentials matching by hostname.

## Step 3: Run the Automation Task

### Option A: One-Step Run (Simplest — Submit + Approve in One Command)

```bash
auto-browser run \
  --goal "Navigate to https://example.com/login, log in with saved credentials, then go to the dashboard and summarize what you see" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash
```

### Option B: One-Step Run with TUI Watch Mode (Recommended — See Live Progress)

```bash
auto-browser run \
  --goal "Navigate to https://example.com/login, log in with saved credentials, then go to the dashboard and summarize what you see" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --tui
```

### Option C: One-Step Run with JSON Output (For Scripting)

```bash
auto-browser run \
  --goal "Navigate to https://example.com/login, log in with saved credentials, then go to the dashboard and summarize what you see" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --json
```

### Option D: Headless Mode (No Visible Browser Window)

```bash
auto-browser run \
  --goal "Navigate to https://example.com/login, log in with saved credentials, then go to the dashboard and summarize what you see" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --headless
```

### Option E: Headed Mode with Custom Cookies Path (For Cookie Persistence)

```bash
# First time: use headed so you can manually handle any CAPTCHA
auto-browser run \
  --goal "Log into example.com and visit the dashboard" \
  --headed \
  --cookies-path ~/.auto-browser/example-cookies.json

# Subsequent runs: reuse cookies, can be headless
auto-browser run \
  --goal "Check my example.com dashboard for new notifications" \
  --cookies-path ~/.auto-browser/example-cookies.json \
  --headless
```

## Step 4 (Alternative): Two-Step Submit + Review + Approve

If you want to review the plan before execution:

```bash
# Submit the goal (planner drafts a plan)
auto-browser submit \
  --goal "Navigate to https://example.com/login, log in, then check the dashboard" \
  --planner-model deepseek-v4-pro \
  --json

# Review the plan output, note the task-id, then approve
auto-browser approve \
  --task-id <task-id-from-above> \
  --executor-model deepseek-v4-flash \
  --tui
```

## Step 5: Monitor State

Check the current state of the control service:

```bash
auto-browser state --json
```

Or directly via the API:

```bash
curl -s http://127.0.0.1:4317/api/state | python3 -m json.tool
```

## Step 6: If Handoff Occurs (CAPTCHA or Human Intervention Needed)

```bash
# After manually completing the CAPTCHA/verification in the browser:
auto-browser resume --task-id <task-id> --planner-model deepseek-v4-pro
```

## Step 7: Cancel a Running Task If Needed

```bash
auto-browser submit --goal "cancel" --task-id <task-id>
# Or via API:
curl -X POST http://127.0.0.1:4317/api/tasks/<task-id>/cancel
```

## Using Programmatic API (curl) Instead of CLI

```bash
# 1. Create conversation
curl -s -X POST http://127.0.0.1:4317/api/conversations

# 2. Submit goal
curl -s -X POST http://127.0.0.1:4317/api/conversations/<conv-id>/messages \
  -H 'content-type: application/json' \
  -d '{"content": "Log into example.com and check the dashboard", "plannerModel": "deepseek-v4-pro"}'

# 3. Approve and execute
curl -s -X POST http://127.0.0.1:4317/api/tasks/<task-id>/approve \
  -H 'content-type: application/json' \
  -d '{"executorModel": "deepseek-v4-flash"}'

# 4. Stream events in real-time
curl -N http://127.0.0.1:4317/api/events
```

## Quick Reference: All CLI Options

| Option | Description |
|--------|-------------|
| `--port <n>` | Control service port (default: 4317) |
| `--planner-model <id>` | Model for plan drafting (default: deepseek-v4-pro) |
| `--executor-model <id>` | Model for per-step actions (default: deepseek-v4-flash) |
| `--model-tier <tier>` | Preset: standard/premium/economy |
| `--tui` | Interactive terminal UI watch mode |
| `--json` | Output as JSON (useful for scripting) |
| `--headless` | No visible browser window |
| `--headed` | Show browser window (for debugging) |
| `--cookies-path <path>` | Load/save cookies for session persistence |
| `--credentials-path <path>` | Custom credentials JSON path |
| `--browser-family <type>` | chrome, chromium, edge |
| `--executable-path <path>` | Custom browser executable path |
| `--profile-path <path>` | Browser profile directory |
| `--extension-enabled` | Enable Chrome extension execution |
| `--router-base-url <url>` | LLM router URL (default: http://127.0.0.1:18000) |
| `--router-api-key <key>` | LLM router API key |
| `--context "<text>"` | Extra context for the LLM to consider |
| `--conversation-id <id>` | Reuse an existing conversation |
