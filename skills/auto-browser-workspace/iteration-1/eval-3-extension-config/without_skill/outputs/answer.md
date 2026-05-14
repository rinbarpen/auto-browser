# Setting Up the Auto Browser Chrome Extension with Credential Support

## Overview

The Auto Browser extension is a Chrome MV3 sidepanel that lets you submit browser automation goals and monitor execution. Credentials from a file are loaded when tasks run through the CLI/TUI path using the `AgentLoopExecutionDriver`. Below is the complete setup walkthrough and how credential auto-fill works.

---

## Step 1: Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked** and select the project's `extension/` directory:
   ```
   /home/rczx/workspace/rinbarpen/projects/auto-browser/extension/
   ```
4. The extension "Auto Browser Sidepanel" should appear in your extensions list. It uses Manifest V3 and requests these permissions:
   - `sidePanel` -- renders the operator console in Chrome's sidebar
   - `storage` -- persists user preferences (LLM presets, selected conversation)
   - `tabs` -- creates/manages the dedicated automation tab
   - `activeTab` -- interacts with the current tab
   - `scripting` -- injects the content script (`content-script.js`) into the automation tab
   - `host_permissions` -- restricts to `http://127.0.0.1:4317/*` and `http://localhost:4317/*` (your control service) by default; offers optional `http://*/*` and `https://*/*` for automation sites
5. Once loaded, click the extension icon in Chrome's toolbar or use the side panel to open the operator console.

---

## Step 2: Verify the Control Service is Reachable

The extension communicates with the control service at `http://127.0.0.1:4317/api`. Since you already have the service running, confirm it is accessible:

```bash
curl -s http://127.0.0.1:4317/api/state | head -c 200
```

You should see a JSON response with `conversations`, `tasks`, and `events` arrays.

---

## Step 3: Create the Credentials File

The credential auto-fill system reads from a JSON file. The **default path** is:

```
~/.auto-browser/credentials.json
```

### File format

```json
{
  "sites": {
    "example.com": {
      "username": "your-username",
      "password": "your-password"
    },
    "weibo.com": {
      "username": "your-weibo-username",
      "password": "your-weibo-password"
    }
  }
}
```

### Creating the file with correct permissions

```bash
mkdir -p ~/.auto-browser
cat > ~/.auto-browser/credentials.json << 'EOF'
{
  "sites": {
    "example.com": {
      "username": "user@example.com",
      "password": "your-password-here"
    }
  }
}
EOF
chmod 600 ~/.auto-browser/credentials.json
```

The code enforces `0600` permissions on save, so other users on the system cannot read your credentials.

---

## Step 4: How Credential Auto-Fill Works (CLI / TUI Path)

When you run a task via the CLI or TUI, the `AgentLoopExecutionDriver` performs credential auto-fill during the execution loop:

1. **Loaded early**: On iterations 0 and 1 (the first two), the driver loads credentials from the file path specified in `browserConfig.credentialsPath` (defaulting to `~/.auto-browser/credentials.json` if empty).

2. **Hostname matching**: The system extracts the hostname from the current page URL and matches it against the `sites` keys using a flexible algorithm:
   - Exact match: `example.com` matches `https://example.com/login`
   - `www.` stripping: `example.com` matches `https://www.example.com/page`
   - Subdomain-to-domain suffix match: `example.com` matches `https://mail.example.com/`
   - Bidirectional suffix match for cases like `login.weibo.com` / `weibo.com`

3. **Login form detection**: When credentials are found for the current site, the driver scans the page's snapshot refs for login form fields. It recognizes:
   - **Username fields**: refs with `role=textbox` or `role=searchbox` whose name contains keywords like `username`, `email`, `login`, `account`, `手机号`, `邮箱`, `用户名`, etc.
   - **Password fields**: refs whose name contains `password`, `passwd`, `密码`, `口令`, or have `role=password`.
   - **Submit buttons**: refs with `role=button` whose name contains `login`, `sign in`, `submit`, `登录`, `提交`, etc.
   - **Fallback**: If a password field is found but no username field, the first non-password textbox is used as the username field.

