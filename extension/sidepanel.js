import {
  sortConversationsByRecent,
  getConversationTitle,
  buildChatMessages,
  getPlanSignal,
  getModelHandoffSignal,
} from './sidepanel-state.js';

// ── State ──
const API = 'http://127.0.0.1:4317/api';
const STORE_KEY = 'autoBrowserSidebar';

let state = {
  conversations: [],
  tasks: [],
  events: [],
  activeTask: null,
  activeConversation: null,
  // Extension session from background.js
  extSession: null,
  extConversationId: null,
  runtimeConfig: null,
  // Session ownership — used to filter stale server state
  sessionTaskId: null,
  // History view state
  viewMode: 'current',
  selectedHistoryConversationId: null,
  // UI state
  configOpen: false,
  preferences: {
    modelTier: 'standard',
    plannerModel: '',
    executorModel: '',
    cookiesPath: '',
    credentials: null,
    credentialsPath: '',
  },
};

// ── DOM ──
const $ = (id) => document.getElementById(id);
const els = {
  headerGoal: $('headerGoal'),
  statusDot: $('statusDot'),
  statusLabel: $('statusLabel'),
  promptStack: $('promptStack'),
  handoffBanner: $('handoffBanner'),
  handoffTitle: $('handoffTitle'),
  handoffMessage: $('handoffMessage'),
  handoffOpenTab: $('handoffOpenTab'),
  handoffResume: $('handoffResume'),
  handoffCancel: $('handoffCancel'),
  idleView: $('idleView'),
  timelineView: $('timelineView'),
  timelineList: $('timelineList'),
  currentStep: $('currentStep'),
  goalInput: $('goalInput'),
  sendButton: $('sendButton'),
  configToggle: $('configToggle'),
  configPanel: $('configPanel'),
  configClose: $('configClose'),
  overlayBackdrop: $('overlayBackdrop'),
  // Plan review
  planReview: $('planReview'),
  planBadge: $('planBadge'),
  planSummary: $('planSummary'),
  planSteps: $('planSteps'),
  planActions: $('planActions'),
  planApprove: $('planApprove'),
  planCancel: $('planCancel'),
  // Plan detail (main content)
  planDetail: $('planDetail'),
  planDetailGoal: $('planDetailGoal'),
  planDetailSummary: $('planDetailSummary'),
  planDetailSteps: $('planDetailSteps'),
  // Result summary
  resultSummary: $('resultSummary'),
  resultSummaryText: $('resultSummaryText'),
  // History
  historyToggle: $('historyToggle'),
  historyView: $('historyView'),
  historyList: $('historyList'),
  historyEmpty: $('historyEmpty'),
  historyDetailView: $('historyDetailView'),
  historyDetailTitle: $('historyDetailTitle'),
  historyMessages: $('historyMessages'),
  historyBack: $('historyBack'),
  newConversationInHistory: $('newConversationInHistory'),
  // Config fields
  credsEditor: $('credsEditor'),
  credsLoad: $('credsLoad'),
  credsSave: $('credsSave'),
  cookiePath: $('cookiePath'),
  modelTier: $('modelTier'),
  plannerModel: $('plannerModel'),
  executorModel: $('executorModel'),
  customPlannerField: $('customPlannerField'),
  customExecutorField: $('customExecutorField'),
};

// ── Init ──
initialize();

async function initialize() {
  await loadPreferences();
  applyPrefsToUI();
  await loadRuntimeConfig();
  els.goalInput.focus();
  bindEvents();
  await refresh();
  setInterval(refresh, 1500);
}

function showError(msg) {
  const el = document.getElementById('errorBanner');
  const msgEl = document.getElementById('errorMessage');
  if (!el || !msgEl) return;
  msgEl.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  setTimeout(() => { el.hidden = true; el.classList.remove('show'); }, 8000);
}

function hideError() {
  const el = document.getElementById('errorBanner');
  if (el) { el.hidden = true; el.classList.remove('show'); }
}

