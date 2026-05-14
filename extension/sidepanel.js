import {
  buildChatMessages,
  filterTaskEvents,
  formatPageContext,
  getConversationTitle,
  getActiveLlmPreset,
  normalizeLlmPreferences,
  resolveInitialConversationId,
  selectCurrentConversation,
  selectCurrentTask,
  selectNextConversationIdAfterDelete,
  sortConversationsByRecent,
} from './sidepanel-state.js';

const API_BASE = 'http://127.0.0.1:4317/api';
const STORAGE_KEY = 'sidepanelPreferences';
const DEFAULT_PREFERENCES = {
  providerPresets: [],
  llmPresets: [],
  activeLlmPresetId: null,
  selectedConversationId: null,
};

const els = {
  pageContext: document.getElementById('pageContext'),
  conversationTitle: document.getElementById('conversationTitle'),
  conversationMeta: document.getElementById('conversationMeta'),
  goalInput: document.getElementById('goalInput'),
  plannerModelInput: document.getElementById('plannerModelInput'),
  executorModelInput: document.getElementById('executorModelInput'),
  providerPresetSelect: document.getElementById('providerPresetSelect'),
  providerPresetNameInput: document.getElementById('providerPresetNameInput'),
  providerInput: document.getElementById('providerInput'),
  providerBaseUrlInput: document.getElementById('providerBaseUrlInput'),
  providerApiKeyInput: document.getElementById('providerApiKeyInput'),
  plannerProviderPresetSelect: document.getElementById('plannerProviderPresetSelect'),
  executorProviderPresetSelect: document.getElementById('executorProviderPresetSelect'),
  newProviderPresetButton: document.getElementById('newProviderPresetButton'),
  deleteProviderPresetButton: document.getElementById('deleteProviderPresetButton'),
  llmPresetSelect: document.getElementById('llmPresetSelect'),
  llmPresetNameInput: document.getElementById('llmPresetNameInput'),
  newLlmPresetButton: document.getElementById('newLlmPresetButton'),
  saveLlmPresetButton: document.getElementById('saveLlmPresetButton'),
  deleteLlmPresetButton: document.getElementById('deleteLlmPresetButton'),
  messageThread: document.getElementById('messageThread'),
  taskTitle: document.getElementById('taskTitle'),
  taskSummary: document.getElementById('taskSummary'),
  timelineStrip: document.getElementById('timelineStrip'),
  sendButton: document.getElementById('sendButton'),
  refreshButton: document.getElementById('refreshButton'),
  permissionButton: document.getElementById('permissionButton'),
  resumeButton: document.getElementById('resumeButton'),
  handoffButton: document.getElementById('handoffButton'),
  shell: document.querySelector('.panel-shell'),
  llmSettingsButton: document.getElementById('llmSettingsButton'),
  llmSettingsPanel: document.getElementById('llmSettingsPanel'),
  llmSettingsCloseButton: document.getElementById('llmSettingsCloseButton'),
  menuToggleButton: document.getElementById('menuToggleButton'),
  menuNav: document.getElementById('menuNav'),
  overlayBackdrop: document.getElementById('overlayBackdrop'),
  overlayPanel: document.getElementById('overlayPanel'),
  overlayTitle: document.getElementById('overlayTitle'),
  overlayCloseButton: document.getElementById('overlayCloseButton'),
  historyView: document.getElementById('historyView'),
  runView: document.getElementById('runView'),
  detailsView: document.getElementById('detailsView'),
  newConversationButton: document.getElementById('newConversationButton'),
  conversationList: document.getElementById('conversationList'),
};

let runtimeConfig = null;
let currentSession = null;
let currentConversation = null;
let currentTask = null;
let currentState = { conversations: [], tasks: [], events: [] };
let transientNotice = null;
let preferences = { ...DEFAULT_PREFERENCES };
let menuOpen = false;
let llmSettingsOpen = false;
let activeMenuView = 'history';

initialize().catch(renderError);

async function initialize() {
  preferences = await loadPreferences();
  applyStoredUiState();
  await refreshPageContext();
  await loadRuntimeConfig();
  await refreshAll({ includePageContext: false, initializeSelection: true });
  setInterval(() => {
    refreshAll({ includePageContext: false }).catch(() => undefined);
  }, 1500);
}

