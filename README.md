# Auto Browser Product

Product-layer implementation for Auto Browser lives at the workspace root, separate from the
`agent-browser` browser execution kernel.

## Layout

- `src/auto-browser/` - local control service, task lifecycle, validation, and HTTP/SSE API
- `desktop/` - ChatGPT-style desktop shell and Electron entrypoint
- `extension/` - Chromium MV3 sidepanel extension with dedicated-tab execution, runtime site permissions, and in-page visual overlay
- `scripts/serve-app-shell.mjs` - static server for previewing the desktop shell

## Browser Families

Auto Browser supports four browser families: `chromium`, `chrome`, `edge`, and `cloak`.

| Family | Mode | Binary Source |
|--------|------|---------------|
| `chromium` | managed | Auto-downloaded by Playwright |
| `chrome` | system | Local Chrome installation |
| `edge` | system | Local Edge installation |
| `cloak` | both | [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) npm package or `CLOAKBROWSER_BINARY_PATH` |

Select with `--browser-family` on `submit`/`run` commands.

### CloakBrowser (stealth mode)

CloakBrowser is a stealth-modified Chromium binary with 57-58 C++-level anti-detection patches (canvas/WebGL fingerprinting, `navigator.webdriver` removal, CDP trace elimination, etc.). Use it to reduce bot detection on sensitive sites.

```bash
# Managed mode — auto-downloads the cloak binary (requires the npm package)
npm install cloakbrowser
auto-browser run --browser-family cloak --goal "check device info"

# System mode — point to an existing cloak binary
CLOAKBROWSER_BINARY_PATH=/opt/cloak/chrome auto-browser run --browser-family cloak --goal "..."

# CDP mode — connect to an external CloakBrowser instance (e.g. cloakserve Docker)
auto-browser run --cdp-url ws://localhost:9222 --goal "..."
```

Additional cloak configuration flags:

| Flag | Type | Description |
|------|------|-------------|
| `--cloak-humanize` | boolean | Enable human-like interaction patterns (Bezier mouse curves, per-character typing) |
| `--cloak-fingerprint-seed` | string | Deterministic fingerprint seed for consistent identity |
| `--cloak-timezone` | string | Override browser timezone |
| `--cloak-locale` | string | Override browser locale |

Cloak is never auto-detected; it must be explicitly selected with `--browser-family cloak`.

## Commands

```bash
npm run dev:control-service
npm run dev:desktop-preview
npm run test
npm run typecheck
```

## Extension Mode

The Chromium extension now supports a dedicated extension-driven execution path:

- The sidepanel acts as the operator console: create a task, start execution, grant site access, resume, and hand off.
- The background service worker coordinates one extension session at a time with `{ sessionId, taskId, tabId, origin, status }`.
- A dedicated automation tab is created for the task. The extension requests site permission per origin at runtime before injecting the content script.
- Execution happens inside the page with DOM actions only. The real system mouse is not moved.
- The page overlay renders a virtual cursor, target highlight, click pulse, and current-step status using `pointer-events: none`.

Supported extension actions in the first version:

- `navigate`
- `click_ref`
- `fill_ref`
- `press_key`
- `scroll`
- `wait_for`

`fill_ref` is redacted in UI/event summaries through `textPreview`; full sensitive input is not echoed back into the sidepanel timeline.

## Load The Extension

1. Start the local control service:

```bash
npm run dev:control-service
```

2. Open `chrome://extensions` or the Chromium equivalent.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the repo's [`extension/`](/home/rczx/workspace/rinbarpen/projects/auto-browser/extension) directory.
6. Open the extension sidepanel from the toolbar action.

When a task navigates to a new origin, the sidepanel will ask for site access before execution continues. If permission is denied, the task moves into `blocked`/handoff instead of failing silently.

## Extension Flow

1. Enter a natural-language goal in the sidepanel.
2. Optionally set a start URL plus planner/executor model ids.
3. Start the extension run. A dedicated tab is created and the task is approved with execution source `extension`.
4. The extension observes the page, sends `{ observation, history }` to the local service, receives one `ExecutorAction`, executes it in-page, and reports progress back.
5. The sidepanel timeline updates from `/api/state` and `/api/events` data, including action-started, action-completed, blocked, and completed events.

## HTTP API

Existing task lifecycle routes remain available. The extension path adds:

- `POST /api/tasks/:id/approve-extension`
  Starts a task in extension mode and marks the execution source as `extension`.
- `POST /api/tasks/:id/decide`
  Accepts `{ observation, history }` and returns one `ExecutorAction`.
- `POST /api/tasks/:id/report`
  Accepts `{ phase, action, outcome, observationSummary, message }` and writes extension execution events.

`GET /api/state` now includes:

- `conversations`
- `tasks`
- `activeTask`
- `events`

The SSE stream at `GET /api/events` includes extension execution events in addition to coarse task lifecycle updates.

## Event Types

`TaskEvent` now carries `source: 'service' | 'extension'` and can emit:

- `task.execution.action_started`
- `task.execution.action_completed`
- `task.execution.blocked`
- `task.execution.completed`

Action events may also include a lightweight `summary` payload for sidepanel rendering, such as the action label, target ref, URL, key, scroll direction, or redacted `textPreview`.

## Product CLI

After building, the root package exposes a product-level CLI:

```bash
auto-browser serve --port 4317
auto-browser state
auto-browser --help
auto-browser submit --goal "open example.com and tell me the title" \
  --planner-model openai/gpt-5.4 \
  --executor-model openai/gpt-5.4
auto-browser submit --goal "log in and stop before submit" \
  --planner-model openai/gpt-5.4 \
  --json
auto-browser run --goal "open example.com and tell me the title" \
  --planner-model openai/gpt-5.4 \
  --executor-model openai/gpt-5.4
auto-browser run --goal "open example.com and tell me the title" \
  --planner-model openai/gpt-5.4 \
  --executor-model openai/gpt-5.4 \
  --conversation-id <conversation-id> \
  --json
auto-browser approve --task-id <task-id> --executor-model openai/gpt-5.4
auto-browser handoff --task-id <task-id> --source cli
auto-browser resume --task-id <task-id> --planner-model openai/gpt-5.4
auto-browser completion bash
auto-browser completion zsh
```

Notes:

- `auto-browser` is the product/task CLI.
- `agent-browser` remains the low-level browser automation CLI.
- Auto Browser defaults to the local Chrome executable when one is configured or detected.
- If local Chrome is not available, the first managed run automatically downloads Playwright Chromium.
- To pin a system browser path, set `AUTO_BROWSER_EXECUTABLE_PATH=/path/to/chrome` in `.env`.
- `submit` and `resume` require a planner model.
- `approve` requires an executor model.
- `run` requires both planner and executor models.
- Planner and executor model ids must exist in the configured LLM router's `/v1/models` catalog.
- The documented examples use `openai/...` ids; provider-prefixed ids that are not in the router catalog will be rejected during CLI preflight.
- The CLI auto-starts the local control service if it is not already running.

Shell completion:

```bash
mkdir -p ~/.local/share/bash-completion/completions
auto-browser completion bash > ~/.local/share/bash-completion/completions/auto-browser

mkdir -p ~/.zfunc
auto-browser completion zsh > ~/.zfunc/_auto-browser
```

If you use `zsh`, ensure your shell startup enables that directory before `compinit`:

```bash
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

Exit codes:

- `0`: success
- `2`: usage error or unsupported arguments
- `3`: missing or invalid CLI configuration, including model flags
- `4`: control service could not start or become ready
- `5`: API request failed after the CLI reached the service