function bindEvents() {
  els.sendButton.addEventListener('click', submitGoal);
  els.goalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitGoal(); }
  });
  // Dismiss error on any input
  els.goalInput.addEventListener('input', hideError);
  els.configToggle.addEventListener('click', toggleConfig);
  els.configClose.addEventListener('click', closeConfig);
  els.overlayBackdrop.addEventListener('click', closeConfig);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // Escape — close config or unfocus
    if (e.key === 'Escape') {
      if (state.configOpen) { closeConfig(); return; }
    }
    // Ctrl+Enter / Cmd+Enter — send
    if (e.key === 'Enter' && mod) { e.preventDefault(); submitGoal(); return; }
    // Ctrl+, — toggle config
    if (e.key === ',' && mod) { e.preventDefault(); e.stopPropagation(); toggleConfig(); return; }
    // Ctrl+K or / — focus goal input
    if ((e.key === 'k' && mod) || (e.key === '/' && !mod && document.activeElement !== els.goalInput && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT')) {
      e.preventDefault();
      els.goalInput.focus();
      els.goalInput.select();
      return;
    }
    // Ctrl+R — refresh
    if (e.key === 'r' && mod) { e.preventDefault(); refresh(); return; }
    // Ctrl+H — toggle history
    if (e.key === 'h' && mod) { e.preventDefault(); toggleHistory(); return; }
  });
  els.handoffOpenTab.addEventListener('click', openAutomationTab);
  els.handoffResume.addEventListener('click', handleHandoffResume);
  els.handoffCancel.addEventListener('click', cancelTask);
  // Plan review
  els.planApprove.addEventListener('click', approvePlan);
  els.planCancel.addEventListener('click', cancelPlan);
  // History
  els.historyToggle.addEventListener('click', toggleHistory);
  els.historyBack.addEventListener('click', backToHistoryList);
  els.newConversationInHistory.addEventListener('click', () => {
    backToCurrentView();
    els.goalInput.focus();
  });
  // Config
  els.credsSave.addEventListener('click', saveCredentials);
  els.credsLoad.addEventListener('click', loadCredentialsFile);
  els.cookiePath.addEventListener('change', () => savePreferences());
  els.modelTier.addEventListener('change', onModelTierChange);
  els.plannerModel.addEventListener('change', () => savePreferences());
  els.executorModel.addEventListener('change', () => savePreferences());

  // Listen for background.js session updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'sidepanel_event') return;
    if (msg.payload?.type === 'session_updated') {
      state.extSession = msg.payload.session;
      state.extConversationId = msg.payload.session?.conversationId || null;
      render();
    }
    if (msg.payload?.type === 'permission_required') {
      state.extSession = { ...(state.extSession || {}), origin: msg.payload.origin, status: 'blocked' };
      render();
    }
  });
}

// ── API ──
async function apiFetch(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.problem || `HTTP ${res.status}`);
  return body;
}

async function approvePlan() {
  const task = state.activeTask;
  if (!task) return;
  els.planApprove.disabled = true;
  els.planCancel.disabled = true;
  try {
    await apiFetch(`/tasks/${task.id}/run`, {
      method: 'POST',
      body: JSON.stringify({ executorModel: resolveExecutorModel() }),
    });
    state.sessionTaskId = task.id;
    await savePreferences();
    await refresh();
  } catch (e) {
    showError(e.message);
  } finally {
    els.planApprove.disabled = false;
    els.planCancel.disabled = false;
  }
}

async function cancelPlan() {
  const task = state.activeTask;
  if (!task) return;
  els.planApprove.disabled = true;
  els.planCancel.disabled = true;
  try {
    await apiFetch(`/tasks/${task.id}/cancel`, { method: 'POST' });
    state.sessionTaskId = null;
    await savePreferences();
    await refresh();
  } catch (e) {
    showError(e.message);
  } finally {
    els.planApprove.disabled = false;
    els.planCancel.disabled = false;
  }
}

// ── Data ──
async function refresh() {
  try {
    const [svcState, cfg] = await Promise.all([
      apiFetch('/state'),
      apiFetch('/runtime-config').catch(() => null),
    ]);
    state.conversations = svcState.conversations || [];
    state.tasks = svcState.tasks || [];
    state.events = svcState.events || [];
    state.activeTask = svcState.activeTask || null;
    if (cfg) state.runtimeConfig = cfg;
    deriveActiveConversation();
    // Clear session ownership when task reaches terminal state
    if (state.activeTask && ['completed', 'failed', 'cancelled'].includes(state.activeTask.status)) {
      if (state.sessionTaskId === state.activeTask.id) {
        state.sessionTaskId = null;
        savePreferences();
      }
    }
    render();
  } catch (e) {
    // Service not available — show idle
    render();
  }
}

function deriveActiveConversation() {
  const task = state.activeTask;
  if (task?.conversationId) {
    state.activeConversation = state.conversations.find(c => c.id === task.conversationId) || null;
  }
}