els.sendButton.addEventListener('click', () => {
  startTask().catch(renderError);
});
els.goalInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    startTask().catch(renderError);
  }
});
document.addEventListener('keydown', handleGlobalShortcut);
els.refreshButton.addEventListener('click', () => {
  refreshAll().catch(renderError);
});
els.permissionButton.addEventListener('click', () => {
  if (!currentSession?.origin) return;
  chrome.runtime.sendMessage({ type: 'request_permission', origin: currentSession.origin }, handleBackgroundResponse);
});
els.resumeButton.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'resume_extension' }, handleBackgroundResponse);
});
els.handoffButton.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'handoff_task' }, handleBackgroundResponse);
});
els.llmSettingsButton.addEventListener('click', () => {
  toggleLlmSettingsPanel();
});
els.menuToggleButton.addEventListener('click', () => {
  toggleMenu();
});
els.menuNav.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-menu-view]') : null;
  if (!button) {
    return;
  }
  setActiveMenuView(button.dataset.menuView);
});
els.overlayCloseButton.addEventListener('click', closeOverlay);
els.overlayBackdrop.addEventListener('click', closeOverlay);
els.llmSettingsCloseButton.addEventListener('click', closeOverlay);
els.newConversationButton.addEventListener('click', () => {
  createConversation().catch(renderError);
});
els.llmPresetSelect.addEventListener('change', () => {
  llmSettingsOpen = true;
  activateLlmPreset(els.llmPresetSelect.value).catch(renderError);
});
els.newLlmPresetButton.addEventListener('click', () => {
  llmSettingsOpen = true;
  createLlmPreset().catch(renderError);
});
els.saveLlmPresetButton.addEventListener('click', () => {
  llmSettingsOpen = true;
  saveActiveLlmPreset().catch(renderError);
});
els.deleteLlmPresetButton.addEventListener('click', () => {
  llmSettingsOpen = true;
  deleteActiveLlmPreset().catch(renderError);
});
els.providerPresetSelect.addEventListener('change', renderLlmSettings);
els.newProviderPresetButton.addEventListener('click', () => {
  llmSettingsOpen = true;
  createProviderPreset().catch(renderError);
});
els.deleteProviderPresetButton.addEventListener('click', () => {
  llmSettingsOpen = true;
  deleteSelectedProviderPreset().catch(renderError);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'sidepanel_event') {
    return;
  }

  if (message.payload?.type === 'session_updated') {
    currentSession = message.payload.session;
    syncDerivedState();
    render();
    return;
  }

  if (message.payload?.type === 'permission_required') {
    currentSession = { ...(currentSession || {}), origin: message.payload.origin, status: 'blocked' };
    syncDerivedState();
    render();
  }
});

async function startTask() {
  const goal = els.goalInput.value.trim();
  if (!goal) {
    throw new Error('Message is required.');
  }

  const activePreset = getActiveLlmPreset(preferences);
  const plannerModel = activePreset.roles.planner.model.trim();
  const executorModel = activePreset.roles.executor.model.trim();
  if (!plannerModel || !executorModel) {
    throw new Error('Planner and executor models are required.');
  }

  transientNotice = null;
  renderMessages();

  let selectedConversationId = preferences.selectedConversationId;
  if (!selectedConversationId) {
    const createdConversation = await fetchJson('/conversations', { method: 'POST' });
    selectedConversationId = createdConversation.id;
    await savePreferences({ selectedConversationId });
  }

  const response = await chrome.runtime.sendMessage({
    type: 'start_task',
    payload: {
      goal,
      plannerModel,
      executorModel,
      conversationId: selectedConversationId,
    },
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Failed to send message');
  }

  els.goalInput.value = '';
  transientNotice = null;
  currentSession = response.session ?? currentSession;
  if (response.session?.conversationId && response.session.conversationId !== preferences.selectedConversationId) {
    await savePreferences({ selectedConversationId: response.session.conversationId });
  }
  await refreshAll({ includePageContext: false });
}

async function refreshPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  els.pageContext.textContent = formatPageContext(tab);
}

