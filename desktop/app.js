const API_BASE = 'http://127.0.0.1:4317/api';
const PREVIEW_WIDTH_STORAGE_KEY = 'auto-browser.previewWidth';
const MIN_CHAT_WIDTH = 340;
const MIN_PREVIEW_WIDTH = 420;
const DEFAULT_PREVIEW_RATIO = 0.62;

const state = {
  conversations: [],
  tasks: [],
  currentConversationId: null,
  currentTaskId: null,
  lastAssistantNotice: null,
  browserRuntimeDefaults: null,
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
  for (const step of task.planDraft.steps) {
    const item = document.createElement('li');
    item.innerHTML = `
      <span class="task-step-title">${step.title}</span>
      <span class="task-step-intent">${step.intent}</span>
    `;
    elements.taskSteps.appendChild(item);
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

function buildPreviewUrl() {
  return `./preview.html?embedded=1&t=${Date.now()}`;
}

function initializePreviewPanel() {
  if (!elements.previewFrame) return;
  elements.previewFrame.src = buildPreviewUrl();
}

function refreshPreviewPanel() {
  if (!elements.previewFrame) return;
  elements.previewFrame.src = buildPreviewUrl();
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
  events.onmessage = async () => {
    await fetchState();
  };
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

elements.openPreviewButton.addEventListener('click', refreshPreviewPanel);

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