// ── Task Actions ──
async function submitGoal() {
  const goal = els.goalInput.value.trim();
  if (!goal) return;

  const plannerModel = resolvePlannerModel();
  const executorModel = resolveExecutorModel();
  if (!plannerModel || !executorModel) {
    showError('Planner and executor models are required. Check Settings (Ctrl+,).');
    return;
  }

  els.sendButton.disabled = true;
  try {
    let task;

    if (state.extSession?.conversationId) {
      // Extension mode — delegate to background.js
      const res = await chrome.runtime.sendMessage({
        type: 'start_task',
        payload: { goal, plannerModel, executorModel, conversationId: state.extConversationId },
      });
      if (!res?.ok) throw new Error(res?.error || 'Extension start failed');
      state.extSession = res.session || state.extSession;
      task = { id: res.session?.taskId };
    } else {
      // Service mode — create draft task, let user review plan before running
      const conv = await apiFetch('/conversations', { method: 'POST' });
      task = await apiFetch(`/conversations/${conv.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: goal, plannerModel, browserConfig: buildBrowserConfig() }),
      });
      // Store task ownership — used to filter stale server state
      state.sessionTaskId = task.id;
      await savePreferences();
      // DO NOT run yet — render() will show plan review
    }

    els.goalInput.value = '';
    await refresh();
  } catch (e) {
    const msg = e.message || 'Unknown error';
    if (msg.includes('model is required') || msg.includes('Planner model')) {
      showError('No model configured. Set models in Settings (Ctrl+,) or check service configuration.');
    } else if (msg.includes('LLM Router')) {
      showError('AI model unavailable. Check model configuration in Settings.');
    } else {
      showError(msg);
    }
  } finally {
    els.sendButton.disabled = false;
  }
}

async function resumeTask() {
  const task = state.activeTask;
  if (!task) return;
  try {
    await apiFetch(`/tasks/${task.id}/resume`, {
      method: 'POST',
      body: JSON.stringify({
        plannerModel: resolvePlannerModel(),
      }),
    });
    // Re-approve
    await apiFetch(`/tasks/${task.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ executorModel: resolveExecutorModel() }),
    });
    await refresh();
  } catch (e) {
    showError(e.message);
  }
}

async function handleHandoffResume() {
  if (isExtensionTask(state.activeTask)) {
    await resumeExtensionTask();
    return;
  }
  await resumeTask();
}

async function cancelTask() {
  const task = state.activeTask;
  if (!task) return;
  try {
    await apiFetch(`/tasks/${task.id}/cancel`, { method: 'POST' });
    state.sessionTaskId = null;
    await savePreferences();
    await refresh();
  } catch (e) {
    showError(e.message);
  }
}

function isExtensionTask(task) {
  return Boolean(task && (task.executionSource === 'extension' || state.extSession?.taskId === task.id));
}

function getLatestTaskUrl(taskEvents) {
  const event = taskEvents.find((item) =>
    item.summary?.url ||
    item.data?.url ||
    item.summary?.action === 'navigate'
  );
  return event?.summary?.url || event?.data?.url || null;
}

async function openAutomationTab() {
  // Extension mode: focus the dedicated automation tab
  if (state.extSession?.tabId) {
    try {
      await chrome.tabs.update(state.extSession.tabId, { active: true });
      return;
    } catch { /* fall through */ }
  }
  // Service mode: open the current task URL
  const taskEvents = filterTaskEvents();
  const url = getLatestTaskUrl(taskEvents);
  if (url) {
    const [tab] = await chrome.tabs.query({ url: url });
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { active: true });
    } else {
      await chrome.tabs.create({ url, active: true });
    }
  }
}

async function resumeExtensionTask() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'resume_extension' });
    if (!res?.ok) showError(res?.error || 'Resume failed');
    await refresh();
  } catch (e) {
    showError(e.message);
  }
}

async function handoffExtensionTask() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'handoff_task' });
    if (!res?.ok) showError(res?.error || 'Handoff failed');
    await refresh();
  } catch (e) {
    showError(e.message);
  }
}

// ── Config ──
function buildBrowserConfig() {
  const cfg = { launchMode: 'auto' };
  const cookiesPath = state.preferences.cookiesPath?.trim();
  if (cookiesPath) cfg.cookiesPath = cookiesPath;
  const credsPath = state.preferences.credentialsPath;
  if (credsPath) cfg.credentialsPath = credsPath;
  return cfg;
}