async function loadRuntimeConfig() {
  runtimeConfig = await fetchJson('/runtime-config');
  const activePreset = getActiveLlmPreset(preferences);
  if (!activePreset.roles.planner.model && runtimeConfig.plannerModel) {
    activePreset.roles.planner.model = runtimeConfig.plannerModel;
  }
  if (!activePreset.roles.executor.model && runtimeConfig.executorModel) {
    activePreset.roles.executor.model = runtimeConfig.executorModel;
  }
  await savePreferences({ llmPresets: preferences.llmPresets });
  renderLlmSettings();
}

async function refreshAll(options = {}) {
  const { includePageContext = true, initializeSelection = false } = options;
  if (includePageContext) {
    await refreshPageContext();
  }

  const [sessionResponse, state] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'get_session' }),
    fetchJson('/state'),
  ]);

  if (!sessionResponse?.ok) {
    throw new Error(responseError(sessionResponse, 'Failed to fetch extension session'));
  }

  currentSession = sessionResponse.session;
  currentState = {
    conversations: Array.isArray(state.conversations) ? state.conversations : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    events: Array.isArray(state.events) ? state.events : [],
  };

  const selectedConversationId = initializeSelection
    ? resolveInitialConversationId(
        currentState.conversations,
        currentSession?.conversationId ?? null,
        preferences.selectedConversationId
      )
    : currentState.conversations.some(
          (conversation) => conversation.id === preferences.selectedConversationId
        )
      ? preferences.selectedConversationId
      : resolveInitialConversationId(
          currentState.conversations,
          null,
          preferences.selectedConversationId
        );

  if (selectedConversationId !== preferences.selectedConversationId) {
    await savePreferences({ selectedConversationId });
  }

  syncDerivedState();
  render();
}

function syncDerivedState() {
  currentConversation = selectCurrentConversation(
    currentState.conversations,
    preferences.selectedConversationId
  );
  currentTask = selectCurrentTask(currentState.tasks, currentConversation?.id ?? null);
}

function render() {
  renderOverlayState();
  renderLlmPanelState();
  renderConversationHeader();
  renderConversationList();
  renderMessages();
  renderSession();
  renderTimelineStrip();
}

function renderOverlayState() {
  const views = {
    history: els.historyView,
    run: els.runView,
    details: els.detailsView,
  };
  const labels = {
    history: 'History',
    run: 'Run',
    details: 'Details',
  };

  els.shell.classList.toggle('overlay-open', menuOpen);
  els.overlayPanel.setAttribute('aria-hidden', String(!menuOpen));
  els.menuToggleButton.setAttribute('aria-expanded', String(menuOpen));
  els.overlayBackdrop.hidden = !menuOpen && !llmSettingsOpen;
  els.overlayTitle.textContent = labels[activeMenuView];

  for (const [viewName, viewElement] of Object.entries(views)) {
    const active = menuOpen && activeMenuView === viewName;
    viewElement.setAttribute('aria-hidden', String(!active));
    viewElement.classList.toggle('active', active);
  }

  for (const button of els.menuNav.querySelectorAll('[data-menu-view]')) {
    const active = button.dataset.menuView === activeMenuView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  }
}

function renderLlmPanelState() {
  els.shell.classList.toggle('llm-settings-open', llmSettingsOpen);
  els.llmSettingsPanel.setAttribute('aria-hidden', String(!llmSettingsOpen));
  els.llmSettingsButton.setAttribute('aria-expanded', String(llmSettingsOpen));
  els.overlayBackdrop.hidden = !menuOpen && !llmSettingsOpen;
}

function renderConversationHeader() {
  if (!currentConversation) {
    els.conversationTitle.textContent = 'Persistent chat';
    els.conversationMeta.textContent = 'Select a conversation or start a new one.';
    return;
  }

  els.conversationTitle.textContent = getConversationTitle(currentConversation);
  const meta = [
    currentTask ? `${currentTask.status} task` : 'No task yet',
    currentConversation.updatedAt
      ? `Updated ${new Date(currentConversation.updatedAt).toLocaleString()}`
      : null,
  ].filter(Boolean);
  els.conversationMeta.textContent = meta.join(' • ');
}