4. **Auto-fill and auto-submit**: If a login form is detected, the driver automatically fills the username and password fields, then clicks the submit button if found. This is logged as a `credential_autofill` action in the history.

5. **Best-effort**: If credential auto-fill fails for any reason (no matching credentials, no form detected, page not loaded yet), execution falls through to the normal LLM observe-decide-act loop.

---

## Step 5: Passing a Custom Credentials Path (CLI)

If you want to use a different credentials file, pass it when submitting a task:

```bash
npx auto-browser run --goal "Log in to example.com and fetch my dashboard" \
  --credentials-path /path/to/custom-credentials.json
```

The `--credentials-path` flag sets `browserConfig.credentialsPath`, which the driver passes to `loadCredentials()`.

---

## Step 6: Running Tasks Through the Extension

Once the extension is loaded and the control service is running:

1. Open the extension sidepanel (click the extension icon or open Chrome's side panel).
2. Configure your LLM preset (models for planner and executor) via the LLM Settings panel (gear icon or `Alt+L`).
3. Type your goal in the message composer and click **Send** (or press `Ctrl+Enter` / `Cmd+Enter`).
4. The extension submits the goal to the control service, which drafts a plan. The task is then marked as extension-executable.
5. The extension opens a dedicated automation tab and begins running the observe-decide-act loop.
6. Monitor progress in the sidepanel's timeline strip and Run view.

### Keyboard shortcuts in the sidepanel

| Shortcut | Action |
|----------|--------|
| `Alt+I` | Focus the goal input |
| `Ctrl+Enter` | Send the goal (when input focused) |
| `Alt+M` | Toggle menu (history/run/details) |
| `Alt+L` | Toggle LLM settings panel |
| `Alt+T` | Focus timeline strip |
| `Alt+1`-`4` | Switch menu views |
| `Esc` | Close any open panel |

---

## Important Limitation: Credentials and the Extension Path

The extension's execution path (`background.js` -> `resumeExtensionExecution`) runs its own observe-decide-act loop directly in the Chrome extension. This loop does **not** include the credential auto-fill logic that exists in `AgentLoopExecutionDriver`. Credential auto-fill only activates when tasks are run through the CLI/TUI path.

When using the extension, the LLM executor will need to determine how to fill login forms based on page observations. You can include credentials in your goal text, or consider using the CLI path for tasks that require automatic credential injection.

To run a task with credential auto-fill via CLI:

```bash
npx auto-browser run --goal "Log in to example.com and check notifications" \
  --credentials-path ~/.auto-browser/credentials.json
```

Or use the TUI watch mode for real-time progress:

```bash
npx auto-browser run --tui --goal "Log in to example.com and check notifications" \
  --credentials-path ~/.auto-browser/credentials.json
```

---

## Step 7: Granting Site Permissions in the Extension

When the extension navigates to a new origin, Chrome requires host permissions. The extension handles this flow:

1. A permission dialog appears in the sidepanel showing "Permission required for <origin>".
2. Click **Grant site access** to approve the permission for that origin.
3. The extension calls `chrome.permissions.request()` and, once granted, injects the content script and resumes execution.

You can grant persistent optional permissions ahead of time in `chrome://extensions` -> Auto Browser Sidepanel -> Details -> Site access.

---

## Summary of Key Files

| File | Purpose |
|------|---------|
| `extension/manifest.json` | Extension manifest (MV3, permissions, side panel config) |
| `extension/background.js` | Service worker: session state, task lifecycle, observe-decide-act loop |
| `extension/sidepanel.js` + `sidepanel.html` | Operator console UI (goal input, LLM settings, timeline, conversation management) |
| `extension/content-script.js` | Injected into automation tab for `observe_page` and `run_action` |
| `extension/start-task.js` | Resolves the automation tab URL from the active tab |
| `extension/background-state.js` | Immutable session state reducer |
| `src/auto-browser/credential-store.ts` | Credential file loading, hostname matching, login form detection |
| `~/.auto-browser/credentials.json` | Your credential file (default path) |