function resolvePlannerModel() {
  return state.preferences.plannerModel || state.runtimeConfig?.plannerModel || 'deepseek-v4-pro';
}

function resolveExecutorModel() {
  return state.preferences.executorModel || state.runtimeConfig?.executorModel || 'deepseek-v4-flash';
}

function onModelTierChange() {
  const tier = els.modelTier.value;
  const custom = tier === 'custom';
  els.customPlannerField.hidden = !custom;
  els.customExecutorField.hidden = !custom;
  if (!custom) {
    const tiers = {
      standard: { planner: 'deepseek-v4-pro', executor: 'deepseek-v4-flash' },
      premium: { planner: 'deepseek-v4-pro', executor: 'deepseek-v4-pro' },
      economy: { planner: 'deepseek-v4-flash', executor: 'deepseek-v4-flash' },
    };
    const preset = tiers[tier];
    if (preset) {
      state.preferences.plannerModel = preset.planner;
      state.preferences.executorModel = preset.executor;
    }
  }
  savePreferences();
}

function toggleConfig() {
  state.configOpen = !state.configOpen;
  renderConfig();
}

function closeConfig() {
  state.configOpen = false;
  renderConfig();
}

// ── Credential Store ──
function saveCredentials() {
  try {
    const text = els.credsEditor.value.trim();
    if (!text) { state.preferences.credentials = null; }
    else { JSON.parse(text); state.preferences.credentials = text; }
    savePreferences();
  } catch {
    showError('Invalid JSON in credentials');
  }
}

async function loadCredentialsFile() {
  try {
    // Try loading from the known path
    const path = els.cookiePath.value?.trim()?.replace(/\/[^/]*$/, '') || '';
    // Since we can't read files from extension, use a fetch or input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      JSON.parse(text); // validate
      els.credsEditor.value = text;
      state.preferences.credentials = text;
      await savePreferences();
    };
    input.click();
  } catch {
    showError('Failed to load credentials file');
  }
}

// ── Preferences ──
async function loadPreferences() {
  try {
    const stored = await chrome.storage.local.get(STORE_KEY);
    const data = stored?.[STORE_KEY];
    if (data && typeof data === 'object') {
      state.preferences = { ...state.preferences, ...(data.preferences || data) };
      if (data.sessionTaskId) state.sessionTaskId = data.sessionTaskId;
    }
  } catch { /* ignore */ }
}

async function savePreferences() {
  // Collect from UI
  state.preferences.modelTier = els.modelTier.value;
  if (els.modelTier.value === 'custom') {
    state.preferences.plannerModel = els.plannerModel.value.trim();
    state.preferences.executorModel = els.executorModel.value.trim();
  }
  state.preferences.cookiesPath = els.cookiePath.value.trim();

  await chrome.storage.local.set({
    [STORE_KEY]: { ...state.preferences, sessionTaskId: state.sessionTaskId },
  });
}

function applyPrefsToUI() {
  const p = state.preferences;
  if (p.modelTier) els.modelTier.value = p.modelTier;
  if (p.plannerModel) els.plannerModel.value = p.plannerModel;
  if (p.executorModel) els.executorModel.value = p.executorModel;
  if (p.cookiesPath) els.cookiePath.value = p.cookiesPath;
  if (p.credentials) els.credsEditor.value = typeof p.credentials === 'string' ? p.credentials : JSON.stringify(p.credentials, null, 2);
  onModelTierChange();
}

async function loadRuntimeConfig() {
  try {
    state.runtimeConfig = await apiFetch('/runtime-config');
    if (state.runtimeConfig?.plannerModel && !state.preferences.plannerModel) {
      els.plannerModel.value = state.runtimeConfig.plannerModel;
    }
    if (state.runtimeConfig?.executorModel && !state.preferences.executorModel) {
      els.executorModel.value = state.runtimeConfig.executorModel;
    }
  } catch { /* ignore */ }
}

