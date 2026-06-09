const API_BASE = 'http://127.0.0.1:4317/api';
const PREVIEW_WIDTH_STORAGE_KEY = 'auto-browser.previewWidth';
const MIN_CHAT_WIDTH = 340;
const MIN_PREVIEW_WIDTH = 420;
const DEFAULT_PREVIEW_RATIO = 0.62;

const state = {
  conversations: [],
  tasks: [],
  goals: [],
  currentConversationId: null,
  currentTaskId: null,
  lastAssistantNotice: null,
  browserRuntimeDefaults: null,
  iterations: [],
  sessionTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
};

const elements = {
  connectionStatus: document.getElementById('connectionStatus'),
  conversationTitle: document.getElementById('conversationTitle'),
  messageThread: document.getElementById('messageThread'),
  taskTitle: document.getElementById('taskTitle'),
  taskSummary: document.getElementById('taskSummary'),
  taskSteps: document.getElementById('taskSteps'),
  promptInput: document.getElementById('promptInput'),
  sendButton: document.getElementById('sendButton'),
  approveButton: document.getElementById('approveButton'),
  handoffButton: document.getElementById('handoffButton'),
  resumeButton: document.getElementById('resumeButton'),
  openPreviewButton: document.getElementById('openPreviewButton'),
  previewPanel: document.getElementById('previewPanel'),
  previewFrame: document.getElementById('previewFrame'),
  previewResizeHandle: document.getElementById('previewResizeHandle'),
  executablePath: document.getElementById('executablePath'),
  profilePath: document.getElementById('profilePath'),
  runtimeDefaultsMessage: document.getElementById('runtimeDefaultsMessage'),
  extensionEnabled: document.getElementById('extensionEnabled'),
  previewEnabled: document.getElementById('previewEnabled'),
  // Iterations
  iterationsRail: document.getElementById('iterationsRail'),
  iterationsProgress: document.getElementById('iterationsProgress'),
  iterationsList: document.getElementById('iterationsList'),
  iterationsTokens: document.getElementById('iterationsTokens'),
  // Goals
  goalsList: document.getElementById('goalsList'),
  newGoalButton: document.getElementById('newGoalButton'),
};

async function ensureManagedConversationId(conversations, createConversation) {
  if (conversations.length === 0) {
    const created = await createConversation();
    return created.id;
  }

  const sorted = [...conversations].sort((left, right) => {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });

  return sorted[0].id;
}

function getBrowserConfig() {
  const executablePath = elements.executablePath.value.trim();
  const mode = executablePath ? 'system' : 'managed';
  return {
    mode,
    browserFamily:
      mode === 'managed' ? 'chromium' : state.browserRuntimeDefaults?.browserFamily ?? 'chrome',
    executablePath,
    profilePath: elements.profilePath.value.trim(),
    extensionEnabled: elements.extensionEnabled.checked,
    previewEnabled: elements.previewEnabled.checked,
  };
}

let lastStreamPort = 9223;
let lastTaskStatus = null;

async function fetchState() {
  const response = await fetch(`${API_BASE}/state`);
  if (!response.ok) {
    throw new Error(`State request failed: ${response.status}`);
  }
  const payload = await response.json();
  state.conversations = payload.conversations;
  state.tasks = payload.tasks;
  state.currentConversationId = await ensureManagedConversationId(
    state.conversations,
    createConversationRecord
  );

  // Capture stream port from API
  if (typeof payload.streamPort === 'number') {
    lastStreamPort = payload.streamPort;
  }

  // Fetch goals
  try {
    const goalsRes = await fetch(`${API_BASE}/goals`);
    if (goalsRes.ok) {
      state.goals = await goalsRes.json();
    }
  } catch { /* ignore */ }

  // Refresh preview when task transitions to running
  const activeTask = payload.activeTask || null;
  if (activeTask && activeTask.status === 'running' && lastTaskStatus !== 'running') {
    refreshPreviewPanel(lastStreamPort);
  }
  lastTaskStatus = activeTask?.status ?? null;

  render();
}

