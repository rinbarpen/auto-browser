# Using the Auto Browser HTTP API from Node.js

The auto-browser control service exposes a REST API at `http://127.0.0.1:4317` with CORS enabled. You can create conversations, submit goals (which the planner turns into task plans), approve tasks for execution, and stream real-time events via Server-Sent Events (SSE). Below is a complete walkthrough with code examples.

## Task Lifecycle

The API follows a three-phase lifecycle:

```
1. Submit (Create conversation + submit goal)
   -> Planner LLM drafts a plan -> Task status: "draft"

2. Approve (Approve the drafted task)
   -> Task status: "ready" -> "running"

3. Execute (Agent observes page, LLM decides actions)
   -> Max 20 iterations of observe-decide-act
   -> Real-time progress via SSE events
   -> Task status: "completed" | "handoff" | "failed"
```

## API Endpoints Used in the Flow

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/conversations` | Create a new conversation |
| POST | `/api/conversations/:id/messages` | Submit a goal (planner drafts a plan) |
| POST | `/api/tasks/:id/approve` | Approve & execute a task **(blocking)** |
| POST | `/api/tasks/:id/run` | Approve & execute a task **(non-blocking)** |
| GET | `/api/events` | SSE stream of real-time task events |

### Key Difference: `approve` vs `run`

- **`POST /api/tasks/:id/approve`** -- Blocks until the task completes, then returns the final task object. Use this for scripts that just want the result.
- **`POST /api/tasks/:id/run`** -- Returns immediately (status 200). The task runs in the background and emits events via SSE. Use this when you want to stream progress.

## REST API Request/Response Shapes

### 1. Create a Conversation

```
POST /api/conversations
Body: (empty)
Response 201:
{
  "id": "conv-abc123",
  "createdAt": "2026-05-11T...",
  "updatedAt": "2026-05-11T...",
  "title": null,
  "messages": []
}
```

### 2. Submit a Goal

```
POST /api/conversations/{convId}/messages
Content-Type: application/json

Body:
{
  "content": "open example.com and tell me the page title",
  "plannerModel": "deepseek-v4-pro",
  "browserConfig": {
    "launchMode": "headless"
  }
}

Response 201:
{
  "id": "task-xyz789",
  "conversationId": "conv-abc123",
  "goal": "open example.com and tell me the page title",
  "status": "draft",
  "planDraft": {
    "summary": "Navigate to example.com, observe the page, and extract the title",
    "steps": [
      { "id": "step-1", "title": "Navigate to example.com", "intent": "..." },
      { "id": "step-2", "title": "Extract and return the page title", "intent": "..." }
    ]
  },
  "browserConfig": { "mode": "managed", "launchMode": "headless", ... },
  "plannerModel": "deepseek-v4-pro",
  "executorModel": null,
  "currentStepIndex": null,
  "resultSummary": null,
  "createdAt": "2026-05-11T...",
  "updatedAt": "2026-05-11T..."
}
```

### 3. Approve and Execute (Blocking)

```
POST /api/tasks/{taskId}/approve
Content-Type: application/json

Body:
{
  "executorModel": "deepseek-v4-flash"
}

Response 200 (after execution completes):
{
  "id": "task-xyz789",
  "status": "completed",
  "resultSummary": "The page title is 'Example Domain'",
  ...
}
```

### 3b. Run (Non-Blocking)

```
POST /api/tasks/{taskId}/run
Content-Type: application/json

Body:
{
  "executorModel": "deepseek-v4-flash"
}

Response 200 (immediately):
{
  "id": "task-xyz789",
  "status": "ready",
  ...
}
// Then stream events via GET /api/events
```

## SSE Event Stream

Connect to `GET /api/events` to receive real-time task events. Events are formatted as:

```
data: {"id":"evt-...","taskId":"task-...","type":"task.running",...}

data: {"id":"evt-...","taskId":"task-...","type":"task.execution.iteration.started",...}
```

### Event Types You Will See

| Event | Meaning |
|-------|---------|
| `conversation.created` | New conversation created |
| `task.drafted` | Planner has drafted a plan, task is in `draft` status |
| `task.ready` | Task approved, executor model assigned |
| `task.running` | Execution loop started |
| `task.execution.iteration.started` | Each iteration begins (includes `data.url`, `data.title`) |
| `task.execution.llm.completion` | After LLM decides next action (includes `data.rawContent`, `data.tokens`) |
| `task.execution.iteration.completed` | After action is applied (includes `data.action`, `data.summary`) |
| `task.completed` | Task finished successfully (includes `data.resultSummary`) |
| `task.failed` | Task execution error |
| `task.handoff` | Task needs human intervention |
| `task.cancelled` | Task was cancelled via API |
| `task.replanned` | Task was replanned (on resume) |

## browserConfig Options

The `browserConfig` object in the submit request body supports:

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `"managed"` \| `"system"` | Browser mode (default: `"managed"`) |
| `launchMode` | `"auto"` \| `"headless"` \| `"headed"` | Window visibility |
| `browserFamily` | `"chrome"` \| `"chromium"` \| `"edge"` | Browser type |
| `executablePath` | string | Custom browser binary path |
| `profilePath` | string | Browser profile directory |
| `cookiesPath` | string | Path for cookie persistence |
| `credentialsPath` | string | Path to credentials JSON |
| `extensionEnabled` | boolean | Enable extension execution |
| `previewEnabled` | boolean | Enable preview |
| `cdpUrl` | string | Connect to existing browser via CDP |

## Models

The auto-browser uses a dual-LLM architecture:

- **Planner model** (submission phase): Drafts and revises execution plans
- **Executor model** (execution phase): Decides per-step browser actions

Common model tiers:

| Tier | Planner | Executor |
|------|---------|----------|
| `standard` | deepseek-v4-pro | deepseek-v4-flash |
| `premium` | deepseek-v4-pro | deepseek-v4-pro |
| `economy` | deepseek-v4-flash | deepseek-v4-flash |

Models are validated against the LLM router at `http://127.0.0.1:18000`. Use `GET /api/runtime-config` to check which models are configured.
