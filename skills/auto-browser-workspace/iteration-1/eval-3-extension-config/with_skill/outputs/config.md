# Configuration Examples

## Credentials File

### Default location: `~/.auto-browser/credentials.json`

```json
{
  "sites": {
    "example.com": {
      "username": "user@example.com",
      "password": "your-password-here"
    },
    "github.com": {
      "username": "gh-username",
      "password": "ghp_your_personal_access_token"
    },
    "taobao.com": {
      "username": "13800138000",
      "password": "your-taobao-password"
    },
    "weibo.com": {
      "username": "myweibo",
      "password": "weibo-password"
    },
    "shopee.com": {
      "username": "my-shopee-user",
      "password": "shopee-password"
    }
  }
}
```

### Permissions

The file is saved with `0600` permissions (owner read/write only) automatically when created via `saveCredentials()`. If creating manually, set permissions:

```bash
chmod 600 ~/.auto-browser/credentials.json
```

### Domain Matching Behavior

Given this entry:
```json
{
  "sites": {
    "example.com": { "username": "user", "password": "pass" }
  }
}
```

The following URLs will all match:
- `https://example.com/login` (exact hostname match)
- `https://www.example.com/login` (`www.` stripping)
- `https://login.example.com/login` (subdomain-to-domain suffix match)
- `https://app.example.com/sign-in` (subdomain-to-domain suffix match)

---

## CLI Commands with Credential Configuration

### Basic task with default credentials path

```bash
auto-browser run --goal "log into example.com and check my dashboard" \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash
```
(Reads from `~/.auto-browser/credentials.json` by default)

### Task with custom credentials path

```bash
auto-browser run --goal "log into my account and scrape orders" \
  --credentials-path ./site-specific-creds.json \
  --planner-model deepseek-v4-pro \
  --executor-model deepseek-v4-flash
```

### Headed mode for first-time login (save cookies for future reuse)

```bash
auto-browser run --goal "log into taobao and visit messages page" \
  --headed \
  --cookies-path ./taobao-cookies.json \
  --credentials-path ~/.auto-browser/credentials.json
```

### Subsequent headless runs with saved cookies (skips login entirely)

```bash
auto-browser run --goal "check my latest orders on taobao" \
  --headless \
  --cookies-path ./taobao-cookies.json
```

### With TUI for live monitoring

```bash
auto-browser run --goal "log into shopee and extract order list" \
  --credentials-path ./shopee-creds.json \
  --tui
```

### Submit + review plan before approving

```bash
# Step 1: Submit
auto-browser submit --goal "fill out contact form with my saved info" \
  --credentials-path ./my-creds.json \
  --planner-model deepseek-v4-pro

# Step 2: Review the plan, then approve
auto-browser approve --task-id <task-id> \
  --executor-model deepseek-v4-flash
```

---

## HTTP API with Credentials

### Submit task with credentials via API

```bash
# 1. Create conversation
curl -X POST http://127.0.0.1:4317/api/conversations

# 2. Submit goal with credentials path in browserConfig
curl -X POST http://127.0.0.1:4317/api/conversations/<conv-id>/messages \
  -H 'content-type: application/json' \
  -d '{
    "content": "log into example.com and check notifications",
    "browserConfig": {
      "credentialsPath": "/home/user/.auto-browser/credentials.json",
      "launchMode": "headless"
    },
    "plannerModel": "deepseek-v4-pro"
  }'

# 3. Approve and execute
curl -X POST http://127.0.0.1:4317/api/tasks/<task-id>/approve \
  -H 'content-type: application/json' \
  -d '{"executorModel": "deepseek-v4-flash"}'
```

### Mark task for extension execution

```bash
curl -X POST http://127.0.0.1:4317/api/tasks/<task-id>/approve-extension
```

This tells the control service that the task should be executed by the Chrome extension (in your real Chrome browser) rather than through Playwright.

---

## Extension Manifest (`extension/manifest.json`)

The extension is loaded as an unpacked MV3 extension with this configuration:

```json
{
  "manifest_version": 3,
  "name": "Auto Browser Sidepanel",
  "version": "0.1.0",
  "description": "Chat-style sidepanel for active Auto Browser tasks.",
  "permissions": ["sidePanel", "storage", "tabs", "activeTab", "scripting"],
  "host_permissions": ["http://127.0.0.1:4317/*", "http://localhost:4317/*"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "action": {
    "default_title": "Open Auto Browser"
  }
}
```

Key points:
- The extension ONLY has permanent host access to `127.0.0.1:4317` and `localhost:4317` (the control service)
- Site access (`http://*/*`, `https://*/*`) is **optional** -- the extension requests it per-site when needed
- The sidepanel is the primary UI; click the toolbar icon to open it

---

## Environment Variables

```bash
# Control service port (default: 4317)
export AUTO_BROWSER_CONTROL_PORT=4317

# LLM router configuration
export AUTO_BROWSER_LLM_ROUTER_BASE_URL="http://127.0.0.1:18000"
export AUTO_BROWSER_LLM_ROUTER_API_KEY="your-api-key"

# Default models
export AUTO_BROWSER_PLANNER_MODEL="deepseek-v4-pro"
export AUTO_BROWSER_EXECUTOR_MODEL="deepseek-v4-flash"

# Browser settings
export AUTO_BROWSER_EXECUTABLE_PATH="/usr/bin/google-chrome"
export AUTO_BROWSER_EXECUTION_TIMEOUT_MS=120000
```

---

## Complete Setup Checklist

- [ ] Control service running (`auto-browser serve` or via `npm run dev:control-service`)
- [ ] `~/.auto-browser/credentials.json` created with proper JSON format
- [ ] File permissions set to `0600` (`chmod 600 ~/.auto-browser/credentials.json`)
- [ ] Extension loaded in Chrome at `chrome://extensions` (Developer mode ON, load `extension/` unpacked)
- [ ] Extension icon pinned to the toolbar for easy access
- [ ] Sidepanel opens and connects to `http://127.0.0.1:4317/api/state` successfully
- [ ] LLM router running at `http://127.0.0.1:18000` with planner and executor models available
- [ ] Test task submitted and executed successfully
