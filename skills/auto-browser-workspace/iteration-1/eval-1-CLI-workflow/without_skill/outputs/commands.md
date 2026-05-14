# Auto-Browser CLI Command Examples

## Setup Commands

### 1. Create credentials file for auto-fill login

```bash
mkdir -p ~/.auto-browser
cat > ~/.auto-browser/credentials.json << 'EOF'
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
EOF
chmod 600 ~/.auto-browser/credentials.json
```

### 2. Build the project (if dist/ is missing)

```bash
cd /home/rczx/workspace/rinbarpen/projects/auto-browser
npm run build
```

### 3. Check available models in the LLM router

```bash
curl -s http://127.0.0.1:18000/v1/models | jq
```

### 4. Start the control service manually

```bash
auto-browser serve \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --port 4317
```

### 5. Start control service with npm script (dev mode)

```bash
cd /home/rczx/workspace/rinbarpen/projects/auto-browser
npm run dev:control-service
```

### 6. Verify control service is healthy

```bash
curl -s http://127.0.0.1:4317/api/state | jq
```

### 7. Check detected browser runtime defaults

```bash
curl -s http://127.0.0.1:4317/api/browser-runtime/defaults | jq
```

### 8. Check runtime configuration (planner/executor models)

```bash
curl -s http://127.0.0.1:4317/api/runtime-config | jq
```

## Task Execution Commands

### 9. Simplest: run a task in one shot (managed Chromium, headless)

```bash
auto-browser run \
  --goal "open https://example.com and tell me the page title"
```

### 10. Login and check dashboard (with credential auto-fill)

```bash
auto-browser run \
  --goal "navigate to https://app.example.com/login, log in with saved credentials, and check the dashboard"
```

### 11. Submit first, review plan, then approve

```bash
# Step 1: Submit and review the drafted plan
auto-browser submit \
  --goal "log into github.com and check my notifications" \
  --json

# Step 2: Approve the task (replace with task ID from output)
auto-browser approve \
  --task-id "task_abc123" \
  --executor-model deepseek-v4-flash
```

### 12. Run with TUI live watch mode

```bash
auto-browser run \
  --goal "open example.com, log in, and extract the dashboard summary" \
  --tui
```

### 13. Full command: system Chrome, persisted cookies, credentials, headed mode, TUI

```bash
auto-browser run \
  --goal "log into https://mail.google.com and check my inbox" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash \
  --executable-path "/usr/bin/google-chrome-stable" \
  --profile-path "$HOME/.cache/auto-browser/profiles/chrome-profile" \
  --cookies-path "/home/rczx/workspace/rinbarpen/projects/auto-browser/cookies.json" \
  --credentials-path "$HOME/.auto-browser/credentials.json" \
  --headed \
  --tui
```

### 14. Economy tier using model-tier flag (uses deepseek-v4-pro + deepseek-v4-flash)

```bash
auto-browser run \
  --goal "log into app.example.com and check dashboard" \
  --model-tier economy
```

### 15. Standard tier using model-tier flag

```bash
auto-browser run \
  --goal "log into app.example.com and check dashboard" \
  --model-tier standard
```

### 16. Persist cookies from a login session for reuse

```bash
# First run: log in and save cookies
auto-browser run \
  --goal "navigate to https://example.com/login and log in" \
  --cookies-path "./my-saved-cookies.json"

# Subsequent runs: reuse saved cookies
auto-browser run \
  --goal "check my example.com dashboard" \
  --cookies-path "./my-saved-cookies.json"
```

### 17. Resume a handed-off task

```bash
auto-browser resume --task-id "task_abc123"
```

### 18. Cancel a running task

```bash
# Via CLI (TUI: press 'c' key)
curl -X POST http://127.0.0.1:4317/api/tasks/<task-id>/cancel \
  -H "content-type: application/json" \
  -d '{}'
```

### 19. Force-clear the active task lock

```bash
curl -X POST http://127.0.0.1:4317/api/force-clear-active
```

## API Commands (curl equivalents)

### 20. Create a new conversation

```bash
curl -s -X POST http://127.0.0.1:4317/api/conversations | jq
```

### 21. Submit a goal to a conversation (drafts a plan)

```bash
curl -s -X POST http://127.0.0.1:4317/api/conversations/<conv-id>/messages \
  -H "content-type: application/json" \
  -d '{
    "content": "log into example.com and check dashboard",
    "plannerModel": "deepseek-v4-pro",
    "browserConfig": {
      "mode": "managed",
      "browserFamily": "chromium",
      "launchMode": "headless"
    }
  }' | jq
```

### 22. Approve and run a task (blocking -- waits for completion)

```bash
curl -s -X POST http://127.0.0.1:4317/api/tasks/<task-id>/approve \
  -H "content-type: application/json" \
  -d '{
    "executorModel": "deepseek-v4-flash"
  }' | jq
```

### 23. Run a task (non-blocking -- returns immediately)

```bash
curl -s -X POST http://127.0.0.1:4317/api/tasks/<task-id>/run \
  -H "content-type: application/json" \
  -d '{
    "executorModel": "deepseek-v4-flash"
  }' | jq
```

### 24. Stream SSE events for real-time progress

```bash
curl -N -s http://127.0.0.1:4317/api/events
```

### 25. View full service state (JSON)

```bash
curl -s http://127.0.0.1:4317/api/state | jq
```

### 26. View service state (human-readable via CLI)

```bash
auto-browser state
```

### 27. Request human handoff for a task

```bash
auto-browser handoff --task-id "task_abc123" --source cli
```

## Environment Variable Examples

### 28. Run with all config set via environment variables

```bash
export AUTO_BROWSER_PLANNER_MODEL="deepseek-v4-pro"
export AUTO_BROWSER_EXECUTOR_MODEL="deepseek-v4-flash"
export AUTO_BROWSER_CONTROL_PORT="4317"
export AUTO_BROWSER_EXECUTABLE_PATH="/usr/bin/google-chrome-stable"
export AUTO_BROWSER_EXECUTION_TIMEOUT_MS="300000"

auto-browser run \
  --goal "log into app.example.com and check the dashboard" \
  --cookies-path "/home/rczx/workspace/rinbarpen/projects/auto-browser/cookies.json" \
  --headed \
  --tui
```

### 29. Use model tiers via environment variable

```bash
export AUTO_BROWSER_MODEL_TIER="economy"
auto-browser run --goal "check my dashboard on example.com"
```

## Reference: Full CLI Help

```bash
auto-browser help
```

Output:
```
auto-browser <command> [options]

Commands:
  serve                                  Start the local control service
  state [--json]                         Show control-service state
  submit --goal "<text>" [--json]        Submit a browser task draft
  run --goal "<text>" [--json] [--tui]  Submit a draft and immediately approve it
  approve --task-id <id> [--json]        Approve and run a drafted task
  handoff --task-id <id> [--source cli]  Enter handoff mode
  resume --task-id <id> [--json]         Resume a handed-off task
  completion <bash|zsh>                  Print a shell completion script

Common options:
  --port <n>
  --planner-model <id>
  --executor-model <id>
  --model-tier <tier>
  --router-base-url <url>
  --router-api-key <key>
  --json

Exit codes:
  0 success
  2 usage or unsupported arguments
  3 missing or invalid CLI configuration
  4 control service startup or readiness failure
  5 API request failure
```

## Shell Completion Setup

### Bash

```bash
eval "$(auto-browser completion bash)"
```

### Zsh

```bash
eval "$(auto-browser completion zsh)"
```

### Fish (equivalent)

```fish
auto-browser completion bash | source
```
