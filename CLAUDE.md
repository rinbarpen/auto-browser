# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Auto Browser is a product-layer browser automation system. It provides CLI, HTTP API, Chromium MV3 extension, Electron desktop shell, and a Next.js web app (`app/`) for executing browser tasks via a dual-LLM architecture (planner + executor models).

The low-level browser automation kernel is `agent-browser/` (v0.7.6, forked from Vercel Labs) — a Playwright-based headless browser automation library.

## Commands

```bash
# Root project — control service, CLI, extension
npm run build                          # TypeScript compile
npm run dev:control-service            # Start control service (tsx watch, port 4317)
npm run dev:desktop-preview            # Serve desktop shell for preview
npm test                               # Run all tests (vitest)
npm run typecheck                      # TypeScript type check only
npx vitest run src/auto-browser/cli.test.ts  # Run single test file

# App sub-project (hxcy-collector — Next.js resource collection)
cd app && npm run dev                  # Start dev server
cd app && npm run test                 # Run app tests (vitest)
cd app && npm run crawl                # Run resource crawler
cd app && npm run typecheck            # Type check via next build

# agent-browser sub-project
cd agent-browser && npm run build      # Build TypeScript
cd agent-browser && npm run test       # Run tests
cd agent-browser && npm run dev        # Start daemon in dev mode
```

## Architecture

### System Design

```
User Interfaces          CLI (src/auto-browser/cli.ts)
                         TUI (src/auto-browser/tui.tsx) — ink-based interactive watch mode
                     Electron Desktop (desktop/)
                     Chrome Extension (extension/)
                     Next.js Web App (app/)

Control Layer        HTTP/SSE Server (src/auto-browser/server.ts)
                     InMemoryControlService (src/auto-browser/control-service.ts)
                     ------------------------------------------
                     Task lifecycle: draft → ready → running → completed|handoff|failed
                     SSE event stream at GET /api/events for real-time progress

Execution Drivers    AgentLoopExecutionDriver (LLM observe-act loop, 20 iterations max)
                     BrowserExecutionDriver (simple search tasks)
                     Extension execution (background.js observe/decide/act loop)

LLM Integration      LlmRouterClient → external router at 127.0.0.1:18000
                     LlmPlanner (plan drafting + replanning)
                     LlmExecutorDecider (per-step action decisions)
                     Dual-model: planner model for plans, executor model for actions
                     TokenUsage extracted from API responses (promptTokens, completionTokens, totalTokens)

Browser Layer        ManagedBrowser → AgentBrowserManagedBrowser → agent-browser BrowserManager
                     Two modes: "managed" (Playwright Chromium) or "system" (local Chrome)
                     Auto-downloads Playwright Chromium on first run if no local Chrome
```

### TUI Watch Mode (ink)

`auto-browser run --tui --goal "..."` blocks until completion, rendering a live status table:

- **SSE-driven**: Connects to `GET /api/events`, parses `TaskEvent` stream via `fetch()` ReadableStream
- **Component tree**: Header (task ID, status badge, elapsed) → PlanSteps (✓/▶/○ markers) → StatusBar (iteration, URL, title) → ActionHistory (last 8 actions table) → LlmDetails (raw completion + token counts) → Footer (q/r/c shortcuts)
- **Keyboard**: `q`/`Esc` quit, `c` POST cancel, `r` re-run (submit new task + restart TUI)
- **Non-blocking execution**: Posts to `POST /api/tasks/:id/run` which returns immediately; events stream via SSE
- **Reconnection**: Up to 3 retries with "Reconnecting..." indicator in header
- Entry point: `startTui()` in `src/auto-browser/tui.tsx`, wraps ink's `render()` and returns a `waitUntilExit()` promise

### Task Lifecycle

1. **Submit** — user submits goal → planner drafts a plan → task status: `draft`
2. **Approve** — approve task with executor model → status: `ready` → `running`
3. **Execute** — AgentLoopExecutionDriver runs observe-decide-act loop (max 20 iterations)
   - Observer captures page snapshot, refs, visible text
   - **Credential auto-fill**: On early iterations, detects login forms from snapshot refs (username/password/sign-in keywords in Chinese and English) and auto-fills from `~/.auto-browser/credentials.json` matched by hostname
   - **Cloudflare bypass**: If challenge detected, waits up to 60s with human-like mouse movements, turnstile checkbox clicking in iframes, and verify/continue button clicking
   - **CAPTCHA solving**: Attempts reCAPTCHA v2 token injection and image captcha solving via configured solver
   - LLM decides next action (navigate/click_ref/fill_ref/scroll/finish/handoff/etc.)
   - Action applied to page via Playwright
   - Visual observations (screenshots) triggered for canvas-heavy pages
   - Auto-finish for simple info-retrieval goals; handoff for auth/captcha/unsupported browser
   - **Cookie persistence**: Loads cookies from configured path at start, saves on completion
   - **Per-iteration events**: Emits `iteration.started`, `llm.completion`, `iteration.completed` via `EventEmitter` for TUI/SSE consumption
4. **Complete** or **Handoff** — result summary returned, or task paused for human intervention

### Executor Actions

```
navigate   — goto URL
click_ref  — click by snapshot ref
click_point — click at viewport coordinates (canvas fallback)
fill_ref   — type text into a field (textPreview for redacted UI display)
press_key  — keyboard press
scroll     — scroll up/down
wait_for   — wait for text or timeout
finish     — mark task complete
handoff    — request human intervention
```

### SSE Event Types

