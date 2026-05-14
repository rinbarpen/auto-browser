# Auto-Browser API: Node.js Code Examples

All examples assume the control service is running on `http://127.0.0.1:4317` with a configured LLM router.

## Setup: Shared Helpers

```js
// api-helpers.js
// Requires Node.js 18+ (global fetch).

const BASE_URL = 'http://127.0.0.1:4317/api';

/**
 * Make an API request. Throws on non-2xx status with the structured error body.
 */
async function apiRequest(path, { method = 'GET', body, signal } = {}) {
  const init = {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    signal,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${path}`, init);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const problem = payload?.error?.problem ?? `HTTP ${response.status}`;
    throw new Error(`API error (${response.status}): ${problem}`);
  }

  return payload;
}

/**
 * Create a new conversation. Returns { id, createdAt, ... }.
 */
async function createConversation() {
  return apiRequest('/conversations', { method: 'POST' });
}

/**
 * Submit a goal to a conversation. Returns the drafted Task object.
 */
async function submitGoal(conversationId, goal, options = {}) {
  const {
    plannerModel = process.env.AUTO_BROWSER_PLANNER_MODEL ?? 'deepseek-v4-pro',
    modelTier = process.env.AUTO_BROWSER_MODEL_TIER,
    context = '',
    browserConfig = {},
  } = options;

  return apiRequest(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: {
      content: goal,
      plannerModel,
      modelTier: modelTier || undefined,
      context,
      browserConfig: {
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
        cookiesPath: '',
        credentialsPath: '',
        launchMode: 'auto',
        extensionEnabled: true,
        previewEnabled: true,
        cdpUrl: '',
        ...browserConfig,
      },
    },
  });
}

/**
 * Approve and run a task (BLOCKING -- waits for completion).
 */
async function approveTask(taskId, options = {}) {
  const {
    executorModel = process.env.AUTO_BROWSER_EXECUTOR_MODEL ?? 'deepseek-v4-flash',
    modelTier = process.env.AUTO_BROWSER_MODEL_TIER,
  } = options;

  return apiRequest(`/tasks/${taskId}/approve`, {
    method: 'POST',
    body: {
      executorModel,
      modelTier: modelTier || undefined,
    },
  });
}

/**
 * Run a task asynchronously (NON-BLOCKING -- returns immediately).
 */
async function runTask(taskId, options = {}) {
  const {
    executorModel = process.env.AUTO_BROWSER_EXECUTOR_MODEL ?? 'deepseek-v4-flash',
    modelTier = process.env.AUTO_BROWSER_MODEL_TIER,
  } = options;

  return apiRequest(`/tasks/${taskId}/run`, {
    method: 'POST',
    body: {
      executorModel,
      modelTier: modelTier || undefined,
    },
  });
}

/**
 * Cancel a running task.
 */
async function cancelTask(taskId) {
  return apiRequest(`/tasks/${taskId}/cancel`, {
    method: 'POST',
    body: {},
  });
}

/**
 * Connect to the SSE event stream. Yields parsed TaskEvent objects.
 *
 * IMPORTANT: Only one SSE connection should be opened per process.
 * All events for all tasks are broadcast on this single stream.
 * Filter by event.taskId to isolate your task.
 *
 * Returns an object with:
 *   - stream: AsyncIterable<TaskEvent>
 *   - close(): void  -- abort the connection
 */
