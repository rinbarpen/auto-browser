# Code Examples

## Example 1: Using curl (Shell Script)

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="http://127.0.0.1:4317"

# 1. Create a conversation
echo "Creating conversation..."
CONV=$(curl -sS -X POST "$BASE/api/conversations")
CONV_ID=$(echo "$CONV" | jq -r '.id')
echo "Conversation ID: $CONV_ID"

# 2. Submit a goal
echo "Submitting goal..."
TASK=$(curl -sS -X POST "$BASE/api/conversations/$CONV_ID/messages" \
  -H 'content-type: application/json' \
  -d '{
    "content": "find the pricing page and summarize the plans",
    "plannerModel": "deepseek-v4-pro",
    "browserConfig": {
      "launchMode": "headless"
    }
  }')
TASK_ID=$(echo "$TASK" | jq -r '.id')
echo "Task ID: $TASK_ID"
echo "Status: $(echo "$TASK" | jq -r '.status')"

# 3. Print the plan
echo ""
echo "Plan: $(echo "$TASK" | jq -r '.planDraft.summary')"
echo "$TASK" | jq -r '.planDraft.steps[] | "  - \(.title)"'

# 4. Stream SSE events in background
echo ""
echo "Connecting to SSE event stream..."
curl -sS -N "$BASE/api/events" &
SSE_PID=$!

# 5. Run the task (non-blocking)
echo "Running task..."
curl -sS -X POST "$BASE/api/tasks/$TASK_ID/run" \
  -H 'content-type: application/json' \
  -d '{"executorModel": "deepseek-v4-flash"}' > /dev/null

# 6. Wait for events (let SSE stream run for a bit, or watch for task.completed)
# In production, you'd parse the SSE stream and exit when you see task.completed
sleep 30

# 7. Check final state
echo ""
echo "Checking final state..."
curl -sS "$BASE/api/state" | jq '{activeTask, tasks: [.tasks[] | {id, status, resultSummary}]}'

# Cleanup SSE connection
kill $SSE_PID 2>/dev/null || true
```

## Example 2: Node.js with fetch() -- Blocking Approve

```js
// auto-browser-client-blocking.js
// Uses the blocking /approve endpoint -- waits for task completion.

const BASE = 'http://127.0.0.1:4317';

async function createConversation() {
  const res = await fetch(`${BASE}/api/conversations`, { method: 'POST' });
  if (!res.ok) throw new Error(`Create conversation failed: ${res.status}`);
  return res.json();
}

async function submitGoal(conversationId, goal, options = {}) {
  const res = await fetch(`${BASE}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: goal,
      plannerModel: options.plannerModel ?? 'deepseek-v4-pro',
      browserConfig: {
        launchMode: options.launchMode ?? 'headless',
        mode: options.mode ?? 'managed',
        ...(options.cookiesPath ? { cookiesPath: options.cookiesPath } : {}),
        ...(options.credentialsPath ? { credentialsPath: options.credentialsPath } : {}),
      },
      context: options.context ?? '',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Submit goal failed: ${res.status} -- ${err.error?.problem ?? 'unknown'}`);
  }
  return res.json();
}