async function loadBrowserRuntimeDefaults() {
  const response = await fetch(`${API_BASE}/browser-runtime/defaults`);
  if (!response.ok) {
    throw new Error(`Browser runtime defaults request failed: ${response.status}`);
  }

  const defaults = await response.json();
  state.browserRuntimeDefaults = defaults;
  if (!elements.executablePath.value.trim()) {
    elements.executablePath.value = defaults.executablePath ?? '';
    elements.executablePath.placeholder = defaults.detected
      ? 'Browser executable path'
      : 'Enter Chrome executable path or leave blank for managed Chromium';
  }

  if (!elements.profilePath.value.trim()) {
    elements.profilePath.value = defaults.profilePath ?? '';
  }

  elements.runtimeDefaultsMessage.textContent = defaults.message;
}

function getCurrentConversation() {
  return state.conversations.find((item) => item.id === state.currentConversationId) ?? null;
}

function getCurrentTask() {
  if (state.currentTaskId) {
    return state.tasks.find((item) => item.id === state.currentTaskId) ?? null;
  }
  if (!state.currentConversationId) {
    return null;
  }
  return (
    [...state.tasks]
      .reverse()
      .find((task) => task.conversationId === state.currentConversationId) ?? null
  );
}

function createMessageCard(role, content) {
  const card = document.createElement('div');
  card.className = `message-card ${role === 'assistant' ? 'assistant' : 'user'}`;
  const roleLabel = document.createElement('div');
  roleLabel.className = 'message-role';
  roleLabel.textContent = role;
  const body = document.createElement('p');
  body.textContent = content;
  card.append(roleLabel, body);
  return card;
}

function renderAssistantResultMessage(task) {
  if (task?.status !== 'completed' || !task.resultSummary) {
    return;
  }

  const card = createMessageCard('assistant', `Execution result: ${task.resultSummary}`);
  elements.messageThread.appendChild(card);
}

function renderAssistantDraftMessage(task) {
  if (!task?.planDraft?.summary || task.status === 'completed') {
    return;
  }

  const card = createMessageCard('assistant', `Draft ready: ${task.planDraft.summary}`);
  elements.messageThread.appendChild(card);
}

function renderMessages(conversation, task) {
  elements.messageThread.innerHTML = '';
  if (!conversation) {
    elements.messageThread.appendChild(
      createMessageCard(
        'assistant',
        'Create a conversation, describe a browser goal, and the service will draft steps before anything runs.'
      )
    );
    return;
  }

  for (const message of conversation.messages) {
    elements.messageThread.appendChild(createMessageCard(message.role, message.content));
  }

  const hasResultMessage = conversation.messages.some((message) => {
    return message.role === 'assistant' && message.content === task?.resultSummary;
  });
  const hasDraftMessage = conversation.messages.some((message) => {
    return message.role === 'assistant' && message.content === `Draft ready: ${task?.planDraft?.summary ?? ''}`;
  });
  if (!hasDraftMessage) {
    renderAssistantDraftMessage(task);
  }
  if (!hasResultMessage) {
    renderAssistantResultMessage(task);
  }
  if (state.lastAssistantNotice) {
    elements.messageThread.appendChild(createMessageCard('assistant', state.lastAssistantNotice));
  }
}

