# Configuration Examples for Auto Browser Extension

## 1. Credentials File (`~/.auto-browser/credentials.json`)

The credential file stores site-specific login credentials keyed by hostname. The file must be readable only by the owner (`chmod 600`).

```json
{
  "sites": {
    "github.com": {
      "username": "your-github-username",
      "password": "your-github-password"
    },
    "weibo.com": {
      "username": "your-weibo-username",
      "password": "your-weibo-password"
    },
    "example.com": {
      "username": "admin@example.com",
      "password": "s3cret-p4ssword"
    },
    "mail.google.com": {
      "username": "user@gmail.com",
      "password": "app-specific-password"
    }
  }
}
```

### Hostname matching rules

| URL | Matches key | Reason |
|-----|-------------|--------|
| `https://github.com/login` | `github.com` | Exact match |
| `https://www.github.com/login` | `github.com` | `www.` stripped |
| `https://api.github.com/` | `github.com` | Suffix match: `api.github.com` -> `github.com` |
| `https://mail.google.com/` | `mail.google.com` | Exact match (takes priority) |
| `https://www.weibo.com/` | `weibo.com` | `www.` stripped |

---

## 2. Environment Variables for the Control Service

Set these before starting the control service. The extension itself does not read these -- they configure the service that the extension calls.

```bash
# LLM router configuration
export AUTO_BROWSER_LLM_ROUTER_BASE_URL="http://127.0.0.1:18000"
export AUTO_BROWSER_LLM_ROUTER_API_KEY="sk-your-api-key"

# Default model IDs (used when extension presets have none configured)
export AUTO_BROWSER_PLANNER_MODEL="openai/gpt-5.4"
export AUTO_BROWSER_EXECUTOR_MODEL="openai/gpt-5.4"

# Vision-capable model for canvas/screenshot observations
export AUTO_BROWSER_VISION_MODEL="claude-sonnet-4-20250514"

# Control service port (default: 4317)
export AUTO_BROWSER_CONTROL_PORT="4317"

# Max execution time in ms (default: 120000)
export AUTO_BROWSER_EXECUTION_TIMEOUT_MS="120000"

# Local Chrome/Chromium executable for "system" browser mode
export AUTO_BROWSER_EXECUTABLE_PATH="/usr/bin/google-chrome"
```

---

## 3. Extension LLM Preset Configuration (via Sidepanel UI)

The sidepanel UI stores its LLM configuration in `chrome.storage.local` under the key `sidepanelPreferences`. The default structure is:

```json
{
  "providerPresets": [
    {
      "id": "provider-1700000000000",
      "name": "Local LLM Router",
      "provider": "llm-router",
      "baseUrl": "http://127.0.0.1:18000/v1",
      "apiKey": "",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    }
  ],
  "llmPresets": [
    {
      "id": "preset-1700000000000",
      "name": "Default",
      "active": true,
      "roles": {
        "planner": {
          "providerPresetId": "provider-1700000000000",
          "model": "openai/gpt-5.4",
          "updatedAt": "2025-01-01T00:00:00.000Z"
        },
        "executor": {
          "providerPresetId": "provider-1700000000000",
          "model": "openai/gpt-5.4",
          "updatedAt": "2025-01-01T00:00:00.000Z"
        }
      },
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    }
  ],
  "activeLlmPresetId": "preset-1700000000000",
  "selectedConversationId": null
}
```

Configure this through the extension's LLM Settings panel (`Alt+L`), not by editing `chrome.storage.local` directly.

---

## 4. CLI Task Submission with Credentials

```bash
# Basic run (uses default credentials path ~/.auto-browser/credentials.json)
npx auto-browser run --goal "Log in to github.com and check my notifications"

# Explicit credentials path
npx auto-browser run --goal "Log in to example.com dashboard" \
  --credentials-path /home/user/my-credentials.json

# Full example with all browser config flags
npx auto-browser run \
  --goal "Log in to example.com and download the monthly report" \
  --browser-family chromium \
  --executable-path /usr/bin/google-chrome \
  --profile-path ~/.auto-browser/profile \
  --cookies-path ~/.auto-browser/cookies.json \
  --credentials-path ~/.auto-browser/credentials.json \
  --headed \
  --preview-enabled

# TUI watch mode (real-time progress)
npx auto-browser run --tui --goal "Log in and check inbox" \
  --credentials-path ~/.auto-browser/credentials.json
```

---

## 5. `BrowserRuntimeConfig` Interface (TypeScript)

This is the full configuration object passed when submitting a task. The extension sets most fields to empty/auto; the CLI allows full customization.

```typescript
interface BrowserRuntimeConfig {
  mode: 'managed' | 'system';           // 'managed' = Playwright Chromium, 'system' = local Chrome
  browserFamily: 'chromium' | 'chrome' | 'firefox';
  executablePath: string;               // Path to browser executable (empty = auto-detect)
  profilePath: string;                  // Path to browser profile directory
  cookiesPath: string;                  // Path to cookies.json storage state file
  credentialsPath: string;              // Path to credentials.json (empty = default path)
  launchMode: 'auto' | 'headless' | 'headed';
  extensionEnabled: boolean;            // Whether extension mode is enabled
  previewEnabled: boolean;              // Whether to show preview/visuals
  cdpUrl: string;                       // Chrome DevTools Protocol URL (empty = use Playwright)
}
```

The extension `background.js` hardcodes this config when submitting a goal:

```javascript
browserConfig: {
  mode: 'managed',
  browserFamily: 'chromium',
  executablePath: '',
  profilePath: '',
  launchMode: 'auto',
  extensionEnabled: true,
  previewEnabled: true,
  // NOTE: credentialsPath is NOT set by the extension
}
```

---

## 6. Login Form Detection Keywords

The credential auto-fill system detects login forms by scanning page refs for these keywords (case-insensitive):

**Username fields** (`USERNAME_KEYWORDS`):
- English: `username`, `user name`, `email`, `e-mail`, `login`, `account`, `phone`, `mobile`, `tel`
- Chinese: `手机号`, `手机号码`, `邮箱`, `账号`, `用户名`, `用户`

**Password fields** (`PASSWORD_KEYWORDS`):
- English: `password`, `passwd`, `pwd`, `pass`
- Chinese: `密码`, `口令`

**Submit buttons**:
- English: `login`, `sign in`, `log in`, `submit`
- Chinese: `登录`, `登入`, `提交`