async function approveAndWait(taskId, options = {}) {
  // The /approve endpoint blocks until the task completes or fails.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);

  try {
    const res = await fetch(`${BASE}/api/tasks/${taskId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        executorModel: options.executorModel ?? 'deepseek-v4-flash',
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Approve failed: ${res.status} -- ${err.error?.problem ?? 'unknown'}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Main
async function main() {
  try {
    // 1. Create conversation
    const conv = await createConversation();
    console.log(`Conversation: ${conv.id}`);

    // 2. Submit goal
    const task = await submitGoal(conv.id, 'open example.com and tell me the page title');
    console.log(`Task: ${task.id} -- Status: ${task.status}`);
    console.log(`Plan: ${task.planDraft.summary}`);
    for (const step of task.planDraft.steps) {
      console.log(`  - ${step.title}`);
    }

    // 3. Approve and execute (blocks until done)
    console.log('Executing...');
    const result = await approveAndWait(task.id, { timeoutMs: 60_000 });
    console.log(`Status: ${result.status}`);
    console.log(`Result: ${result.resultSummary ?? 'No result summary'}`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
```

## Example 3: Node.js with fetch() -- Non-blocking Run + SSE Events

```js
// auto-browser-client-sse.js
// Uses the non-blocking /run endpoint and streams events via SSE.

const BASE = 'http://127.0.0.1:4317';

async function createConversation() {
  const res = await fetch(`${BASE}/api/conversations`, { method: 'POST' });
  if (!res.ok) throw new Error(`Create conversation failed: ${res.status}`);
  return res.json();
}

async function submitGoal(conversationId, goal, options = {}) {
  const res = await fetch(`${BASE}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: goal,
      plannerModel: options.plannerModel ?? 'deepseek-v4-pro',
      browserConfig: {
        launchMode: options.launchMode ?? 'headless',
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Submit goal failed: ${res.status} -- ${err.error?.problem ?? 'unknown'}`);
  }
  return res.json();
}

async function startTask(taskId, options = {}) {
  const res = await fetch(`${BASE}/api/tasks/${taskId}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      executorModel: options.executorModel ?? 'deepseek-v4-flash',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Run failed: ${res.status} -- ${err.error?.problem ?? 'unknown'}`);
  }
  return res.json();
}

/**
 * Stream SSE events for a specific task.
 * Resolves when the task reaches a terminal state (completed/failed/handoff/cancelled)
 * or when the timeout fires.
 */
async function streamEvents(taskId, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(`${BASE}/api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });

  if (!res.ok) {
    throw new Error(`SSE connection failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return new Promise((resolve, reject) => {
    function processLines() {
      // Split buffer on double-newline (SSE message boundary)
      const parts = buffer.split('\n\n');
      // The last part may be incomplete; keep it in buffer
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // Parse lines: "data: {json}"
        for (const line of trimmed.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6);
          try {
            const event = JSON.parse(jsonStr);

            // Only log events for our task
            if (event.taskId !== taskId) continue;

            const eventType = event.type;
            // Always log the event type
            console.log(`[${eventType}]`, new Date().toISOString());

            // Log extra detail for key events
            switch (eventType) {
              case 'task.drafted':
                console.log('  Plan:', event.data?.planDraft?.summary ?? '');
                break;
              case 'task.execution.iteration.started':
                console.log(`  URL: ${event.data?.url ?? '?'} -- ${event.data?.title ?? ''}`);
                break;
              case 'task.execution.llm.completion':
                console.log(`  Tokens: prompt=${event.data?.tokens?.promptTokens ?? '?'} completion=${event.data?.tokens?.completionTokens ?? '?'}`);
                break;
              case 'task.execution.iteration.completed':
                console.log(`  Action: ${event.data?.summary?.action ?? event.data?.action ?? '?'}`);
                break;
              case 'task.completed':
                console.log(`\n=== TASK COMPLETED ===`);
                console.log(`  Result: ${event.data?.resultSummary ?? 'No result summary'}`);
                clearTimeout(timeout);
                resolve(event);
                return;
              case 'task.failed':
                console.log(`\n=== TASK FAILED ===`);
                clearTimeout(timeout);
                resolve(event);
                return;
              case 'task.handoff':
                console.log(`\n=== TASK HANDED OFF (human intervention needed) ===`);
                clearTimeout(timeout);
                resolve(event);
                return;
              case 'task.cancelled':
                console.log(`\n=== TASK CANCELLED ===`);
                clearTimeout(timeout);
                resolve(event);
                return;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    }

    async function readLoop() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log('SSE stream ended');
            clearTimeout(timeout);
            resolve(null);
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          processLines();
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          console.log('SSE stream timed out');
        } else {
          console.error('SSE read error:', err.message);
        }
        clearTimeout(timeout);
        resolve(null);
      }
    }

    readLoop();
  });
}

// Main
async function main() {
  try {
    // 1. Create conversation
    const conv = await createConversation();
    console.log(`Conversation: ${conv.id}`);

    // 2. Submit goal
    const task = await submitGoal(conv.id, 'open example.com and tell me the page title');
    console.log(`Task: ${task.id} -- Status: ${task.status}`);
    console.log(`Plan: ${task.planDraft.summary}\n`);

    // 3. Start task (non-blocking)
    await startTask(task.id, { executorModel: 'deepseek-v4-flash' });
    console.log('Task started. Streaming events...\n');

    // 4. Stream events until task completes
    const finalEvent = await streamEvents(task.id, 60_000);

    console.log('\nDone.');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
```

## Example 4: TypeScript with ReadableStream Parsing

```ts
// auto-browser-client.ts
// TypeScript version with explicit types for request/response shapes.

const BASE = 'http://127.0.0.1:4317';

// --- Type Definitions (matching the control service interfaces) ---

type TaskStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'handoff'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface PlanStep {
  id: string;
  title: string;
  intent: string;
}

interface PlanDraft {
  summary: string;
  steps: PlanStep[];
}

interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  messages: ConversationMessage[];
}

interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

interface BrowserConfig {
  mode?: 'managed' | 'system';
  launchMode?: 'auto' | 'headless' | 'headed';
  browserFamily?: 'chrome' | 'chromium' | 'edge';
  executablePath?: string;
  profilePath?: string;
  cookiesPath?: string;
  credentialsPath?: string;
  extensionEnabled?: boolean;
  previewEnabled?: boolean;
  cdpUrl?: string;
}

interface Task {
  id: string;
  conversationId: string;
  goal: string;
  context: string | null;
  status: TaskStatus;
  planDraft: PlanDraft;
  browserConfig: BrowserConfig;
  plannerModel: string | null;
  executorModel: string | null;
  modelTier: string | null;
  currentStepIndex: number | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
  handoffSource: string | null;
  executionSource: 'service' | 'extension' | null;
}

interface ActionSummary {
  action: string;
  message: string;
  label: string;
}

interface TaskEvent {
  id: string;
  taskId: string;
  type:
    | 'conversation.created'
    | 'task.drafted'
    | 'task.ready'
    | 'task.running'
    | 'task.handoff'
    | 'task.replanned'
    | 'task.completed'
    | 'task.failed'
    | 'task.cancelled'
    | 'task.execution.action_started'
    | 'task.execution.action_completed'
    | 'task.execution.blocked'
    | 'task.execution.completed'
    | 'task.execution.iteration.started'
    | 'task.execution.llm.completion'
    | 'task.execution.iteration.completed';
  createdAt: string;
  source: 'service' | 'extension';
  summary?: ActionSummary;
  data: Record<string, unknown>;
}

interface SubmitGoalInput {
  content: string;
  plannerModel?: string;
  modelTier?: string;
  context?: string;
  browserConfig?: BrowserConfig;
}

interface ApproveInput {
  executorModel?: string;
  modelTier?: string;
}

// --- API Client ---

class AutoBrowserClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://127.0.0.1:4317') {
    this.baseUrl = baseUrl;
  }

  async createConversation(): Promise<Conversation> {
    const res = await fetch(`${this.baseUrl}/api/conversations`, { method: 'POST' });
    if (!res.ok) throw new Error(`Create conversation failed: ${res.status}`);
    return res.json() as Promise<Conversation>;
  }

  async submitGoal(conversationId: string, input: SubmitGoalInput): Promise<Task> {
    const res = await fetch(`${this.baseUrl}/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Submit failed: ${res.status} -- ${(err as { error?: { problem?: string } }).error?.problem ?? 'unknown'}`);
    }
    return res.json() as Promise<Task>;
  }

  /** Blocking approve -- waits for task to complete */
  async approveTask(taskId: string, input: ApproveInput = {}): Promise<Task> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${taskId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Approve failed: ${res.status} -- ${(err as { error?: { problem?: string } }).error?.problem ?? 'unknown'}`);
    }
    return res.json() as Promise<Task>;
  }

  /** Non-blocking run -- returns immediately, events streamed via SSE */
  async runTask(taskId: string, input: ApproveInput = {}): Promise<Task> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${taskId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Run failed: ${res.status} -- ${(err as { error?: { problem?: string } }).error?.problem ?? 'unknown'}`);
    }
    return res.json() as Promise<Task>;
  }

  /** Cancel a running task */
  async cancelTask(taskId: string): Promise<Task> {
    const res = await fetch(`${this.baseUrl}/api/tasks/${taskId}/cancel`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cancel failed: ${res.status}`);
    }
    return res.json() as Promise<Task>;
  }

  /** Open an SSE event stream. Calls onEvent for each parsed event. */
  async streamEvents(taskId: string, onEvent: (event: TaskEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/events`, {
      headers: { accept: 'text/event-stream' },
      signal,
    });

    if (!res.ok) {
      throw new Error(`SSE connection failed: ${res.status}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        for (const line of part.trim().split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as TaskEvent;
            if (event.taskId === taskId) {
              onEvent(event);
            }
          } catch { /* skip malformed */ }
        }
      }
    }
  }
}