function renderTask(task) {
  if (!task) {
    elements.taskTitle.textContent = 'No draft yet';
    elements.taskSummary.textContent = 'Send a goal to generate a task draft.';
    elements.taskSteps.innerHTML = '';
    elements.approveButton.disabled = true;
    elements.handoffButton.disabled = true;
    elements.resumeButton.disabled = true;
    return;
  }

  elements.taskTitle.textContent = `Task ${task.status}`;
  elements.taskSummary.textContent = task.resultSummary ?? task.planDraft.summary;
  elements.taskSteps.innerHTML = '';
  const isDraft = task.status === 'draft';
  for (const step of task.planDraft.steps) {
    const item = document.createElement('li');
    item.className = 'task-step-item';
    if (isDraft) {
      item.innerHTML = `
        <input class="task-step-title-input" value="${escapeAttr(step.title)}" data-step-id="${step.id}" data-field="title" placeholder="Step title" />
        <input class="task-step-intent-input" value="${escapeAttr(step.intent)}" data-step-id="${step.id}" data-field="intent" placeholder="Step intent" />
        <button class="ghost-button step-save-btn" data-step-id="${step.id}" style="font-size:0.8em">Save</button>
      `;
    } else {
      item.innerHTML = `
        <span class="task-step-title">${escapeHtml(step.title)}</span>
        <span class="task-step-intent">${escapeHtml(step.intent)}</span>
      `;
    }
    elements.taskSteps.appendChild(item);
  }

  // Handle plan edit saves
  if (isDraft) {
    elements.taskSteps.querySelectorAll('.step-save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const stepId = btn.dataset.stepId;
        const titleInput = elements.taskSteps.querySelector(`input[data-step-id="${stepId}"][data-field="title"]`);
        const intentInput = elements.taskSteps.querySelector(`input[data-step-id="${stepId}"][data-field="intent"]`);
        const edits = [{
          stepId,
          title: titleInput ? titleInput.value : undefined,
          intent: intentInput ? intentInput.value : undefined,
        }];
        try {
          const res = await fetch(`${API_BASE}/plans/${task.planId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ edits }),
          });
          if (res.ok) {
            await fetchState();
          } else {
            const err = await res.json();
            alert('Failed to save: ' + (err.error || 'unknown error'));
          }
        } catch (err) {
          alert('Failed to save: ' + err.message);
        }
      });
    });
  }

  elements.approveButton.disabled = task.status !== 'draft';
  elements.handoffButton.disabled = !['ready', 'running', 'draft', 'blocked'].includes(task.status);
  elements.resumeButton.disabled = task.status !== 'handoff';
}

function render() {
  const conversation = getCurrentConversation();
  const task = getCurrentTask();
  elements.conversationTitle.textContent = conversation
    ? `Auto-managed conversation ${conversation.id.slice(-4)}`
    : 'Auto-managed conversation';
  renderMessages(conversation, task);
  renderTask(task);
  renderIterations();
  renderGoals();
}

function renderGoals() {
  if (!elements.goalsList) return;
  elements.goalsList.innerHTML = '';
  if (!state.goals || state.goals.length === 0) {
    elements.goalsList.innerHTML = '<p style="color:var(--text-dim);font-size:0.85em;margin:0">No goals yet. Create one to get started.</p>';
    return;
  }
  for (const goal of state.goals) {
    const card = document.createElement('div');
    card.className = 'goal-card';
    const statusClass = goal.status === 'active' ? 'status-active' : goal.status === 'archived' ? 'status-archived' : '';
    card.innerHTML = `
      <div class="goal-card-header">
        <span class="goal-status-dot ${statusClass}"></span>
        <span class="goal-title">${escapeHtml(goal.title)}</span>
      </div>
      <div class="goal-card-meta">${goal.status} · ${goal.createdAt.slice(0, 10)}</div>
    `;
    card.addEventListener('click', () => {
      // Find the task associated with this goal
      const task = state.tasks.find(t => t.goalId === goal.id);
      if (task) {
        state.currentTaskId = task.id;
        render();
      }
    });
    elements.goalsList.appendChild(card);
  }
}

function createGoalFromDialog() {
  const title = prompt('Enter goal title:');
  if (!title || !title.trim()) return;
  const description = prompt('Enter goal description (optional):');
  fetch(`${API_BASE}/goals`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: title.trim(), description: description?.trim() || null }),
  })
    .then(r => r.json())
    .then(() => fetchState())
    .catch(err => console.error('Failed to create goal:', err));
}

function renderIterations() {
  const its = state.iterations;
  const task = getCurrentTask();

  if (!task || its.length === 0) {
    if (elements.iterationsRail) elements.iterationsRail.hidden = true;
    return;
  }

  if (elements.iterationsRail) elements.iterationsRail.hidden = false;

  // Progress
  if (elements.iterationsProgress) {
    if (task.currentStepIndex != null && task.planDraft?.steps?.length) {
      const total = task.planDraft.steps.length;
      elements.iterationsProgress.textContent = `Step ${task.currentStepIndex + 1}/${total} · ${its.length} iter`;
    } else {
      elements.iterationsProgress.textContent = `${its.length} iterations`;
    }
  }

  // Cards
  if (elements.iterationsList) {
    elements.iterationsList.innerHTML = '';
    const showIts = its.slice(-15);
    for (const iter of showIts) {
      const card = document.createElement('div');
      card.className = 'iter-card';

      // Header
      const header = document.createElement('div');
      header.className = 'iter-card-header';
      header.innerHTML = `
        <span class="iter-card-num">#${iter.iteration}</span>
        <span class="iter-card-url" title="${escapeAttr(iter.url || iter.title || '')}">${escapeHtml(iter.url || iter.title || '(page)')}</span>
        ${iter.tokenUsage ? `<span class="iter-card-tokens">P:${iter.tokenUsage.promptTokens} C:${iter.tokenUsage.completionTokens}</span>` : ''}
      `;
      card.appendChild(header);

      // Body
      const body = document.createElement('div');
      body.className = 'iter-card-body';
      body.innerHTML = `
        <span class="iter-phase-label"><span class="iter-phase-dot observe"></span>Observe</span>
        <span class="iter-phase-value">${escapeHtml(iter.title || iter.url || '...')}</span>
        <span class="iter-phase-label"><span class="iter-phase-dot decide"></span>Decide</span>
        <span class="iter-phase-value">${escapeHtml(iter.actionLabel || '...')}</span>
      `;
      card.appendChild(body);

      // Error
      if (iter.error) {
        const err = document.createElement('div');
        err.className = 'iter-card-error';
        err.textContent = iter.error;
        card.appendChild(err);
      }

      // LLM completion
      if (iter.rawCompletion) {
        const llm = document.createElement('div');
        llm.className = 'iter-card-llm';
        llm.textContent = iter.rawCompletion.slice(0, 100);
        llm.title = 'Click to expand';
        llm.addEventListener('click', () => {
          try {
            const p = JSON.parse(iter.rawCompletion);
            alert(JSON.stringify(p, null, 2));
          } catch {
            alert(iter.rawCompletion);
          }
        });
        card.appendChild(llm);
      }

      elements.iterationsList.appendChild(card);
    }
  }

  // Token summary
  if (elements.iterationsTokens) {
    const st = state.sessionTokens;
    if (st.totalTokens > 0) {
      elements.iterationsTokens.hidden = false;
      elements.iterationsTokens.textContent = `Session tokens — P:${st.promptTokens} C:${st.completionTokens} T:${st.totalTokens}`;
    } else {
      elements.iterationsTokens.hidden = true;
    }
  }
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function createConversationRecord() {
  const response = await fetch(`${API_BASE}/conversations`, { method: 'POST' });
  if (!response.ok) {
    throw new Error('Failed to create conversation');
  }
  return response.json();
}

async function sendPrompt() {
  state.currentConversationId = await ensureManagedConversationId(
    state.conversations,
    createConversationRecord
  );

  const response = await fetch(`${API_BASE}/conversations/${state.currentConversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: elements.promptInput.value.trim(),
      browserConfig: getBrowserConfig(),
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? 'Failed to submit prompt');
  }

  state.currentTaskId = payload.id;
  state.lastAssistantNotice = null;
  state.iterations = [];
  state.sessionTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  elements.promptInput.value = '';
  await fetchState();
}

async function approveTask() {
  const task = getCurrentTask();
  if (!task) return;
  const response = await fetch(`${API_BASE}/tasks/${task.id}/approve`, { method: 'POST' });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? 'Failed to approve task');
  }
  state.currentTaskId = payload.id;
  state.lastAssistantNotice = null;
  state.iterations = [];
  state.sessionTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  await fetchState();
}

async function enterHandoff() {
  const task = getCurrentTask();
  if (!task) return;
  const response = await fetch(`${API_BASE}/tasks/${task.id}/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'desktop_shell' }),
  });
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.error ?? 'Failed to hand off task');
  }
  state.lastAssistantNotice = null;
  await fetchState();
}

async function resumeTask() {
  const task = getCurrentTask();
  if (!task) return;
  const response = await fetch(`${API_BASE}/tasks/${task.id}/resume`, { method: 'POST' });
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.error ?? 'Failed to resume task');
  }
  state.lastAssistantNotice = null;
  await fetchState();
}

function showAssistantError(error, fallbackMessage) {
  state.lastAssistantNotice = error instanceof Error ? error.message : fallbackMessage;
  render();
}

function buildPreviewUrl(streamPort) {
  return `./preview.html?embedded=1&streamPort=${streamPort}&t=${Date.now()}`;
}

function initializePreviewPanel() {
  if (!elements.previewFrame) return;
  // Default to 9223 until we get the real port from API
  elements.previewFrame.src = buildPreviewUrl(9223);
}

function refreshPreviewPanel(streamPort) {
  if (!elements.previewFrame) return;
  elements.previewFrame.src = buildPreviewUrl(streamPort);
  elements.previewPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}

function getNumberStyleValue(element, propertyName) {
  if (!element) return 0;
  const value = Number.parseFloat(window.getComputedStyle(element).getPropertyValue(propertyName));
  return Number.isFinite(value) ? value : 0;
}

function getPreviewResizeBounds() {
  const shell = document.querySelector('.app-shell');
  if (!shell || !elements.previewResizeHandle) {
    return null;
  }

  const shellRect = shell.getBoundingClientRect();
  const sidebarRect = elements.executablePath.closest('.sidebar')?.getBoundingClientRect();
  const handleRect = elements.previewResizeHandle.getBoundingClientRect();
  const columnGap = getNumberStyleValue(shell, 'column-gap') || 18;
  const horizontalPadding =
    getNumberStyleValue(shell, 'padding-left') + getNumberStyleValue(shell, 'padding-right');
  const sidebarWidth = sidebarRect?.width ?? 280;
  const reservedWidth = sidebarWidth + handleRect.width + horizontalPadding + columnGap * 3;
  const maxWidth = Math.max(
    MIN_PREVIEW_WIDTH,
    shellRect.width - reservedWidth - MIN_CHAT_WIDTH
  );

  return {
    minWidth: MIN_PREVIEW_WIDTH,
    maxWidth,
  };
}

function clampPreviewWidth(width) {
  const bounds = getPreviewResizeBounds();
  if (!bounds) return width;
  return Math.min(Math.max(width, bounds.minWidth), bounds.maxWidth);
}

function setPreviewWidth(width, persist = false) {
  const clampedWidth = clampPreviewWidth(width);
  document.documentElement.style.setProperty('--preview-width', `${Math.round(clampedWidth)}px`);

  if (persist) {
    localStorage.setItem(PREVIEW_WIDTH_STORAGE_KEY, String(Math.round(clampedWidth)));
  }
}

function getDefaultPreviewWidth() {
  const bounds = getPreviewResizeBounds();
  if (!bounds) return MIN_PREVIEW_WIDTH;
  return bounds.minWidth + (bounds.maxWidth - bounds.minWidth) * DEFAULT_PREVIEW_RATIO;
}

function initializePreviewResize() {
  const handle = elements.previewResizeHandle;
  if (!handle || !elements.previewPanel) return;

  const storedWidth = Number.parseFloat(localStorage.getItem(PREVIEW_WIDTH_STORAGE_KEY) ?? '');
  setPreviewWidth(Number.isFinite(storedWidth) ? storedWidth : getDefaultPreviewWidth());

  let previewRightEdge = 0;
  let columnGap = 18;

  handle.addEventListener('pointerdown', (event) => {
    if (window.matchMedia('(max-width: 1380px)').matches) return;
    previewRightEdge = elements.previewPanel.getBoundingClientRect().right;
    columnGap = getNumberStyleValue(document.querySelector('.app-shell'), 'column-gap') || 18;
    handle.classList.add('dragging');
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  handle.addEventListener('pointermove', (event) => {
    if (!handle.classList.contains('dragging')) return;
    setPreviewWidth(previewRightEdge - event.clientX - columnGap);
  });

  handle.addEventListener('pointerup', (event) => {
    if (!handle.classList.contains('dragging')) return;
    handle.classList.remove('dragging');
    handle.releasePointerCapture(event.pointerId);
    setPreviewWidth(previewRightEdge - event.clientX - columnGap, true);
  });

  window.addEventListener('resize', () => {
    const currentWidth = elements.previewPanel.getBoundingClientRect().width;
    setPreviewWidth(currentWidth);
  });
}

function connectEvents() {
  const events = new EventSource(`${API_BASE}/events`);
  events.onopen = () => {
    elements.connectionStatus.textContent = 'Connected';
  };
  events.onerror = () => {
    elements.connectionStatus.textContent = 'Disconnected';
  };
  events.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      handleSSEEvent(parsed);
    } catch { /* skip invalid JSON */ }
    fetchState().catch(() => {});
  };
}

function handleSSEEvent(event) {
  const isActive = event.taskId === state.currentTaskId;
  if (!isActive) return;

  switch (event.type) {
    case 'task.execution.iteration.started': {
      const data = event.data || {};
      state.iterations = [
        ...state.iterations,
        {
          iteration: data.iteration ?? state.iterations.length,
          url: data.url ?? '',
          title: data.title ?? '',
          actionLabel: event.summary?.label ?? undefined,
          actionDetails: event.summary?.url ?? undefined,
          rawCompletion: undefined,
          tokenUsage: undefined,
          error: undefined,
        },
      ];
      renderIterations();
      break;
    }
    case 'task.execution.llm.completion': {
      const data = event.data || {};
      const updated = state.iterations.map((it) => ({ ...it }));
      const last = updated[updated.length - 1];
      if (last) {
        if (data.content) last.rawCompletion = data.content;
        if (data.usage) last.tokenUsage = data.usage;
      }
      state.iterations = updated;
      if (data.usage) {
        state.sessionTokens = {
          promptTokens: state.sessionTokens.promptTokens + (data.usage.promptTokens || 0),
          completionTokens: state.sessionTokens.completionTokens + (data.usage.completionTokens || 0),
          totalTokens: state.sessionTokens.totalTokens + (data.usage.totalTokens || 0),
        };
      }
      renderIterations();
      break;
    }
    case 'task.execution.iteration.completed': {
      const updated = state.iterations.map((it) => ({ ...it }));
      const last = updated[updated.length - 1];
      if (last && event.summary) {
        if (event.summary.label) last.actionLabel = event.summary.label;
        if (event.summary.url != null) last.actionDetails = event.summary.url;
        if (event.summary.error) last.error = event.summary.error;
      }
      state.iterations = updated;
      renderIterations();
      break;
    }
    case 'task.drafted':
    case 'task.running':
    case 'task.completed':
    case 'task.failed':
    case 'task.cancelled':
    case 'task.handoff':
      // fetchState handles status changes
      break;
  }
}

elements.sendButton.addEventListener('click', () => {
  sendPrompt().catch((error) => {
    showAssistantError(error, 'Failed to submit prompt');
  });
});

elements.approveButton.addEventListener('click', () => {
  approveTask().catch((error) => {
    showAssistantError(error, 'Failed to approve task');
  });
});

elements.handoffButton.addEventListener('click', () => {
  enterHandoff().catch((error) => {
    showAssistantError(error, 'Failed to hand off task');
  });
});

elements.resumeButton.addEventListener('click', () => {
  resumeTask().catch((error) => {
    showAssistantError(error, 'Failed to resume task');
  });
});

elements.openPreviewButton.addEventListener('click', () => refreshPreviewPanel(lastStreamPort));

if (elements.newGoalButton) {
  elements.newGoalButton.addEventListener('click', createGoalFromDialog);
}

initializePreviewPanel();
initializePreviewResize();

loadBrowserRuntimeDefaults()
  .catch(() => {
    elements.runtimeDefaultsMessage.textContent =
      'Browser runtime defaults are unavailable. Enter a Chrome path or leave it blank for managed Chromium.';
  })
  .then(fetchState)
  .catch(() => {
    elements.connectionStatus.textContent = 'Service unavailable';
  })
  .finally(() => {
    connectEvents();
  });