function renderConversationList() {
  const conversations = sortConversationsByRecent(currentState.conversations);
  els.conversationList.innerHTML = '';

  if (conversations.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'conversation-empty';
    empty.textContent = 'No saved conversations yet.';
    els.conversationList.appendChild(empty);
    return;
  }

  for (const conversation of conversations) {
    els.conversationList.appendChild(createConversationItem(conversation));
  }
}

function renderMessages() {
  const messages = buildChatMessages(currentConversation, currentTask, transientNotice);
  els.messageThread.innerHTML = '';

  for (const message of messages) {
    els.messageThread.appendChild(createMessageCard(message.role, message.content, message.tone));
  }

  els.messageThread.scrollTop = els.messageThread.scrollHeight;
}

function renderSession() {
  if (!currentTask) {
    els.taskTitle.textContent = 'No active session';
    els.taskSummary.textContent = currentConversation
      ? 'This conversation has no task yet.'
      : 'Send a message to create or continue an extension conversation.';
    els.permissionButton.disabled = true;
    els.resumeButton.disabled = true;
    els.handoffButton.disabled = true;
    return;
  }

  const selectedTaskIsSessionTask = currentSession?.taskId && currentSession.taskId === currentTask.id;
  els.taskTitle.textContent = `${currentTask.status} • ${currentTask.id}`;
  const summaryParts = [
    currentTask.resultSummary,
    currentTask.planDraft?.summary,
    selectedTaskIsSessionTask ? currentSession?.stepLabel : null,
    selectedTaskIsSessionTask
      ? currentSession?.origin
        ? `Origin ${currentSession.origin}`
        : 'Will continue from the current page'
      : 'Viewing saved conversation state',
    selectedTaskIsSessionTask ? currentSession?.lastError : null,
  ].filter(Boolean);
  els.taskSummary.textContent =
    summaryParts.join(' • ') || 'Running in a dedicated automation tab.';

  els.permissionButton.disabled =
    !selectedTaskIsSessionTask || !currentSession?.origin || currentSession.permission === 'granted';
  els.resumeButton.disabled =
    !selectedTaskIsSessionTask || !['blocked', 'handoff'].includes(currentSession?.status);
  els.handoffButton.disabled =
    !selectedTaskIsSessionTask || !['running', 'blocked'].includes(currentSession?.status);
}

function renderTimelineStrip() {
  const events = filterTaskEvents(currentState.events, currentTask?.id ?? null);
  els.timelineStrip.innerHTML = '';

  if (events.length === 0) {
    const item = document.createElement('div');
    item.className = 'timeline-empty';
    item.textContent = 'No execution events yet.';
    els.timelineStrip.appendChild(item);
    return;
  }

  for (const event of events) {
    els.timelineStrip.appendChild(createTimelineCard(event));
  }
}

function createConversationItem(conversation) {
  const item = document.createElement('li');
  item.className = `conversation-item${
    conversation.id === preferences.selectedConversationId ? ' active' : ''
  }`;

  const row = document.createElement('div');
  row.className = 'conversation-row';

  const main = document.createElement('div');
  main.className = 'conversation-main';

  const titleButton = document.createElement('button');
  titleButton.className = 'secondary wide';
  titleButton.textContent = getConversationTitle(conversation);
  titleButton.addEventListener('click', () => {
    selectConversation(conversation.id).catch(renderError);
  });

  const badges = document.createElement('div');
  badges.className = 'conversation-badges';
  if (conversation.id === preferences.selectedConversationId) {
    badges.appendChild(createBadge('Current'));
  }
  if (currentSession?.conversationId === conversation.id && currentSession?.taskId) {
    badges.appendChild(createBadge('In progress'));
  }

  const updated = document.createElement('div');
  updated.className = 'conversation-updated';
  updated.textContent = `Updated ${new Date(conversation.updatedAt ?? conversation.createdAt).toLocaleString()}`;

  main.append(titleButton, badges, updated);

  const actions = document.createElement('div');
  actions.className = 'conversation-actions';

  const renameButton = document.createElement('button');
  renameButton.className = 'secondary small';
  renameButton.textContent = 'Rename';
  renameButton.addEventListener('click', () => {
    renameConversation(conversation).catch(renderError);
  });

  const deleteButton = document.createElement('button');
  deleteButton.className = 'secondary small danger';
  deleteButton.textContent = 'Delete';
  deleteButton.addEventListener('click', () => {
    deleteConversation(conversation).catch(renderError);
  });

  actions.append(renameButton, deleteButton);
  row.append(main, actions);
  item.appendChild(row);
  return item;
}