// --- Usage ---

async function main() {
  const client = new AutoBrowserClient('http://127.0.0.1:4317');

  // Create conversation
  const conv = await client.createConversation();
  console.log(`Conversation: ${conv.id}`);

  // Submit goal
  const task = await client.submitGoal(conv.id, {
    content: 'navigate to example.com and extract the page title',
    plannerModel: 'deepseek-v4-pro',
    browserConfig: { launchMode: 'headless' },
  });
  console.log(`Task: ${task.id}, Status: ${task.status}`);
  console.log(`Plan: ${task.planDraft.summary}`);

  // Start task (non-blocking)
  await client.runTask(task.id, { executorModel: 'deepseek-v4-flash' });
  console.log('Task started -- streaming events...\n');

  // Stream events
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60_000);

  await client.streamEvents(task.id, (event) => {
    console.log(`[${event.type}]`, new Date().toISOString());

    switch (event.type) {
      case 'task.drafted':
        console.log(`  Plan summary: ${event.data.planDraft?.summary ?? ''}`);
        break;
      case 'task.execution.iteration.started':
        console.log(`  URL: ${event.data.url ?? '?'}`);
        break;
      case 'task.execution.iteration.completed':
        console.log(`  Action: ${event.data.summary?.action ?? event.data.action ?? '?'}`);
        break;
      case 'task.completed':
        console.log(`\n=== COMPLETED: ${event.data.resultSummary ?? 'No summary'} ===`);
        ac.abort(); // Stop streaming
        break;
      case 'task.failed':
        console.log(`\n=== FAILED ===`);
        ac.abort();
        break;
    }
  }, ac.signal);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

## Example 5: Common browserConfig Variations

```js
// Headless managed browser (default -- Playwright Chromium auto-downloaded)
const browserConfig = {
  launchMode: 'headless',
};

// Headed system Chrome (use your local Chrome)
const browserConfig = {
  mode: 'system',
  launchMode: 'headed',
  executablePath: '/usr/bin/google-chrome',
};

// With cookie persistence (reuse login sessions)
const browserConfig = {
  launchMode: 'headless',
  cookiesPath: './my-site-cookies.json',
};

// With credentials auto-fill
const browserConfig = {
  launchMode: 'headless',
  credentialsPath: './my-creds.json',
};

// Connect to an already-running Chrome via CDP
const browserConfig = {
  mode: 'system',
  cdpUrl: 'http://127.0.0.1:9222',
};
```

## Error Handling

The API returns structured errors with `error.problem` describing the issue:

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

Key error HTTP status codes:
- **400**: Invalid request (bad JSON, bad browser config, etc.)
- **404**: Conversation or task not found
- **409**: Conflict (e.g., only one active task at a time)
- **500**: Server error (missing model config, LLM router unavailable, etc.)