function connectSSE(signal) {
  const controller = new AbortController();
  const linkedSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;

  const stream = (async function* () {
    const response = await fetch(`${BASE_URL}/events`, {
      signal: linkedSignal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on double newline (SSE event boundary)
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const dataLine = part
            .split('\n')
            .find((line) => line.startsWith('data: '));
          if (!dataLine) continue;

          try {
            yield JSON.parse(dataLine.slice(6));
          } catch {
            // Skip malformed event
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    stream,
    close: () => controller.abort(),
  };
}

module.exports = {
  apiRequest,
  createConversation,
  submitGoal,
  approveTask,
  runTask,
  cancelTask,
  connectSSE,
};
```

---

## Example 1: Blocking -- Submit, Approve, Wait for Result

The simplest integration. Submit a goal, approve it, and block until the browser task is done.

```js
// example-1-blocking.js
const { createConversation, submitGoal, approveTask } = require('./api-helpers');

async function main() {
  const goal = 'Go to https://example.com and tell me the page title';

  // Step 1: Create a conversation
  const conversation = await createConversation();
  console.log('Conversation:', conversation.id);

  // Step 2: Submit the goal (planner drafts a plan)
  const draft = await submitGoal(conversation.id, goal);
  console.log('Task drafted:', draft.id);
  console.log('Plan:', draft.planDraft.summary);
  for (const step of draft.planDraft.steps) {
    console.log(`  ${step.id}: ${step.title}`);
  }

  // Step 3: Approve + execute (BLOCKING)
  console.log('\nExecuting task...');
  const result = await approveTask(draft.id);

  console.log('\nResult:');
  console.log('  Status:', result.status);
  console.log('  Summary:', result.resultSummary);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
```

**Output example:**
```
Conversation: conv_abc12345
Task drafted: task_xyz78901
Plan: Navigate to example.com and extract the page title
  plan-open: Open example.com
  plan-extract: Extract page title

Executing task...

Result:
  Status: completed
  Summary: Title: Example Domain
```

---

## Example 2: Non-Blocking -- Submit, Run, Stream SSE Events

Get real-time progress updates: per-iteration starts, LLM completions, and action details.

```js
// example-2-nonblocking-sse.js
const {
  createConversation,
  submitGoal,
  runTask,
  cancelTask,
  connectSSE,
} = require('./api-helpers');

async function main() {
  const goal = 'Go to https://example.com and tell me the page title';

  // Step 1: Create conversation + submit goal
  const conversation = await createConversation();
  const draft = await submitGoal(conversation.id, goal);
  console.log('Task:', draft.id);

  // Step 2: Open SSE stream BEFORE running the task
  const sse = connectSSE();
  // We will consume events from sse.stream below

  // Step 3: Run the task (non-blocking)
  const running = await runTask(draft.id);
  console.log('Running... status:', running.status);

  // Step 4: Stream events, filtering for our task
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for await (const event of sse.stream) {
    // Filter to our task only
    if (event.taskId !== draft.id) continue;

    switch (event.type) {
      case 'task.execution.iteration.started':
        console.log(
          `\n[Iteration ${event.data.iteration + 1}] ${event.data.title || event.data.url}`
        );
        break;

      case 'task.execution.llm.completion':
        if (event.data.usage) {
          totalPromptTokens += event.data.usage.promptTokens ?? 0;
          totalCompletionTokens += event.data.usage.completionTokens ?? 0;
        }
        // The raw LLM JSON decision
        try {
          const action = JSON.parse(event.data.content);
          console.log(`  LLM decided: ${action.action} -- ${action.label ?? ''}`);
        } catch {
          console.log(`  LLM raw: ${event.data.content.slice(0, 80)}...`);
        }
        break;

      case 'task.execution.iteration.completed':
        if (event.summary) {
          console.log(
            `  Done: ${event.summary.action} -- ${event.summary.label}`
          );
        }
        console.log(`  URL: ${event.data.url}`);
        break;

      case 'task.completed':
        console.log(`\n=== COMPLETED ===`);
        console.log(`Result: ${event.data.resultSummary}`);
        console.log(
          `Tokens: prompt=${totalPromptTokens.toLocaleString()} ` +
          `completion=${totalCompletionTokens.toLocaleString()} ` +
          `total=${(totalPromptTokens + totalCompletionTokens).toLocaleString()}`
        );
        sse.close();
        return;

      case 'task.failed':
        console.log(`\n=== FAILED ===`);
        console.log(`Error: ${event.data.message}`);
        sse.close();
        return;

      case 'task.handoff':
        console.log(`\n=== HANDOFF ===`);
        console.log(`Reason: ${event.data.reason}`);
        sse.close();
        return;

      case 'task.cancelled':
        console.log(`\n=== CANCELLED ===`);
        sse.close();
        return;
    }
  }

  console.log('\nSSE stream ended.');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
```

---

## Example 3: Cancel a Task Mid-Execution

Set a timeout and cancel the task if it exceeds your budget.

```js
// example-3-cancel.js
const { createConversation, submitGoal, runTask, cancelTask, connectSSE } = require('./api-helpers');

async function main() {
  const conversation = await createConversation();
  const draft = await submitGoal(conversation.id, 'Search for the weather in Tokyo today');
  console.log('Task:', draft.id);

  const sse = connectSSE();
  const running = await runTask(draft.id);

  // Cancel if it takes longer than 15 seconds
  const cancelTimeout = setTimeout(async () => {
    console.log('\nTimeout! Cancelling task...');
    await cancelTask(draft.id);
  }, 15_000);

  for await (const event of sse.stream) {
    if (event.taskId !== draft.id) continue;

    if (event.type === 'task.execution.iteration.completed') {
      console.log(`Iteration ${event.data.iteration + 1}: ${event.summary?.label}`);
    }

    const terminalTypes = ['task.completed', 'task.failed', 'task.handoff', 'task.cancelled'];
    if (terminalTypes.includes(event.type)) {
      clearTimeout(cancelTimeout);
      console.log(`Task ended with status: ${event.type}`);
      sse.close();
      return;
    }
  }
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
```

---

## Example 4: Using a Specific Browser (System Chrome with Profile)

```js
// example-4-system-browser.js
const { createConversation, submitGoal, approveTask } = require('./api-helpers');

async function main() {
  const conversation = await createConversation();

  const draft = await submitGoal(conversation.id, 'Log into my dashboard and check notifications', {
    browserConfig: {
      mode: 'system',
      browserFamily: 'chrome',
      executablePath: '/usr/bin/google-chrome',
      profilePath: '/home/user/.config/google-chrome/Default',
      cookiesPath: '/home/user/.auto-browser/cookies.json',
      credentialsPath: '/home/user/.auto-browser/credentials.json',
      launchMode: 'headed', // Show the browser window
    },
  });

  console.log('Task drafted:', draft.id);

  // Blocking execution
  const result = await approveTask(draft.id);
  console.log('Result:', result.status, result.resultSummary);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
```

The `credentials.json` file format:
```json
{
  "sites": {
    "example.com": {
      "username": "myuser",
      "password": "mypassword"
    }
  }
}
```

Credentials are matched by hostname. The auto-fill detects login forms on early iterations using Chinese and English keywords for username/email/password fields.

---

## Example 5: Full Script with Error Handling

A production-ready script that handles timeouts, SSE reconnection, and structured error reporting.

```js
// example-5-production.js
const { createConversation, submitGoal, runTask, cancelTask, connectSSE } = require('./api-helpers');

const TASK_TIMEOUT_MS = 120_000; // 2 minutes
const MODEL_TIER = 'standard';

async function executeGoal(goal, options = {}) {
  const startTime = Date.now();

  // Step 1: Create conversation
  const conversation = await createConversation();

  // Step 2: Submit goal
  let draft;
  try {
    draft = await submitGoal(conversation.id, goal, {
      modelTier: MODEL_TIER,
      context: options.context,
      browserConfig: options.browserConfig,
    });
  } catch (err) {
    return { success: false, error: `Plan draft failed: ${err.message}` };
  }

  // Step 3: Connect SSE
  const abortController = new AbortController();
  let sse;
  try {
    sse = connectSSE(abortController.signal);
  } catch (err) {
    return { success: false, error: `SSE connection failed: ${err.message}` };
  }

  // Step 4: Run task (non-blocking)
  try {
    await runTask(draft.id, { modelTier: MODEL_TIER });
  } catch (err) {
    sse.close();
    return { success: false, error: `Task execution start failed: ${err.message}` };
  }

  // Step 5: Set a global timeout
  const timeoutHandle = setTimeout(() => {
    abortController.abort();
    cancelTask(draft.id).catch(() => {});
  }, options.timeoutMs ?? TASK_TIMEOUT_MS);

  // Step 6: Collect results from SSE
  const iterations = [];
  let result = null;
  let error = null;
  let totalTokens = { prompt: 0, completion: 0 };

  try {
    for await (const event of sse.stream) {
      if (event.taskId !== draft.id) continue;

      switch (event.type) {
        case 'task.execution.iteration.started':
          iterations.push({
            iteration: event.data.iteration,
            url: event.data.url,
            title: event.data.title,
          });
          break;

        case 'task.execution.llm.completion':
          if (event.data.usage) {
            totalTokens.prompt += event.data.usage.promptTokens ?? 0;
            totalTokens.completion += event.data.usage.completionTokens ?? 0;
          }
          break;

        case 'task.execution.iteration.completed':
          if (iterations.length > 0) {
            const last = iterations[iterations.length - 1];
            last.action = event.summary;
            last.url = event.data.url ?? last.url;
            last.title = event.data.title ?? last.title;
          }
          break;

        case 'task.completed':
          result = {
            summary: event.data.resultSummary,
            steps: draft.planDraft.steps.length,
            iterations: iterations.length,
          };
          break;

        case 'task.failed':
          error = event.data.message;
          break;

        case 'task.handoff':
          error = `Handoff: ${event.data.reason}`;
          break;

        case 'task.cancelled':
          error = 'Task was cancelled (timeout or manual)';
          break;
      }

      if (result || error) break;
    }
  } finally {
    clearTimeout(timeoutHandle);
    sse.close();
  }

  if (error) {
    return {
      success: false,
      error,
      taskId: draft.id,
      iterations,
      tokens: totalTokens,
      elapsedMs: Date.now() - startTime,
    };
  }

  return {
    success: true,
    taskId: draft.id,
    conversationId: conversation.id,
    goal,
    result: result.summary,
    planSteps: draft.planDraft.steps.length,
    iterations: result.iterations,
    actionHistory: iterations.filter((i) => i.action),
    tokens: totalTokens,
    elapsedMs: Date.now() - startTime,
  };
}

// --- Usage ---

async function main() {
  const outcome = await executeGoal(
    'Go to https://news.ycombinator.com and tell me the top story title',
    {
      timeoutMs: 60_000,
      browserConfig: { launchMode: 'headless' },
    }
  );

  console.log(JSON.stringify(outcome, null, 2));
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
```

**Output example (success):**
```json
{
  "success": true,
  "taskId": "task_abc12345",
  "conversationId": "conv_xyz78901",
  "goal": "Go to https://news.ycombinator.com and tell me the top story title",
  "result": "Title: Show HN: My new project (example.com)",
  "planSteps": 2,
  "iterations": 3,
  "actionHistory": [
    {
      "iteration": 0,
      "url": "https://news.ycombinator.com",
      "title": "Hacker News",
      "action": {
        "action": "navigate",
        "label": "Navigate to Hacker News",
        "url": "https://news.ycombinator.com"
      }
    }
  ],
  "tokens": {
    "prompt": 2450,
    "completion": 180
  },
  "elapsedMs": 4520
}
```

---

## Example 6: Polling State (No SSE)

If you cannot use SSE (e.g. serverless function), poll `GET /api/state`:

```js
// example-6-polling.js
const { createConversation, submitGoal, runTask, apiRequest } = require('./api-helpers');

async function executeWithPolling(goal, { pollIntervalMs = 1000, maxWaitMs = 120_000 } = {}) {
  const conversation = await createConversation();
  const draft = await submitGoal(conversation.id, goal);
  await runTask(draft.id);

  const deadline = Date.now() + maxWaitMs;
  const terminalStatuses = ['completed', 'failed', 'handoff', 'cancelled'];

  while (Date.now() < deadline) {
    const state = await apiRequest('/state');
    const task = state.tasks.find((t) => t.id === draft.id);

    if (!task || terminalStatuses.includes(task.status)) {
      return {
        status: task?.status ?? 'unknown',
        resultSummary: task?.resultSummary ?? null,
        events: state.events.filter((e) => e.taskId === draft.id),
      };
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error('Task timed out');
}

async function main() {
  const outcome = await executeWithPolling(
    'Go to https://example.com and tell me the title',
    { pollIntervalMs: 2000, maxWaitMs: 60_000 }
  );

  console.log('Status:', outcome.status);
  console.log('Result:', outcome.resultSummary);
  console.log('Events:', outcome.events.length);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
```
