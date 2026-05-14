# Auto-Browser HTTP API: Programmatic Usage Guide

The auto-browser control service exposes a REST API on `http://127.0.0.1:4317` that lets you submit browser automation goals, approve tasks, execute them, cancel them, and stream real-time progress events via Server-Sent Events (SSE).

## Architecture Overview

The API follows a **three-step workflow**:

1. **Create a conversation** -- POST `/api/conversations`
2. **Submit a goal** -- POST `/api/conversations/:id/messages` -- the planner model drafts a plan; the task enters `draft` status
3. **Approve (blocking)** or **Run (non-blocking)** the task:
   - POST `/api/tasks/:id/approve` -- blocking; waits for the executor to finish, then returns the final task object
   - POST `/api/tasks/:id/run` -- non-blocking; returns immediately and streams execution progress via the SSE endpoint `GET /api/events`

If you use the non-blocking `run` path, you **must** connect to the SSE stream to observe progress and know when the task ends.

## API Base URL

```
http://127.0.0.1:4317/api
```

All endpoints return JSON with CORS headers (`access-control-allow-origin: *`).

## Endpoint Reference

### GET /api/state

Returns full service state: conversations, tasks, active task, and all recorded events.

**Response (200)**:
```json
{
  "conversations": [ /* Conversation[] */ ],
  "tasks": [ /* Task[] */ ],
  "activeTask": /* Task | null */,
  "events": [ /* TaskEvent[] */ ]
}
```

### GET /api/events

SSE stream of `TaskEvent` objects. The connection stays open and the server pushes events as `data: <JSON>\n\n` lines.

**Response headers**: `content-type: text/event-stream; charset=utf-8`, `cache-control: no-cache`, `connection: keep-alive`

**SSE event format**:
```
data: {"id":"evt_...","taskId":"task_...","type":"task.execution.iteration.started","createdAt":"...","source":"service","data":{"iteration":0,"url":"https://...","title":"..."}}

data: {"id":"evt_...","taskId":"task_...","type":"task.execution.llm.completion","createdAt":"...","source":"service","data":{"iteration":0,"content":"{\"action\":\"click_ref\"...}","model":"deepseek-v4-flash","usage":{"promptTokens":1200,"completionTokens":80,"totalTokens":1280}}}

data: {"id":"evt_...","taskId":"task_...","type":"task.execution.iteration.completed","createdAt":"...","source":"service","summary":{"action":"click_ref","label":"Click accept button","ref":"e5"},"data":{"iteration":0,"url":"https://...","title":"..."}}
```

**Event types**:

| Type | When | Key `data` fields |
|------|------|-------------------|
| `task.drafted` | Plan drafted | `summary`, `stepCount` |
| `task.ready` | Task approved | `stepCount` |
| `task.running` | Execution loop started | `currentStepIndex` |
| `task.execution.iteration.started` | Each iteration begins | `iteration`, `url`, `title` |
| `task.execution.llm.completion` | LLM response received | `iteration`, `content`, `model`, `usage` |
| `task.execution.iteration.completed` | Action applied | `iteration`, `url`, `title`; `summary` has the action |
| `task.completed` | Task finished successfully | `resultSummary` |
| `task.failed` | Execution error | `message` |
| `task.handoff` | Needs human intervention | `source`, `reason` |
| `task.cancelled` | Cancelled via API | (empty) |
| `task.replanned` | Resumed after handoff | `stepCount` |

### GET /api/browser-runtime/defaults

Detected browser runtime (local Chrome or managed Playwright Chromium).

**Response (200)**:
```json
{
  "platform": "linux",
  "mode": "managed",
  "browserFamily": "chromium",
  "executablePath": "",
  "profilePath": "",
  "detected": false,
  "message": "No local Chrome detected. Playwright Chromium will be downloaded automatically on first run."
}
```

### GET /api/runtime-config

Current planner/executor model configuration status.

**Response (200)**:
```json
{
  "plannerConfigured": true,
  "executorConfigured": true,
  "plannerModel": "deepseek-v4-pro",
  "executorModel": "deepseek-v4-flash",
  "modelTier": ""
}
```

### POST /api/conversations

Create a new conversation (container for messages and tasks).

**Request body**: none (empty body acceptable)

**Response (201)**:
```json
{
  "id": "conv_abc12345",
  "createdAt": "2026-05-11T...",
  "updatedAt": "2026-05-11T...",
  "title": null,
  "messages": []
}
```

### PATCH /api/conversations/:id

Update the conversation title.

**Request body**:
```json
{ "title": "My saved thread" }
```

**Response (200)**: updated Conversation object.

### DELETE /api/conversations/:id

Delete a conversation and all its tasks/events. **Blocked** (409) if a non-terminal task is currently active in the conversation.

**Response (204)**: no body.

### POST /api/conversations/:id/messages

Submit a user goal. The planner model drafts a plan; the task enters `draft` status.