function createBadge(label) {
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = label;
  return badge;
}

function createMessageCard(role, content, tone = 'default') {
  const card = document.createElement('div');
  const roleClass = role === 'assistant' || role === 'system' ? 'assistant' : 'user';
  card.className = `message-card ${roleClass}${tone === 'notice' ? ' notice' : ''}`;

  const roleLabel = document.createElement('div');
  roleLabel.className = 'message-role';
  roleLabel.textContent = tone === 'notice' ? 'notice' : role;

  const body = document.createElement('p');
  body.className = 'message-body';
  body.textContent = content;

  card.append(roleLabel, body);
  return card;
}

function createTimelineCard(event) {
  const item = document.createElement('article');
  item.className = 'timeline-card';
  const summary = event.summary?.label ? `${event.summary.label} • ` : '';
  const title = document.createElement('strong');
  title.textContent = event.type;
  const time = document.createElement('span');
  time.textContent = new Date(event.createdAt).toLocaleTimeString();
  const detail = document.createElement('p');
  detail.textContent = `${summary}${event.data?.message || event.data?.resultSummary || event.data?.observationSummary || ''}` || 'Event recorded.';
  item.append(title, time, detail);
  return item;
}

async function createConversation() {
  const conversation = await fetchJson('/conversations', { method: 'POST' });
  await savePreferences({ selectedConversationId: conversation.id });
  closeOverlay();
  await refreshAll({ includePageContext: false });
}

async function selectConversation(conversationId) {
  transientNotice = null;
  await savePreferences({ selectedConversationId: conversationId });
  closeOverlay();
  syncDerivedState();
  render();
}