// ── Render ──
function render() {
  const task = state.activeTask;

  // Hide all content sections by default
  els.planReview.hidden = true;
  els.handoffBanner.hidden = true;
  els.idleView.hidden = true;
  els.planDetail.hidden = true;
  els.timelineView.hidden = true;
  els.resultSummary.hidden = true;
  els.historyView.hidden = true;
  els.historyDetailView.hidden = true;

  renderHeader(task);
  renderHistoryToggleState();

  // History views: show history content, hide other main content
  if (state.viewMode === 'history-list') {
    renderHistoryList();
    return;
  }
  if (state.viewMode === 'history-detail') {
    renderHistoryDetail();
    return;
  }

  const planSignal = getPlanSignal(task, state.events);
  const handoffSignal = getModelHandoffSignal(task, state.events);

  if (planSignal) {
    renderPlanReview(planSignal);
  }
  if (handoffSignal) {
    renderHandoffBanner(handoffSignal, task);
  }

  // Show the appropriate main content based on task status
  if (task && ['draft', 'ready'].includes(task.status)) {
    if (!planSignal) els.idleView.hidden = false;
  } else if (task && task.status === 'running') {
    renderTimeline(task, { showIdleWhenEmpty: !planSignal && !handoffSignal });
  } else if (task && task.status === 'completed') {
    renderTimeline(task, { showIdleWhenEmpty: !planSignal });
    if (task.resultSummary) renderResultSummary(task);
  } else if (task && ['handoff', 'blocked', 'failed'].includes(task.status)) {
    renderTimeline(task, { showIdleWhenEmpty: !handoffSignal });
  } else if (task) {
    renderTimeline(task);
  } else {
    els.idleView.hidden = false;
  }
}

function renderHeader(task) {
  // Status
  const status = task?.status || 'idle';
  els.statusDot.className = 'status-dot ' + statusClass(status);
  els.statusLabel.textContent = statusLabel(status);
  els.headerGoal.textContent = 'Auto Browser';
}

function renderHandoffBanner(signal, task) {
  const isExt = isExtensionTask(task);
  const taskEvents = filterTaskEvents();

  els.handoffBanner.hidden = false;
  els.handoffTitle.textContent = signal.title;
  els.handoffMessage.textContent = isExt
    ? `模型请求人工介入：${signal.reason}。完成后返回侧边栏继续执行。`
    : `模型请求人工介入：${signal.reason}。完成后点击继续执行，系统会重新规划剩余步骤。`;
  els.handoffResume.disabled = false;
  els.handoffOpenTab.hidden = !isExt && !getLatestTaskUrl(taskEvents);
}

function renderPlanMain(task) {
  els.planDetail.hidden = false;

  // Show user's goal
  els.planDetailGoal.textContent = task.goal || '';

  // Show plan summary
  const summary = task.planDraft?.summary || '';
  els.planDetailSummary.textContent = summary;
  els.planDetailSummary.hidden = !summary;

  // Show plan steps
  const steps = task.planDraft?.steps || [];
  els.planDetailSteps.innerHTML = '';
  for (const step of steps) {
    const li = document.createElement('li');
    li.textContent = (step.title || '') + (step.intent ? ` — ${step.intent}` : '');
    els.planDetailSteps.appendChild(li);
  }
}

function renderPlanReview(signal) {
  els.planReview.hidden = false;
  els.planBadge.textContent = signal.badge;
  els.planActions.hidden = !signal.actionable;

  const summary = signal.summary || 'No summary available.';
  els.planSummary.textContent = summary;

  const steps = signal.steps || [];
  els.planSteps.innerHTML = '';
  for (const step of steps) {
    const li = document.createElement('li');
    li.textContent = (step.title || '') + (step.intent ? ` — ${step.intent}` : '');
    els.planSteps.appendChild(li);
  }
}

function renderResultSummary(task) {
  els.resultSummary.hidden = false;
  els.resultSummaryText.textContent = task.resultSummary || 'Task completed.';
}

function renderTimeline(task, options = {}) {
  const taskEvents = filterTaskEvents();

  if (!task || taskEvents.length === 0) {
    if (options.showIdleWhenEmpty !== false) {
      els.idleView.hidden = false;
    }
    els.timelineView.hidden = true;
    els.currentStep.textContent = '';
    return;
  }

  els.idleView.hidden = true;
  els.timelineView.hidden = false;

  if (task.currentStepIndex != null && task.planDraft?.steps) {
    const total = task.planDraft.steps.length;
    els.currentStep.textContent = `${task.currentStepIndex + 1}/${total}`;
  } else {
    els.currentStep.textContent = `${taskEvents.length} actions`;
  }

  els.timelineList.innerHTML = '';
  for (const event of taskEvents.slice(0, 30)) {
    els.timelineList.appendChild(createTimelineItem(event));
  }
}