**Request body**:
```json
{
  "content": "Go to example.com and tell me the page title",
  "plannerModel": "deepseek-v4-pro",
  "modelTier": "standard",
  "context": "optional extra context for the planner",
  "browserConfig": {
    "mode": "managed",
    "browserFamily": "chromium",
    "executablePath": "",
    "profilePath": "",
    "cookiesPath": "",
    "credentialsPath": "",
    "launchMode": "auto",
    "extensionEnabled": true,
    "previewEnabled": true,
    "cdpUrl": ""
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `content` | Yes | The natural-language goal |
| `plannerModel` | Yes | Model ID for the planner (e.g. `deepseek-v4-pro`) |
| `modelTier` | No | `standard`, `premium`, or `economy` |
| `context` | No | Extra context string passed to the LLM |
| `browserConfig.mode` | No | `"managed"` (Playwright) or `"system"` (local Chrome); defaults to `"managed"` |
| `browserConfig.browserFamily` | No | `"chromium"` or `"chrome"` |
| `browserConfig.executablePath` | No | Path to Chrome binary; if set, forces `mode: "system"` |
| `browserConfig.profilePath` | No | Persistent browser profile directory |
| `browserConfig.cookiesPath` | No | Path to a Playwright storage-state JSON file for cookies |
| `browserConfig.credentialsPath` | No | Path to `credentials.json` for login auto-fill |
| `browserConfig.launchMode` | No | `"auto"` (default), `"headless"`, or `"headed"` |
| `browserConfig.extensionEnabled` | No | Defaults to `true` |
| `browserConfig.previewEnabled` | No | Defaults to `true` |
| `browserConfig.cdpUrl` | No | Connect to existing browser via CDP instead of launching |

**Response (201)** -- the drafted task:
```json
{
  "id": "task_xyz78901",
  "conversationId": "conv_abc12345",
  "goal": "Go to example.com and tell me the page title",
  "context": null,
  "status": "draft",
  "planDraft": {
    "summary": "Navigate to example.com and extract the page title",
    "steps": [
      { "id": "plan-open", "title": "Open example.com", "intent": "Navigate to the site" },
      { "id": "plan-extract", "title": "Extract page title", "intent": "Read and return the title" }
    ]
  },
  "browserConfig": { /* ... */ },
  "plannerModel": "deepseek-v4-pro",
  "executorModel": null,
  "modelTier": "standard",
  "currentStepIndex": null,
  "resultSummary": null,
  "createdAt": "2026-05-11T...",
  "updatedAt": "2026-05-11T...",
  "handoffSource": null,
  "executionSource": null
}
```

### POST /api/tasks/:id/approve

Approve a drafted task and execute it **synchronously** (blocking). The HTTP response is delayed until the browser automation finishes.

**Request body**:
```json
{
  "executorModel": "deepseek-v4-flash",
  "modelTier": "standard"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `executorModel` | Yes | Model ID for the executor |
| `modelTier` | No | `standard`, `premium`, or `economy` |

**Response (200)** -- completed/failed/handoff task:
```json
{
  "id": "task_xyz78901",
  "status": "completed",
  "resultSummary": "Title: Example Domain",
  "planDraft": { /* ... */ },
  "currentStepIndex": 1,
  "executionSource": "service",
  "executorModel": "deepseek-v4-flash"
}
```

Note: If the client disconnects before the task finishes, the request is aborted and the task is cancelled serverside.

### POST /api/tasks/:id/run

Approve a drafted task and execute it **asynchronously** (non-blocking). Returns immediately while the browser task runs in the background. Progress events are emitted via the SSE stream.

**Request body** (same as approve):
```json
{
  "executorModel": "deepseek-v4-flash",
  "modelTier": "standard"
}
```

**Response (200)** -- the task in `running` status:
```json
{
  "id": "task_xyz78901",
  "status": "running",
  "currentStepIndex": 0,
  "executionSource": "service",
  "executorModel": "deepseek-v4-flash"
}
```

### POST /api/tasks/:id/cancel

Cancel a running/draft/ready/handoff task.

**Request body**: `{}` (empty object)

**Response (200)**: task with `status: "cancelled"`.

### POST /api/tasks/:id/handoff

Request human intervention for a task.

**Request body**:
```json
{ "source": "my-script" }
```

**Response (200)**: task with `status: "handoff"`.

### POST /api/tasks/:id/resume

Replan and resume a handed-off task.

**Request body**:
```json
{
  "plannerModel": "deepseek-v4-pro",
  "modelTier": "standard"
}
```

### POST /api/force-clear-active

Force-clear the active task lock. Useful if a previous task got stuck.

**Response (200)**: `{ "cleared": "task_xyz78901" }` or `{ "cleared": null }`.

## Task Status Lifecycle

```
draft --> ready --> running --> completed
                         |                 
                         +-----> handoff --> draft (after resume)
                         |
                         +-----> failed
                         |
                    (cancel) --> cancelled
```

## Task Object Shape

```typescript
interface Task {
  id: string;                    // "task_abc12345"
  conversationId: string;        // "conv_xyz78901"
  goal: string;                  // The user's natural-language goal
  context: string | null;        // Extra context passed to LLM
  status: "draft" | "ready" | "running" | "handoff" | "blocked" | "completed" | "failed" | "cancelled";
  planDraft: {
    summary: string;             // Plan summary
    steps: Array<{
      id: string;                // "plan-open"
      title: string;             // Human-readable step title
      intent: string;            // Step purpose
    }>;
  };
  browserConfig: BrowserRuntimeConfig;
  plannerModel: string | null;
  executorModel: string | null;
  modelTier: string | null;
  currentStepIndex: number | null;
  resultSummary: string | null;
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
  handoffSource: string | null;
  executionSource: "service" | "extension" | null;
}
```

## Error Response Format

All error responses follow this structure:
```json
{
  "error": {
    "module": "auto-browser.control-service",
    "file": "src/auto-browser/control-service.ts",
    "location": "submitUserMessage",
    "problem": "Planner model is required for this request."
  }
}
```

HTTP status codes:
- `400` -- invalid request (bad body, invalid launch mode)
- `404` -- conversation or task not found
- `409` -- conflict (only one active task at a time, cannot delete conversation with active task, cannot cancel terminal task)
- `500` -- internal error

## Environment Variables for the Control Service

Before using the API, the control service must be running. These env vars configure it:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_BROWSER_CONTROL_PORT` | `4317` | Port the server listens on |
| `AUTO_BROWSER_LLM_ROUTER_BASE_URL` | `http://127.0.0.1:18000` | LLM router base URL |
| `AUTO_BROWSER_LLM_ROUTER_API_KEY` | `""` | LLM router API key |
| `AUTO_BROWSER_PLANNER_MODEL` | `""` | Default planner model ID (e.g. `deepseek-v4-pro`) |
| `AUTO_BROWSER_EXECUTOR_MODEL` | `""` | Default executor model ID (e.g. `deepseek-v4-flash`) |
| `AUTO_BROWSER_MODEL_TIER` | `""` | Model tier: `standard`, `premium`, or `economy` |
| `AUTO_BROWSER_VISION_MODEL` | `""` | Vision-capable model for canvas/screenshot observations |
| `AUTO_BROWSER_EXECUTION_TIMEOUT_MS` | `120000` | Max execution time in ms |
| `AGENT_BROWSER_PROXY` | `""` | Proxy for browser traffic |
| `AGENT_BROWSER_PROXY_BYPASS` | `""` | Proxy bypass hosts |

## Full Workflow: Blocking (submit + approve)

This is the simplest path -- useful for scripts and automation:

1. `POST /api/conversations` -- get a `conversationId`
2. `POST /api/conversations/:id/messages` -- submit the goal; get a `taskId` with `status: "draft"`
3. `POST /api/tasks/:id/approve` -- the call **blocks** until the task completes, fails, or hands off
4. The response body is the final task object with `resultSummary`

**Limitation**: With the blocking path, you only see the final result. You do not get per-iteration progress or token usage breakdowns.

## Full Workflow: Non-Blocking (submit + run + SSE)

This path gives you real-time progress:

1. `POST /api/conversations` -- get a `conversationId`
2. `POST /api/conversations/:id/messages` -- submit the goal; get a `taskId`
3. Open an SSE connection to `GET /api/events` **before** or **immediately after** step 4
4. `POST /api/tasks/:id/run` -- returns immediately with `status: "running"`
5. Read SSE events until you see `task.completed`, `task.failed`, `task.handoff`, or `task.cancelled`
6. Close the SSE connection

## SSE Consumption Pattern

The SSE stream is standard `text/event-stream` with `data: <JSON>\n\n` lines. Use `fetch()` with a `ReadableStream` reader:

```typescript
const response = await fetch('http://127.0.0.1:4317/api/events');
const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  const parts = buffer.split('\n\n');
  buffer = parts.pop() ?? ''; // keep incomplete chunk

  for (const part of parts) {
    const dataLine = part.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    const event = JSON.parse(dataLine.slice(6));
    // event.type, event.data, event.summary, event.taskId, etc.
  }
}
```

Important notes:
- All connected SSE clients receive **all** events (not just for a specific task). Filter by `event.taskId` to isolate your task.
- Server events are emitted via Node.js `EventEmitter` inside `InMemoryControlService`, so the SSE stream reflects all state changes in real time regardless of which execution driver path is used.
- The SSE stream does NOT include the initial task draft; `task.drafted` and `task.ready` are emitted, but you already have those via the HTTP responses. The stream is primarily useful for `task.running` through `task.completed`/`task.failed`/`task.handoff`.

## Cancelling a Task

Send `POST /api/tasks/:id/cancel` with an empty body `{}`. The server sets `status: "cancelled"` and emits a `task.cancelled` event. The execution driver may continue for a short time (the cancel is cooperative -- the driver checks `AbortSignal` at iteration boundaries).

## Concurrency Constraint

Only **one task can be active** at a time (`running` or `ready` state). Attempting to approve or run a second task while one is active returns a `409 Conflict` error. Use `POST /api/force-clear-active` as a recovery escape hatch if a task gets stuck.
