# Auto Browser Chrome Extension Setup with Credential Configuration

Since your control service is already running, here are the complete steps to set up the Chrome extension and configure it to use credentials from a file.

---

## Step 1: Create Your Credentials File

The extension and the main execution driver both read credentials from a shared JSON file. Create your credentials file at the default location:

```
~/.auto-browser/credentials.json
```

The file is automatically created with `0600` permissions (owner read/write only) for security. You can also use a custom path if you prefer.

**Template:**

```json
{
  "sites": {
    "example.com": {
      "username": "user@example.com",
      "password": "your-password"
    },
    "github.com": {
      "username": "myuser",
      "password": "ghp_token"
    },
    "taobao.com": {
      "username": "myusername",
      "password": "mypassword"
    }
  }
}
```

**Domain matching rules (all automatic):**

- Exact match: `example.com` matches `https://example.com`
- `www.` stripping: `example.com` matches `https://www.example.com` too
- Subdomain-to-domain fallback: `login.example.com` matches credentials for `example.com`
- Bidirectional matching: if the URL's domain suffix matches a stored key (or vice versa), it resolves

**Where credentials are used:**

Credentials are NOT used by the extension sidepanel directly -- they are used by the execution driver (both managed browser mode and extension mode) during task execution. When the agent-loop execution driver detects a login form on the page (it scans for username/email/phone fields and password fields in both English and Chinese), it auto-fills the matching credentials from this file on early execution iterations.

**To use a custom credentials path**, pass the `--credentials-path` flag:

```bash
auto-browser run --goal "log into my dashboard" \
  --credentials-path ./my-custom-creds.json
```

Or submit via API:

```bash
curl -X POST http://127.0.0.1:4317/api/conversations/conv-id/messages \
  -H 'content-type: application/json' \
  -d '{
    "content": "log into my dashboard",
    "credentialsPath": "./my-custom-creds.json"
  }'
```

---

## Step 2: Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` directory from the auto-browser project:

   ```
   /home/rczx/workspace/rinbarpen/projects/auto-browser/extension/
   ```

**What you are loading:** The directory contains:

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest -- permissions for sidePanel, storage, tabs, scripting, and host access to the control service (127.0.0.1:4317) |
| `background.js` | Service worker that runs the observe-decide-act loop for extension tasks |
| `background-state.js` | Immutable state reducer for the extension session |
| `sidepanel.html` + `sidepanel.js` + `sidepanel.css` | Chat-style operator console UI |
| `content-script.js` + `content-helpers.js` | In-page DOM actions, overlay rendering (virtual cursor, highlights), and page observation |
| `start-task.js` | Resolves the start URL for the automation tab |

The manifest requires:
- `permissions`: `sidePanel`, `storage`, `tabs`, `activeTab`, `scripting`
- `host_permissions`: `http://127.0.0.1:4317/*` and `http://localhost:4317/*` (control service)
- `optional_host_permissions`: `http://*/*` and `https://*/*` (requested per-site as needed)

---

## Step 3: Open the Sidepanel

After loading the extension:

1. Click the **Auto Browser** icon in the Chrome toolbar (puzzle piece icon if it is hidden by default, then pin it)
2. The sidepanel opens on the right side of Chrome

The sidepanel is a chat-style operator console with:
- A goal input field and model selectors (planner + executor model IDs)
- A conversation/thread view showing task history
- A timeline strip showing execution events
- Buttons for: send, refresh, grant site permissions, resume, handoff
- LLM settings panel for managing provider presets

---

## Step 4: Run a Task via the Extension

### From the sidepanel:

1. Enter your goal in the sidepanel input field (e.g., "log into example.com and check my dashboard")
2. Optionally set the start URL, planner model, and executor model
3. Click **Send** (or press Enter)
4. The extension creates a dedicated automation tab and begins the observe-decide-act loop:
   - Observes the page and sends `{ observation, history }` to `POST /api/tasks/:id/decide`
   - Receives an action from the LLM (navigate, click_ref, fill_ref, scroll, wait_for, etc.)
   - Executes the action in-page via the content script
   - Reports progress via `POST /api/tasks/:id/report`
5. When a login form is detected, the control service auto-fills credentials from your `credentials.json` (matched by hostname)
6. A visual overlay shows a virtual cursor, target highlights, and a status indicator

### From the CLI (extension execution path):

When running tasks via CLI, the extension-enabled flag controls whether tasks can be executed by the extension:

```bash
# Extension is enabled by default -- use --no-extension-enabled to disable
auto-browser run --goal "log into my dashboard" \
  --credentials-path ~/.auto-browser/credentials.json

# Explicitly enable extension
auto-browser run --goal "check my orders" \
  --extension-enabled
```

Note: Tasks submitted via the CLI with `--extension-enabled` and then marked with `approve-extension` run inside the Chrome extension rather than through Playwright. This means the task runs in your real Chrome browser with your existing sessions, cookies, and extensions.

---

## Step 5: Verify Everything is Working

### Check the control service state:

```bash
curl http://127.0.0.1:4317/api/state
```

This returns the full service state including conversations, tasks, and the active task lock.

### Stream events to watch execution:

```bash
curl -N http://127.0.0.1:4317/api/events
```

You will see SSE events for: `conversation.created`, `task.drafted`, `task.ready`, `task.running`, `task.execution.iteration.started`, `task.execution.llm.completion`, `task.execution.iteration.completed`, and finally `task.completed` or `task.failed`.

### Check runtime configuration:

```bash
curl http://127.0.0.1:4317/api/runtime-config
```

Confirms the planner and executor models are properly configured.

---

## How the Extension + Credentials Flow Works Together

The full flow when you start a task:

1. **Sidepanel** sends the goal to the control service via `POST /api/conversations/:id/messages`
2. The **planner LLM** drafts an execution plan (status: `draft`)
3. The task is approved with the **executor LLM model** (status: `ready` -> `running`)
4. The **Agent Loop Execution Driver** begins iterating:
   - **Iteration 1-2**: Observes the page, captures snapshot refs
   - **Credential auto-fill**: If a login form is detected (username/email/phone + password fields, detected via Chinese and English keywords), the driver auto-fills from `credentials.json` matched by the page's hostname
   - **Each iteration**: LLM decides the next action, it is applied to the page, and progress is reported
   - **Cookie persistence**: On task completion, cookies are saved to the configured path; on task start, cookies are loaded so subsequent tasks skip login
5. **Completion**: The task finishes with a summary, or enters handoff status if human intervention is needed (e.g., CAPTCHA that cannot be auto-solved)

**Key difference between extension mode and managed (Playwright) mode:**
- **Extension mode**: Runs in your real Chrome with your existing sessions, cookies, and extensions. No Playwright. Actions are executed via `chrome.tabs.sendMessage` to the content script. The virtual cursor and highlights are rendered as DOM overlays.
- **Managed mode**: Uses Playwright-driven Chromium (auto-downloaded). Has deeper browser control (including system mouse, CDP, and screenshot observations).

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Sidepanel cannot connect | Verify control service is running on port 4317: `curl http://127.0.0.1:4317/api/state` |
| Extension requires site permission | In the sidepanel, click the **Grant Permission** button, or manually approve in the Chrome permissions popup |
| Credentials not auto-filling | Check the file at `~/.auto-browser/credentials.json` has valid JSON and the domain matches the login page (check subdomain/suffix matching rules above) |
| Task stuck in handoff | Resume with `auto-browser resume --task-id <task-id> --planner-model deepseek-v4-pro` after completing the manual step |
| Extension not showing in toolbar | Click the puzzle piece icon, find "Auto Browser Sidepanel", and pin it |