The server streams `TaskEvent` objects on `GET /api/events`. Key event types:

| Event | When |
|-------|------|
| `task.drafted` | Plan drafted after goal submission |
| `task.ready` | Task approved with executor model |
| `task.running` | Execution loop started |
| `task.execution.iteration.started` | Each iteration begins (includes URL, title) |
| `task.execution.llm.completion` | After LLM decide call (includes raw content, tokens) |
| `task.execution.iteration.completed` | After action applied (includes action summary, URL, title) |
| `task.completed` | Task finished successfully |
| `task.failed` | Task execution threw an error |
| `task.handoff` | Task requires human intervention |
| `task.cancelled` | Task cancelled via API |
| `task.execution.action_started` / `action_completed` | Extension execution progress |
| `task.execution.blocked` | Extension execution blocked |

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | Full service state (conversations, tasks, events) |
| GET | `/api/events` | SSE stream of `TaskEvent` objects |
| GET | `/api/browser-runtime/defaults` | Detected browser runtime defaults |
| GET | `/api/runtime-config` | Planner/executor configuration status |
| POST | `/api/conversations` | Create a conversation |
| PATCH | `/api/conversations/:id` | Update conversation title |
| DELETE | `/api/conversations/:id` | Delete conversation (blocks if active task) |
| POST | `/api/conversations/:id/messages` | Submit goal → returns drafted task |
| POST | `/api/tasks/:id/approve` | Approve task (blocking — awaits completion) |
| POST | `/api/tasks/:id/run` | Run task (non-blocking — returns immediately, streams events via SSE) |
| POST | `/api/tasks/:id/approve-extension` | Mark task as extension-executable |
| POST | `/api/tasks/:id/decide` | Extension: request next action from LLM |
| POST | `/api/tasks/:id/report` | Extension: report execution progress |
| POST | `/api/tasks/:id/handoff` | Request human handoff |
| POST | `/api/tasks/:id/resume` | Replan and resume a handed-off task |
| POST | `/api/tasks/:id/cancel` | Cancel a running task |
| POST | `/api/force-clear-active` | Force-clear the active task lock |
| OPTIONS | Any | CORS preflight |

### Credential Store

`src/auto-browser/credential-store.ts` manages persisted credentials:

- **Storage**: `~/.auto-browser/credentials.json` with `{ sites: { "example.com": { username, password } } }` format, file permissions `0600`
- **Matching**: `matchCredentials(url, creds)` resolves credentials by hostname — exact match, `www.` stripping, subdomain-to-domain suffix match, and bidirectional matching
- **Login detection**: `detectLoginForm(refs)` scans snapshot refs for username/email/phone fields and password fields using Chinese and English keywords, plus submit/sign-in/login buttons. Falls back to first non-password textbox as username if no explicit match.

### Extension Execution Path

The Chrome extension runs an independent observe-decide-act loop in the service worker:
- `background.js` creates a dedicated automation tab, requests per-origin site permission
- Content script (`content-script.js`) provides `observe_page` and `run_action` messaging
- Each observation is sent to `POST /api/tasks/:id/decide` (service-side LlmExecutorDecider)
- Actions are executed via `chrome.tabs.sendMessage` to the content script
- Visual overlay renders virtual cursor, target highlights, and status

### Extension File Layout

- `manifest.json` — MV3, sidePanel + scripting + tabs permissions
- `background.js` — session state, observe-decide-act loop, permission handling
- `background-state.js` — immutable state reducer for session
- `sidepanel.js` + `sidepanel.html` + `sidepanel.css` — operator console UI
- `content-script.js` + `content-helpers.js` — in-page DOM actions and overlay
- `start-task.js` — automation tab URL resolution

### Sub-Project: app/ (hxcy-collector)

A Next.js web app for resource collection and visualization:
- **Server**: Fastify-based REST API (`src/server/api.ts`) — resources, crawl control, download endpoints
- **Crawler**: `src/crawler/` — Playwright-based crawl with login support, QR code scanning, content extraction
- **Workbench**: `src/workbench/` — Browser session management with recording, replay, WebSocket screencast
- **Storage**: SQLite via better-sqlite3 (`src/storage/db.ts`) — resources, flows, browser instances, cookies
- **Downloader**: Local filesystem + Baidu Pan support
- **Components**: React (flow-workbench, workbench-home) with Next.js App Router

### Key Environment Variables

```
AUTO_BROWSER_CONTROL_PORT     — Control service port (default: 4317)
AUTO_BROWSER_LLM_ROUTER_BASE_URL — LLM router URL (default: http://127.0.0.1:18000)
AUTO_BROWSER_LLM_ROUTER_API_KEY  — LLM router API key
AUTO_BROWSER_PLANNER_MODEL       — Default planner model ID
AUTO_BROWSER_EXECUTOR_MODEL      — Default executor model ID
AUTO_BROWSER_VISION_MODEL        — Vision-capable model for canvas/screenshot observations
AUTO_BROWSER_EXECUTABLE_PATH     — Local Chrome/Chromium path (system mode)
AUTO_BROWSER_EXECUTION_TIMEOUT_MS — Max execution time in ms (default: 120000)
AGENT_BROWSER_PROXY              — Proxy server for browser traffic
AGENT_BROWSER_PROXY_BYPASS       — Proxy bypass hosts
```

### CLI Exit Codes

- 0: success
- 2: usage error
- 3: configuration error (missing model, invalid model)
- 4: control service startup failure
- 5: API request failure