function createTimelineItem(event) {
  const li = document.createElement('li');
  li.className = 'timeline-item';

  const action = event.summary?.action || 'info';

  const icon = document.createElement('div');
  icon.className = `timeline-item-icon ${action || 'default'}`;
  icon.textContent = actionIcon(action);

  const body = document.createElement('div');
  body.className = 'timeline-item-body';

  const actionName = document.createElement('div');
  actionName.className = 'timeline-item-action';
  actionName.textContent = event.type.replace(/^task\.execution\./, '');

  const detail = document.createElement('div');
  detail.className = 'timeline-item-detail';
  detail.textContent = event.summary?.label || event.data?.message || '';

  body.append(actionName, detail);

  const time = document.createElement('div');
  time.className = 'timeline-item-time';
  time.textContent = new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  li.append(icon, body, time);
  return li;
}

function renderConfig() {
  const open = state.configOpen;
  els.configPanel.classList.toggle('open', open);
  els.overlayBackdrop.hidden = !open;
  els.configPanel.setAttribute('aria-hidden', String(!open));
}

// ── History Views ──
function toggleHistory() {
  if (state.viewMode === 'current') {
    state.viewMode = 'history-list';
  } else if (state.viewMode === 'history-list') {
    state.viewMode = 'current';
  } else {
    state.viewMode = 'current';
  }
  render();
}

function backToCurrentView() {
  state.viewMode = 'current';
  state.selectedHistoryConversationId = null;
  render();
}

function backToHistoryList() {
  state.viewMode = 'history-list';
  state.selectedHistoryConversationId = null;
  render();
}

function renderHistoryToggleState() {
  const active = state.viewMode !== 'current';
  els.historyToggle.classList.toggle('active', active);
  els.historyToggle.setAttribute('aria-pressed', String(active));
}

function renderHistoryList() {
  els.historyView.hidden = false;

  const conversations = sortConversationsByRecent(state.conversations);
  els.historyList.innerHTML = '';
  els.historyEmpty.hidden = conversations.length > 0;

  for (const conv of conversations) {
    const li = document.createElement('li');
    li.className = 'history-item';

    const main = document.createElement('div');
    main.className = 'history-item-main';

    const title = document.createElement('div');
    title.className = 'history-item-title';
    title.textContent = getConversationTitle(conv);

    const meta = document.createElement('div');
    meta.className = 'history-item-meta';
    const msgCount = (conv.messages || []).length;
    const date = conv.updatedAt
      ? new Date(conv.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    meta.textContent = `${msgCount} messages${date ? ' • ' + date : ''}`;

    main.append(title, meta);

    const arrow = document.createElement('span');
    arrow.className = 'history-item-arrow';
    arrow.textContent = '→';

    li.append(main, arrow);
    li.addEventListener('click', () => selectConversation(conv.id));
    els.historyList.appendChild(li);
  }
}

function selectConversation(id) {
  state.selectedHistoryConversationId = id;
  state.viewMode = 'history-detail';
  render();
}

function renderHistoryDetail() {
  els.historyDetailView.hidden = false;

  const conv = state.conversations.find(c => c.id === state.selectedHistoryConversationId);
  if (!conv) { backToHistoryList(); return; }

  els.historyDetailTitle.textContent = getConversationTitle(conv);

  const messages = buildChatMessages(conv, null, null);
  els.historyMessages.innerHTML = '';
  for (const msg of messages) {
    const div = document.createElement('div');
    div.className = `history-msg ${msg.role}`;
    div.textContent = msg.content;
    els.historyMessages.appendChild(div);
  }
}

// ── Stale Task Cleanup ──

// ── Helpers ──
function filterTaskEvents() {
  const taskId = state.activeTask?.id;
  if (!taskId) return [];
  return (state.events || [])
    .filter(e => e.taskId === taskId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function statusClass(status) {
  if (status === 'running') return 'running';
  if (status === 'handoff' || status === 'blocked') return 'handoff';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'draft' || status === 'ready') return '';
  return '';
}

function statusLabel(status) {
  const map = {
    idle: '空闲',
    draft: '草稿',
    ready: '就绪',
    running: '运行中',
    handoff: '需要操作',
    blocked: '已阻止',
    completed: '完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return map[status] || status;
}

function actionIcon(action) {
  const map = {
    navigate: '→',
    click_ref: '↖',
    click_point: '+',
    fill_ref: '✎',
    press_key: '⌨',
    scroll: '⇅',
    wait_for: '⏳',
    finish: '✓',
    handoff: '⚠',
  };
  return map[action] || '•';
}