async function renameConversation(conversation) {
  const nextTitle = window.prompt('Rename conversation', conversation.title ?? getConversationTitle(conversation));
  if (nextTitle === null) {
    return;
  }
  await fetchJson(`/conversations/${conversation.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: nextTitle.trim() || null }),
  });
  await refreshAll({ includePageContext: false });
}

async function deleteConversation(conversation) {
  const confirmed = window.confirm(`Delete "${getConversationTitle(conversation)}"? This cannot be undone.`);
  if (!confirmed) {
    return;
  }
  const nextConversationId = selectNextConversationIdAfterDelete(currentState.conversations, conversation.id);
  await fetchJson(`/conversations/${conversation.id}`, { method: 'DELETE' });
  await savePreferences({ selectedConversationId: nextConversationId });
  if (currentSession?.conversationId === conversation.id) {
    currentSession = { ...currentSession, conversationId: nextConversationId };
  }
  await refreshAll({ includePageContext: false });
}

function toggleMenu() {
  menuOpen = !menuOpen;
  if (menuOpen) {
    llmSettingsOpen = false;
  }
  if (menuOpen) {
    activeMenuView = 'history';
  }
  renderOverlayState();
  renderLlmPanelState();
}

function setActiveMenuView(nextView) {
  if (!['history', 'run', 'details'].includes(nextView)) {
    return;
  }
  activeMenuView = nextView;
  menuOpen = true;
  llmSettingsOpen = false;
  renderOverlayState();
  renderLlmPanelState();
}

function toggleLlmSettingsPanel() {
  llmSettingsOpen = !llmSettingsOpen;
  if (llmSettingsOpen) {
    menuOpen = false;
  }
  renderOverlayState();
  renderLlmPanelState();
}

function closeOverlay(options = {}) {
  const restoreLlmFocus = options.restoreFocus && llmSettingsOpen;
  menuOpen = false;
  llmSettingsOpen = false;
  renderOverlayState();
  renderLlmPanelState();
  if (options.restoreFocus) {
    (restoreLlmFocus ? els.llmSettingsButton : els.menuToggleButton).focus();
  }
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  const editable = target.closest('textarea, input, select, [contenteditable]');
  if (!editable) {
    return false;
  }

  if (editable.hasAttribute('contenteditable')) {
    return editable.getAttribute('contenteditable') !== 'false';
  }

  return true;
}

function handleGlobalShortcut(event) {
  if (event.key === 'Escape' && (menuOpen || llmSettingsOpen)) {
    event.preventDefault();
    closeOverlay({ restoreFocus: true });
    return;
  }

  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isEditableTarget(event.target)) {
    return;
  }

  const menuViewsByShortcut = {
    1: 'history',
    2: 'run',
    3: 'details',
    4: 'details',
  };
  const key = event.key.toLowerCase();

  if (key === 'm') {
    event.preventDefault();
    toggleMenu();
    return;
  }

  if (key === 'l') {
    event.preventDefault();
    toggleLlmSettingsPanel();
    return;
  }

  if (key === 't') {
    event.preventDefault();
    els.timelineStrip.focus();
    return;
  }

  if (key === 'i') {
    event.preventDefault();
    els.goalInput.focus();
    return;
  }

  const nextView = menuViewsByShortcut[key];
  if (nextView) {
    event.preventDefault();
    setActiveMenuView(nextView);
  }
}

function handleBackgroundResponse(response) {
  if (!response?.ok) {
    renderError(new Error(responseError(response, 'Background request failed')));
    return;
  }
  currentSession = response.session ?? currentSession;
  refreshAll({ includePageContext: false }).catch(renderError);
}

function renderError(error) {
  transientNotice = error instanceof Error ? error.message : String(error);
  renderMessages();
  renderSession();
}

function renderLlmSettings() {
  const activePreset = getActiveLlmPreset(preferences);
  const selectedProviderId = els.providerPresetSelect.value || activePreset.roles.planner.providerPresetId || preferences.providerPresets[0]?.id;
  const selectedProvider = preferences.providerPresets.find((preset) => preset.id === selectedProviderId) ?? preferences.providerPresets[0];
  els.llmPresetSelect.innerHTML = '';
  for (const preset of preferences.llmPresets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    els.llmPresetSelect.append(option);
  }
  els.llmPresetSelect.value = activePreset.id;
  els.llmPresetNameInput.value = activePreset.name;
  fillProviderSelect(els.providerPresetSelect, selectedProvider?.id);
  fillProviderSelect(els.plannerProviderPresetSelect, activePreset.roles.planner.providerPresetId);
  fillProviderSelect(els.executorProviderPresetSelect, activePreset.roles.executor.providerPresetId);
  els.providerPresetNameInput.value = selectedProvider?.name ?? '';
  els.providerInput.value = selectedProvider?.provider ?? 'llm-router';
  els.providerBaseUrlInput.value = selectedProvider?.baseUrl ?? 'http://127.0.0.1:18000/v1';
  els.providerApiKeyInput.value = '';
  els.providerApiKeyInput.placeholder = selectedProvider?.apiKey ? 'Stored; blank keeps existing' : 'Optional';
  els.plannerModelInput.value = activePreset.roles.planner.model;
  els.executorModelInput.value = activePreset.roles.executor.model;
  els.deleteLlmPresetButton.disabled = preferences.llmPresets.length <= 1;
  const providerInUse = preferences.llmPresets.some((preset) =>
    Object.values(preset.roles).some((role) => role.providerPresetId === selectedProvider?.id)
  );
  els.deleteProviderPresetButton.disabled = preferences.providerPresets.length <= 1 || providerInUse;
}

function fillProviderSelect(select, selectedId) {
  select.innerHTML = '';
  for (const preset of preferences.providerPresets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    select.append(option);
  }
  select.value = selectedId && preferences.providerPresets.some((preset) => preset.id === selectedId)
    ? selectedId
    : preferences.providerPresets[0]?.id ?? '';
}

async function activateLlmPreset(presetId) {
  const nextPresets = preferences.llmPresets.map((preset) => ({ ...preset, active: preset.id === presetId }));
  await savePreferences({ llmPresets: nextPresets, activeLlmPresetId: presetId });
}

async function createLlmPreset() {
  const now = new Date().toISOString();
  const activePreset = getActiveLlmPreset(preferences);
  const nextPreset = {
    ...structuredClone(activePreset),
    id: `preset-${Date.now()}`,
    name: 'New preset',
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  const nextPresets = preferences.llmPresets.map((preset) => ({ ...preset, active: false })).concat(nextPreset);
  await savePreferences({ llmPresets: nextPresets, activeLlmPresetId: nextPreset.id });
}

async function saveActiveLlmPreset() {
  const now = new Date().toISOString();
  const activePreset = getActiveLlmPreset(preferences);
  const selectedProviderId = els.providerPresetSelect.value || preferences.providerPresets[0]?.id;
  const nextProviderPresets = preferences.providerPresets.map((preset) => {
    if (preset.id !== selectedProviderId) return preset;
    return {
      ...preset,
      name: els.providerPresetNameInput.value.trim() || preset.name,
      provider: els.providerInput.value.trim() || 'llm-router',
      baseUrl: els.providerBaseUrlInput.value.trim() || 'http://127.0.0.1:18000/v1',
      apiKey: els.providerApiKeyInput.value || preset.apiKey,
      updatedAt: now,
    };
  });
  const nextPresets = preferences.llmPresets.map((preset) => {
    if (preset.id !== activePreset.id) return preset;
    return {
      ...preset,
      name: els.llmPresetNameInput.value.trim() || preset.name,
      active: true,
      roles: {
        ...preset.roles,
        planner: { ...preset.roles.planner, providerPresetId: els.plannerProviderPresetSelect.value, model: els.plannerModelInput.value.trim(), updatedAt: now },
        executor: { ...preset.roles.executor, providerPresetId: els.executorProviderPresetSelect.value, model: els.executorModelInput.value.trim(), updatedAt: now },
      },
      updatedAt: now,
    };
  });
  await savePreferences({ providerPresets: nextProviderPresets, llmPresets: nextPresets, activeLlmPresetId: activePreset.id });
}

async function deleteActiveLlmPreset() {
  if (preferences.llmPresets.length <= 1) return;
  const activePreset = getActiveLlmPreset(preferences);
  const nextPresets = preferences.llmPresets.filter((preset) => preset.id !== activePreset.id);
  const nextActiveId = nextPresets[0].id;
  await savePreferences({
    llmPresets: nextPresets.map((preset) => ({ ...preset, active: preset.id === nextActiveId })),
    activeLlmPresetId: nextActiveId,
  });
}

async function createProviderPreset() {
  const now = new Date().toISOString();
  const nextPreset = {
    id: `provider-${Date.now()}`,
    name: 'New provider',
    provider: 'llm-router',
    baseUrl: 'http://127.0.0.1:18000/v1',
    apiKey: '',
    createdAt: now,
    updatedAt: now,
  };
  await savePreferences({ providerPresets: preferences.providerPresets.concat(nextPreset) });
  els.providerPresetSelect.value = nextPreset.id;
  renderLlmSettings();
}

async function deleteSelectedProviderPreset() {
  if (preferences.providerPresets.length <= 1) return;
  const providerPresetId = els.providerPresetSelect.value;
  const inUse = preferences.llmPresets.some((preset) =>
    Object.values(preset.roles).some((role) => role.providerPresetId === providerPresetId)
  );
  if (inUse) return;
  await savePreferences({ providerPresets: preferences.providerPresets.filter((preset) => preset.id !== providerPresetId) });
}

function applyStoredUiState() {
  renderLlmSettings();
  renderOverlayState();
}

function responseError(response, fallback) {
  return response?.error || fallback;
}

async function loadPreferences() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored?.[STORAGE_KEY];
  return normalizeLlmPreferences({
    ...DEFAULT_PREFERENCES,
    ...(value && typeof value === 'object' ? value : {}),
  });
}

async function savePreferences(patch) {
  preferences = normalizeLlmPreferences({
    ...preferences,
    ...patch,
  });
  await chrome.storage.local.set({ [STORAGE_KEY]: preferences });
  renderLlmSettings();
}

async function fetchJson(path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (response.status === 204) {
    return null;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.problem || `HTTP ${response.status}`);
  }
  return payload;
}
