import {
  sortConversationsByRecent,
  getConversationTitle,
  buildChatMessages,
  getPlanSignal,
  getModelHandoffSignal,
  selectCurrentTask,
  deriveIterations,
} from './sidepanel-state.js';

// ── Commands Registry ──
const COMMANDS = [
  { name: '/help', desc: 'Show available commands', args: '' },
  { name: '/clear', desc: 'Reset conversation and start fresh', args: '' },
  { name: '/models', desc: 'Switch model tier (standard|premium|economy|custom)', args: ' [tier]' },
  { name: '/screenshot', desc: 'Capture and attach current page screenshot', args: '' },
  { name: '/context', desc: 'Add a reference URL or note as task context', args: ' <url|text>' },
  { name: '/cancel', desc: 'Cancel the current running task', args: '' },
  { name: '/retry', desc: 'Re-run the last failed task', args: '' },
  { name: '/config', desc: 'Open the settings panel', args: '' },
];

// ── State ──
const API = 'http://127.0.0.1:4317/api';
const STORE_KEY = 'autoBrowserSidebar';

let sseAbortController = null;
let sseRetries = 0;
const MAX_SSE_RETRIES = 3;

let state = {
  conversations: [],
  tasks: [],
  goals: [],
  events: [],
  activeTask: null,
  activeConversation: null,
  extSession: null,
  extConversationId: null,
  runtimeConfig: null,
  sessionTaskId: null,
  historyOpen: false,
  historyViewPanel: 'history',
  historyViewMode: 'list',
  selectedHistoryConversationId: null,
  loadedConversationId: null,
  loadedTask: null,
  configOpen: false,
  iterations: [],
  chatMessages: [],
  sessionTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  sseConnected: false,
  pendingContext: [],
  contextFormOpen: false,
  commandFilter: '',
  commandIdx: -1,
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
  headerModel: $('headerModel'),
  modelTierPill: $('modelTierPill'),
  modelTierLabel: $('modelTierLabel'),
  modelTierDropdown: $('modelTierDropdown'),
  statusDot: $('statusDot'),
  statusLabel: $('statusLabel'),
  // Handoff
  handoffBanner: $('handoffBanner'),
  handoffTitle: $('handoffTitle'),
  handoffMessage: $('handoffMessage'),
  handoffOpenTab: $('handoffOpenTab'),
  handoffResume: $('handoffResume'),
  handoffCancel: $('handoffCancel'),
  // Chat
  chatMessages: $('chatMessages'),
  chatEmpty: $('chatEmpty'),
  mainScroll: $('mainScroll'),
  // Composer
  goalInput: $('goalInput'),
  sendButton: $('sendButton'),
  // Command palette
  commandPalette: $('commandPalette'),
  commandList: $('commandList'),
  // Context
  contextArea: $('contextArea'),
  contextChips: $('contextChips'),
  contextForm: $('contextForm'),
  contextUrlInput: $('contextUrlInput'),
  contextTextInput: $('contextTextInput'),
  contextAddBtn: $('contextAddBtn'),
  contextCancelBtn: $('contextCancelBtn'),
  contextToggle: $('contextToggle'),
  // Panels
  configToggle: $('configToggle'),
  configPanel: $('configPanel'),
  configClose: $('configClose'),
  overlayBackdrop: $('overlayBackdrop'),
  historyPanel: $('historyPanel'),
  historyClose: $('historyClose'),
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
  // Goals panel
  goalsToggle: $('goalsToggle'),
  goalsView: $('goalsView'),
  goalsList: $('goalsList'),
  goalsEmpty: $('goalsEmpty'),
  newGoalBtn: $('newGoalBtn'),
  panelTabs: document.querySelectorAll('.panel-tab'),
  // Config
  credsEditor: $('credsEditor'),
  credsLoad: $('credsLoad'),
  credsSave: $('credsSave'),
  cookiePath: $('cookiePath'),
  modelTier: $('modelTier'),
  plannerModel: $('plannerModel'),
  executorModel: $('executorModel'),
  customPlannerField: $('customPlannerField'),
  customExecutorField: $('customExecutorField'),
  // Lightbox
  screenshotLightbox: $('screenshotLightbox'),
  screenshotLightboxImg: $('screenshotLightboxImg'),
  screenshotLightboxClose: $('screenshotLightboxClose'),
  // Toast
  toast: $('toast'),
};

// ── Init ──
initialize();

async function initialize() {
  await loadPreferences();
  applyPrefsToUI();
  await loadRuntimeConfig();
  els.goalInput.focus();
  bindEvents();
  connectSSE();
  await refresh();
  setInterval(refresh, 1500);
}

// ── Toast ──
let toastTimer = null;
function showToast(msg) {
  if (toastTimer) clearTimeout(toastTimer);
  els.toast.textContent = msg;
  els.toast.hidden = false;
  els.toast.style.animation = 'none';
  els.toast.offsetHeight; // force reflow
  els.toast.style.animation = '';
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2200);
}

// ── Error Banner ──
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

// ── Command System ──
function parseCommand(input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');
  const cmd = COMMANDS.find(c => c.name === name);
  return cmd ? { cmd, args } : null;
}

function showCommandPalette(filter) {
  const term = (filter || '').toLowerCase();
  const matches = COMMANDS.filter(c => c.name.includes(term) || c.desc.toLowerCase().includes(term));
  if (matches.length === 0) {
    els.commandPalette.hidden = true;
    return;
  }
  els.commandPalette.hidden = false;
  els.commandList.innerHTML = '';
  state.commandIdx = -1;
  matches.forEach((cmd, i) => {
    const div = document.createElement('div');
    div.className = 'command-item';
    div.dataset.index = i;
    div.dataset.cmd = cmd.name;
    div.innerHTML = `<span class="command-item-name">${cmd.name}${cmd.args}</span><span class="command-item-desc">${cmd.desc}</span>`;
    div.addEventListener('click', () => {
      els.goalInput.value = cmd.name + ' ';
      els.goalInput.focus();
      els.commandPalette.hidden = true;
    });
    els.commandList.appendChild(div);
  });
}

function hideCommandPalette() {
  els.commandPalette.hidden = true;
  state.commandIdx = -1;
}

function focusCommand(idx) {
  const items = els.commandList.querySelectorAll('.command-item');
  items.forEach(el => el.classList.remove('focused'));
  if (idx >= 0 && idx < items.length) {
    items[idx].classList.add('focused');
    state.commandIdx = idx;
  }
}

function selectFocusedCommand() {
  const items = els.commandList.querySelectorAll('.command-item');
  if (state.commandIdx >= 0 && state.commandIdx < items.length) {
    const cmd = items[state.commandIdx].dataset.cmd;
    els.goalInput.value = cmd + ' ';
    els.goalInput.focus();
    hideCommandPalette();
    return true;
  }
  return false;
}

async function executeCommand(cmd, args) {
  switch (cmd.name) {
    case '/help': {
      const helpText = COMMANDS.map(c => `${c.name}${c.args} — ${c.desc}`).join('\n');
      addChatMessage('system', 'Available commands:\n' + helpText);
      renderChat();
      break;
    }
    case '/clear': {
      state.loadedConversationId = null;
      state.loadedTask = null;
      state.sessionTaskId = null;
      state.iterations = [];
      state.chatMessages = [];
      state.sessionTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      state.pendingContext = [];
      await savePreferences();
      renderChat();
      renderContextChips();
      showToast('Conversation cleared');
      break;
    }
    case '/models': {
      const tier = args.trim().toLowerCase();
      const validTiers = ['standard', 'premium', 'economy', 'custom'];
      if (validTiers.includes(tier)) {
        state.preferences.modelTier = tier;
        applyModelTierPreset(tier);
        els.modelTier.value = tier;
        onModelTierChange();
        updateModelTierPill();
        await savePreferences();
        // If a task is running, update its model on the server
        if (state.activeTask && state.activeTask.status === 'running') {
          await updateRunningTaskModel();
          showToast(`Model switched to ${tier}`);
        } else {
          showToast(`Model tier set to ${tier}`);
        }
      } else {
        showToast('Usage: /models standard|premium|economy|custom');
      }
      break;
    }
    case '/screenshot': {
      addChatMessage('system', 'Screenshot capture is triggered automatically during execution for visual pages. Use /context to attach references manually.');
      renderChat();
      break;
    }
    case '/context': {
      els.contextForm.hidden = false;
      els.contextArea.hidden = false;
      if (args) {
        try { new URL(args); els.contextUrlInput.value = args; } catch { els.contextTextInput.value = args; }
      }
      els.contextUrlInput.focus();
      break;
    }
    case '/cancel': {
      if (state.activeTask) {
        await cancelTask();
        showToast('Task cancelled');
      } else {
        showToast('No active task to cancel');
      }
      break;
    }
    case '/retry': {
      if (state.loadedTask && state.loadedTask.status === 'failed') {
        state.sessionTaskId = state.loadedTask.id;
        state.iterations = [];
        state.chatMessages = [];
        state.sessionTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        state.pendingContext = [];
        await savePreferences();
        connectSSE();
        await resumeTask();
        await refresh();
        showToast('Retrying task...');
      } else {
        showToast('No failed task to retry');
      }
      break;
    }
    case '/config': {
      toggleConfig();
      break;
    }
    default:
      return false;
  }
  return true;
}

// ── Chat Messages ──
function addChatMessage(role, content, opts = {}) {
  state.chatMessages.push({
    role,
    content,
    type: opts.type || 'text',
    planDraft: opts.planDraft || null,
    planBadge: opts.planBadge || null,
    planActionable: opts.planActionable || false,
    iterations: opts.iterations || null,
    tokenUsage: opts.tokenUsage || null,
    screenshot: opts.screenshot || null,
    contextRefs: opts.contextRefs || null,
    resultSummary: opts.resultSummary || null,
    error: opts.error || null,
    taskId: opts.taskId || null,
    timestamp: Date.now(),
  });
}

function renderChat() {
  const msgs = state.chatMessages;
  els.chatEmpty.hidden = msgs.length > 0;
  if (msgs.length === 0) return;

  // Remove all existing message nodes
  const existingMsgs = els.chatMessages.querySelectorAll('.chat-msg, .chat-plan-card, .chat-result-card, .chat-iteration-card, .chat-screenshot, .chat-tokens-badge');
  existingMsgs.forEach(el => el.remove());
  // Keep chatEmpty
  els.chatEmpty.hidden = true;

  for (const msg of msgs) {
    const el = createChatMessageElement(msg);
    if (el) els.chatMessages.appendChild(el);
  }

  // Auto-scroll
  if (els.mainScroll) {
    els.mainScroll.scrollTop = els.mainScroll.scrollHeight;
  }
}

function createChatMessageElement(msg) {
  switch (msg.type) {
    case 'text':
      return createTextBubble(msg);
    case 'plan':
      return createPlanCard(msg);
    case 'result':
      return createResultCard(msg);
    case 'iteration':
      return createIterationBlock(msg);
    case 'screenshot':
      return createScreenshotBlock(msg);
    case 'tokens':
      return createTokensBadge(msg);
    default:
      return createTextBubble(msg);
  }
}

function createTextBubble(msg) {
  const div = document.createElement('div');
  div.className = `chat-msg ${msg.role}`;
  div.textContent = msg.content;

  if (msg.role === 'user' && msg.contextRefs && msg.contextRefs.length > 0) {
    const ctxDiv = document.createElement('div');
    ctxDiv.className = 'chat-msg-context';
    for (const ref of msg.contextRefs) {
      const chip = document.createElement('span');
      chip.className = 'chat-context-chip';
      chip.textContent = (ref.type === 'url' ? '🔗 ' : '📝 ') + (ref.label || ref.value).slice(0, 50);
      ctxDiv.appendChild(chip);
    }
    div.appendChild(ctxDiv);
  }

  return div;
}

function createPlanCard(msg) {
  const div = document.createElement('div');
  div.className = 'chat-plan-card';

  const header = document.createElement('div');
  header.className = 'chat-plan-card-header';
  const h2 = document.createElement('h2');
  h2.textContent = 'Plan';
  const badge = document.createElement('span');
  badge.className = 'chat-plan-card-badge';
  badge.textContent = msg.planBadge || 'Draft';
  header.append(h2, badge);
  div.appendChild(header);

  if (msg.content) {
    const summary = document.createElement('p');
    summary.className = 'chat-plan-card-summary';
    summary.textContent = msg.content;
    div.appendChild(summary);
  }

  if (msg.planDraft?.steps?.length) {
    const ol = document.createElement('ol');
    ol.className = 'chat-plan-card-steps';
    for (const step of msg.planDraft.steps) {
      const li = document.createElement('li');
      li.className = 'plan-step-item';

      if (msg.planActionable && msg.planId) {
        // Editable steps for draft plans
        const titleSpan = document.createElement('span');
        titleSpan.className = 'plan-step-text';
        titleSpan.textContent = (step.title || '') + (step.intent ? ` — ${step.intent}` : '');

        const editBtn = document.createElement('button');
        editBtn.className = 'btn-icon plan-step-edit';
        editBtn.innerHTML = '&#9998;';
        editBtn.title = 'Edit step';
        editBtn.addEventListener('click', async () => {
          const newTitle = prompt('Step title:', step.title || '');
          if (newTitle === null) return; // cancelled
          const newIntent = prompt('Step intent:', step.intent || '');
          if (newIntent === null) return;
          try {
            const res = await fetch(`${API}/plans/${msg.planId}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                edits: [{ stepId: step.id, title: newTitle.trim() || undefined, intent: newIntent.trim() || undefined }],
              }),
            });
            if (res.ok) {
              refresh();
            } else {
              const err = await res.json();
              console.error('Edit failed:', err);
            }
          } catch (err) {
            console.error('Edit failed:', err);
          }
        });

        li.append(titleSpan, editBtn);
      } else {
        li.textContent = (step.title || '') + (step.intent ? ` — ${step.intent}` : '');
      }
      ol.appendChild(li);
    }
    div.appendChild(ol);
  }

  if (msg.planActionable && msg.taskId) {
    const actions = document.createElement('div');
    actions.className = 'chat-plan-card-actions';
    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-primary btn-sm';
    approveBtn.textContent = 'Approve & Run';
    approveBtn.addEventListener('click', () => approvePlanById(msg.taskId));
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => cancelPlanById(msg.taskId));
    actions.append(approveBtn, cancelBtn);
    div.appendChild(actions);
  }

  return div;
}

function createResultCard(msg) {
  const div = document.createElement('div');
  div.className = 'chat-result-card';
  const header = document.createElement('div');
  header.className = 'chat-result-header';
  header.textContent = '✓ Completed';
  div.appendChild(header);
  const text = document.createElement('p');
  text.className = 'chat-result-text';
  text.textContent = msg.content || msg.resultSummary || 'Task completed.';
  div.appendChild(text);
  return div;
}

function createIterationBlock(msg) {
  if (!msg.iterations) return null;
  const frag = document.createDocumentFragment();
  for (const iter of msg.iterations) {
    frag.appendChild(createCompactIterationCard(iter));
  }
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:contents';
  wrapper.appendChild(frag);
  return wrapper;
}

function createCompactIterationCard(iter) {
  const div = document.createElement('div');
  div.className = 'chat-iteration-card';

  const header = document.createElement('div');
  header.className = 'iteration-card-header';
  const num = document.createElement('span');
  num.className = 'iteration-card-num';
  num.textContent = `#${iter.iteration}`;
  const url = document.createElement('span');
  url.className = 'iteration-card-url';
  url.textContent = iter.url || iter.title || '(page)';
  url.title = iter.url || iter.title || '';
  const tokens = document.createElement('span');
  tokens.className = 'iteration-card-tokens';
  if (iter.tokenUsage) {
    tokens.textContent = `P${iter.tokenUsage.promptTokens} C${iter.tokenUsage.completionTokens}`;
  }
  header.append(num, url, tokens);
  div.appendChild(header);

  const body = document.createElement('div');
  body.className = 'iteration-card-body';
  if (iter.title || iter.url) {
    body.appendChild(createPhaseRow('observe', 'Observe', iter.title || iter.url));
  }
  const actionLabel = iter.actionLabel || (iter.rawCompletion ? parseActionFromCompletion(iter.rawCompletion) : null);
  if (actionLabel) {
    body.appendChild(createPhaseRow('decide', 'Decide', actionLabel));
    const actDetail = iter.error || iter.actionDetails || actionLabel;
    body.appendChild(createPhaseRow('act', 'Act', actDetail));
  }
  div.appendChild(body);

  if (iter.error) {
    const err = document.createElement('div');
    err.className = 'iteration-card-error';
    err.textContent = iter.error;
    div.appendChild(err);
  }

  if (iter.rawCompletion) {
    div.style.cursor = 'pointer';
    div.title = 'Click to see LLM output';
    div.addEventListener('click', () => showCompletionDetail(iter));
  }

  return div;
}

function createPhaseRow(phase, label, value) {
  const row = document.createElement('div');
  row.style.display = 'contents';
  const labelCol = document.createElement('div');
  labelCol.className = 'iteration-phase';
  const dot = document.createElement('span');
  dot.className = `iteration-phase-dot ${phase}`;
  const lbl = document.createElement('span');
  lbl.className = 'iteration-phase-label';
  lbl.textContent = label;
  labelCol.append(dot, lbl);
  const valueCol = document.createElement('div');
  valueCol.className = 'iteration-phase-value';
  valueCol.textContent = typeof value === 'string' ? value.slice(0, 120) : '';
  row.append(labelCol, valueCol);
  return row;
}

function createScreenshotBlock(msg) {
  if (!msg.screenshot) return null;
  const div = document.createElement('div');
  div.className = 'chat-screenshot';
  const img = document.createElement('img');
  img.className = 'chat-screenshot-img';
  img.src = `data:${msg.screenshot.mimeType};base64,${msg.screenshot.base64}`;
  img.alt = msg.screenshot.reason || 'Screenshot';
  img.addEventListener('click', () => {
    els.screenshotLightboxImg.src = img.src;
    els.screenshotLightbox.hidden = false;
  });
  div.appendChild(img);
  if (msg.screenshot.reason) {
    const caption = document.createElement('div');
    caption.className = 'chat-screenshot-caption';
    caption.textContent = msg.screenshot.reason;
    div.appendChild(caption);
  }
  return div;
}

function createTokensBadge(msg) {
  const div = document.createElement('div');
  div.className = 'chat-tokens-badge';
  div.textContent = msg.content;
  return div;
}

function parseActionFromCompletion(raw) {
  try {
    const parsed = JSON.parse(raw);
    return formatActionLabel(parsed);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return formatActionLabel(JSON.parse(match[0])); } catch { return null; }
    }
    return null;
  }
}

function formatActionLabel(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const action = parsed.action;
  if (!action) return null;
  const map = {
    navigate: parsed.url ? `Navigate to ${parsed.url.slice(0, 60)}` : 'Navigate',
    click_ref: parsed.ref ? `Click ${parsed.ref}` : 'Click',
    click_point: `Click at (${parsed.x}, ${parsed.y})`,
    fill_ref: parsed.textPreview ? `Fill "${parsed.textPreview}"` : parsed.ref ? `Fill ${parsed.ref}` : 'Fill',
    press_key: parsed.key ? `Press ${parsed.key}` : 'Press key',
    scroll: `Scroll ${parsed.direction || 'down'}` + (parsed.amount ? ` ${parsed.amount}px` : ''),
    wait_for: parsed.text ? `Wait for "${parsed.text.slice(0, 30)}"` : parsed.ms ? `Wait ${parsed.ms}ms` : 'Wait',
    finish: parsed.message ? `Finish: ${parsed.message.slice(0, 60)}` : 'Finish',
    handoff: parsed.reason ? `Handoff: ${parsed.reason.slice(0, 60)}` : 'Handoff',
  };
  return map[action] || action;
}

function showCompletionDetail(iter) {
  if (!iter.rawCompletion) return;
  let formatted;
  try { formatted = JSON.stringify(JSON.parse(iter.rawCompletion), null, 2); } catch { formatted = iter.rawCompletion; }
  const msg = document.createElement('div');
  msg.style.cssText = 'position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:16px;';
  msg.innerHTML = `<div style="background:var(--bg);border-radius:var(--radius);padding:16px;max-width:100%;max-height:80vh;overflow-y:auto;font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-all;">${escapeHtml(formatted)}</div>`;
  msg.addEventListener('click', () => msg.remove());
  document.body.appendChild(msg);
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Context Management ──
function addContextRef(type, value, label) {
  state.pendingContext.push({ type, value, label: label || value });
  renderContextChips();
}

function removeContextRef(idx) {
  state.pendingContext.splice(idx, 1);
  renderContextChips();
}

function renderContextChips() {
  const hasCtx = state.pendingContext.length > 0;
  els.contextArea.hidden = !hasCtx && !state.contextFormOpen;
  els.contextChips.innerHTML = '';
  els.contextChips.hidden = state.pendingContext.length === 0;
  for (let i = 0; i < state.pendingContext.length; i++) {
    const ref = state.pendingContext[i];
    const chip = document.createElement('span');
    chip.className = 'context-chip';
    const label = ref.type === 'url' ? '🔗 ' : '📝 ';
    chip.innerHTML = `${label}${(ref.label || ref.value).slice(0, 40)} <span class="context-chip-remove" data-idx="${i}">&times;</span>`;
    chip.querySelector('.context-chip-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeContextRef(i);
    });
    els.contextChips.appendChild(chip);
  }
}

function formatContextString() {
  if (state.pendingContext.length === 0) return '';
  const lines = state.pendingContext.map(ref =>
    ref.type === 'url' ? `- URL: ${ref.value}` : `- Note: ${ref.value}`
  );
  return 'References:\n' + lines.join('\n');
}

// ── SSE Connection ──
function connectSSE() {
  if (sseAbortController) { sseAbortController.abort(); }
  sseAbortController = new AbortController();

  const connect = async () => {
    try {
      const response = await fetch(`${API}/events`, { signal: sseAbortController.signal });
      if (!response.ok || !response.body) return;
      state.sseConnected = true;
      sseRetries = 0;
      updateLiveIndicator();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const dataLine = part.trim().match(/^data: (.+)$/m);
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine[1]);
            handleSSEEvent(event);
          } catch { /* skip invalid JSON */ }
        }
      }
    } catch { /* connection closed */ } finally {
      state.sseConnected = false;
      updateLiveIndicator();
      if (!sseAbortController.signal.aborted && sseRetries < MAX_SSE_RETRIES) {
        sseRetries++;
        setTimeout(connect, 2000);
      }
    }
  };

  connect();
}

function disconnectSSE() {
  if (sseAbortController) {
    sseAbortController.abort();
    sseAbortController = null;
  }
  state.sseConnected = false;
}

function handleSSEEvent(event) {
  const isActive = event.taskId === state.sessionTaskId;
  if (!isActive) return;

  switch (event.type) {
    case 'task.execution.iteration.started': {
      const iterData = event.data || {};
      const it = {
        iteration: iterData.iteration ?? state.iterations.length,
        url: iterData.url ?? '',
        title: iterData.title ?? '',
        actionLabel: event.summary?.label ?? undefined,
        actionDetails: event.summary?.url ?? undefined,
        rawCompletion: undefined,
        tokenUsage: undefined,
        error: undefined,
      };
      state.iterations = [...state.iterations, it];
      updateAgentLoopInChat();
      break;
    }
    case 'task.execution.llm.completion': {
      const llmData = event.data || {};
      const updated = state.iterations.map(it => ({ ...it }));
      const last = updated[updated.length - 1];
      if (last) {
        if (llmData.content) last.rawCompletion = llmData.content;
        if (llmData.usage) last.tokenUsage = llmData.usage;
      }
      state.iterations = updated;
      if (llmData.usage) {
        state.sessionTokens = {
          promptTokens: state.sessionTokens.promptTokens + (llmData.usage.promptTokens || 0),
          completionTokens: state.sessionTokens.completionTokens + (llmData.usage.completionTokens || 0),
          totalTokens: state.sessionTokens.totalTokens + (llmData.usage.totalTokens || 0),
        };
      }
      updateAgentLoopInChat();
      break;
    }
    case 'task.execution.iteration.completed': {
      const updated = state.iterations.map(it => ({ ...it }));
      const last = updated[updated.length - 1];
      if (last && event.summary) {
        if (event.summary.label) last.actionLabel = event.summary.label;
        if (event.summary.url != null) last.actionDetails = event.summary.url;
        if (event.summary.error) last.error = event.summary.error;
      }
      state.iterations = updated;
      updateAgentLoopInChat();
      break;
    }
    case 'task.execution.screenshot': {
      const ssData = event.data || {};
      if (ssData.base64) {
        addChatMessage('assistant', '', {
          type: 'screenshot',
          screenshot: {
            base64: ssData.base64,
            mimeType: ssData.mimeType || 'image/jpeg',
            viewport: ssData.viewport || {},
            reason: ssData.reason || 'Page screenshot',
          },
        });
        renderChat();
      }
      break;
    }
    case 'task.drafted': { refresh().catch(() => {}); break; }
    case 'task.running':
    case 'task.completed':
    case 'task.failed':
    case 'task.cancelled':
    case 'task.handoff': { refresh().catch(() => {}); break; }
  }
}

function updateAgentLoopInChat() {
  if (state.iterations.length === 0) return;
  // Remove previous iteration/token messages and re-add
  state.chatMessages = state.chatMessages.filter(m => m.type !== 'iteration' && m.type !== 'tokens');
  addChatMessage('assistant', '', { type: 'iteration', iterations: [...state.iterations] });
  if (state.sessionTokens.totalTokens > 0) {
    addChatMessage('system', `Tokens: P${state.sessionTokens.promptTokens} C${state.sessionTokens.completionTokens} T${state.sessionTokens.totalTokens}`, { type: 'tokens' });
  }
  renderChat();
}

function updateLiveIndicator() {
  const el = document.querySelector('.agent-loop-live-dot');
  if (!el) return;
  el.className = 'agent-loop-live-dot' + (state.sseConnected ? ' live' : ' stale');
}

function handleExtensionExecutionEvent(payload) {
  if (!payload || !payload.event) return;
  const { type, data } = payload.event;
  if (!state.extSession?.taskId) return;

  switch (type) {
    case 'iteration.started': {
      const it = {
        iteration: data?.iteration ?? state.iterations.length,
        url: data?.url ?? '',
        title: data?.title ?? '',
        actionLabel: data?.label ?? undefined,
        actionDetails: undefined,
        rawCompletion: undefined,
        tokenUsage: undefined,
        error: undefined,
      };
      state.iterations = [...state.iterations, it];
      updateAgentLoopInChat();
      break;
    }
    case 'llm.completion': {
      const updated = state.iterations.map(it => ({ ...it }));
      const last = updated[updated.length - 1];
      if (last) {
        if (data?.content) last.rawCompletion = data.content;
        if (data?.usage) last.tokenUsage = data.usage;
      }
      state.iterations = updated;
      if (data?.usage) {
        state.sessionTokens = {
          promptTokens: state.sessionTokens.promptTokens + (data.usage.promptTokens || 0),
          completionTokens: state.sessionTokens.completionTokens + (data.usage.completionTokens || 0),
          totalTokens: state.sessionTokens.totalTokens + (data.usage.totalTokens || 0),
        };
      }
      updateAgentLoopInChat();
      break;
    }
    case 'iteration.completed': {
      const updated = state.iterations.map(it => ({ ...it }));
      const last = updated[updated.length - 1];
      if (last && data) {
        if (data.label) last.actionLabel = data.label;
        if (data.url) last.actionDetails = data.url;
        if (data.error) last.error = data.error;
      }
      state.iterations = updated;
      updateAgentLoopInChat();
      break;
    }
    case 'screenshot': {
      if (data?.base64) {
        addChatMessage('assistant', '', {
          type: 'screenshot',
          screenshot: {
            base64: data.base64,
            mimeType: data.mimeType || 'image/jpeg',
            viewport: data.viewport || {},
            reason: data.reason || 'Page screenshot',
          },
        });
        renderChat();
      }
      break;
    }
  }
}

// ── Model Tier Switching ──
function updateModelTierPill() {
  const tier = state.preferences.modelTier || 'standard';
  els.modelTierLabel.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
  els.headerModel.hidden = false;
}

function hideModelTierDropdown() {
  els.modelTierDropdown.hidden = true;
}

function toggleModelTierDropdown() {
  els.modelTierDropdown.hidden = !els.modelTierDropdown.hidden;
  if (!els.modelTierDropdown.hidden) {
    // Highlight current tier
    const current = state.preferences.modelTier || 'standard';
    els.modelTierDropdown.querySelectorAll('.model-tier-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.tier === current);
    });
  }
}

async function switchModelTier(tier) {
  const validTiers = ['standard', 'premium', 'economy', 'custom'];
  if (!validTiers.includes(tier)) return;
  state.preferences.modelTier = tier;
  applyModelTierPreset(tier);
  els.modelTier.value = tier;
  onModelTierChange();
  updateModelTierPill();
  hideModelTierDropdown();
  await savePreferences();

  if (state.activeTask && state.activeTask.status === 'running') {
    await updateRunningTaskModel();
    showToast(`Switched to ${tier}`);
  } else {
    showToast(`Model tier: ${tier}`);
  }
}

function applyModelTierPreset(tier) {
  const tiers = {
    standard: { planner: 'deepseek-v4-pro', executor: 'deepseek-v4-flash' },
    premium: { planner: 'deepseek-v4-pro', executor: 'deepseek-v4-pro' },
    economy: { planner: 'deepseek-v4-flash', executor: 'deepseek-v4-flash' },
    custom: { planner: state.preferences.plannerModel || 'deepseek-v4-pro', executor: state.preferences.executorModel || 'deepseek-v4-flash' },
  };
  const preset = tiers[tier];
  if (preset && tier !== 'custom') {
    state.preferences.plannerModel = preset.planner;
    state.preferences.executorModel = preset.executor;
  }
}

async function updateRunningTaskModel() {
  const taskId = state.activeTask?.id || state.sessionTaskId;
  if (!taskId) return;
  try {
    await apiFetch(`/tasks/${taskId}/model`, {
      method: 'POST',
      body: JSON.stringify({
        plannerModel: resolvePlannerModel(),
        executorModel: resolveExecutorModel(),
        modelTier: state.preferences.modelTier,
      }),
    });
  } catch { /* silent — server may not support the endpoint yet */ }
}

// ── Events ──
function bindEvents() {
  els.sendButton.addEventListener('click', handleSubmit);
  els.goalInput.addEventListener('keydown', (e) => {
    // Command palette navigation
    if (!els.commandPalette.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); focusCommand(state.commandIdx + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); focusCommand(state.commandIdx - 1); return; }
      if (e.key === 'Enter') { e.preventDefault(); if (selectFocusedCommand()) return; }
      if (e.key === 'Escape') { e.preventDefault(); hideCommandPalette(); return; }
    }

    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); return; }
    if (e.key === 'Escape') {
      if (state.configOpen || state.historyOpen) { closeOverlays(); return; }
      if (state.contextFormOpen) { els.contextForm.hidden = true; state.contextFormOpen = false; return; }
    }
  });

  // Command palette trigger on input
  els.goalInput.addEventListener('input', () => {
    hideError();
    const val = els.goalInput.value;
    if (val.startsWith('/') && !val.includes(' ')) {
      showCommandPalette(val);
    } else {
      hideCommandPalette();
    }
  });

  // Model tier pill
  els.modelTierPill.addEventListener('click', (e) => { e.stopPropagation(); toggleModelTierDropdown(); });
  els.modelTierDropdown.querySelectorAll('.model-tier-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchModelTier(btn.dataset.tier);
    });
  });
  document.addEventListener('click', () => hideModelTierDropdown());

  // Config
  els.configToggle.addEventListener('click', toggleConfig);
  els.configClose.addEventListener('click', closeConfig);
  els.overlayBackdrop.addEventListener('click', closeOverlays);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      if (state.configOpen || state.historyOpen) { closeOverlays(); return; }
    }
    if (e.key === 'Enter' && mod) { e.preventDefault(); handleSubmit(); return; }
    if (e.key === ',' && mod) { e.preventDefault(); e.stopPropagation(); toggleConfig(); return; }
    if ((e.key === 'k' && mod) || (e.key === '/' && !mod && document.activeElement !== els.goalInput && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT')) {
      e.preventDefault();
      els.goalInput.focus();
      els.goalInput.select();
      return;
    }
    if (e.key === 'r' && mod) { e.preventDefault(); refresh(); return; }
    if (e.key === 'h' && mod) { e.preventDefault(); toggleHistory(); return; }
  });

  // Handoff
  els.handoffOpenTab.addEventListener('click', openAutomationTab);
  els.handoffResume.addEventListener('click', handleHandoffResume);
  els.handoffCancel.addEventListener('click', cancelTask);

  // History
  els.historyToggle.addEventListener('click', toggleHistory);
  els.historyClose.addEventListener('click', closeHistory);
  els.historyBack.addEventListener('click', backToHistoryList);
  els.newConversationInHistory.addEventListener('click', () => { closeHistory(); els.goalInput.focus(); });

  // Goals
  if (els.goalsToggle) {
    els.goalsToggle.addEventListener('click', () => {
      state.historyOpen = !state.historyOpen;
      state.historyViewPanel = 'goals';
      if (state.historyOpen) state.configOpen = false;
      render();
    });
  }
  if (els.newGoalBtn) {
    els.newGoalBtn.addEventListener('click', async () => {
      const title = prompt('Goal title:');
      if (!title || !title.trim()) return;
      try {
        await apiFetch('/goals', {
          method: 'POST',
          body: JSON.stringify({ title: title.trim() }),
        });
        refresh();
      } catch (err) {
        console.error('Failed to create goal:', err);
      }
    });
  }
  els.panelTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      state.historyViewPanel = tab.dataset.panel;
      renderHistoryPanel();
    });
  });

  // Config fields
  els.credsSave.addEventListener('click', saveCredentials);
  els.credsLoad.addEventListener('click', loadCredentialsFile);
  els.cookiePath.addEventListener('change', () => savePreferences());
  els.modelTier.addEventListener('change', onModelTierChange);
  els.plannerModel.addEventListener('change', () => savePreferences());
  els.executorModel.addEventListener('change', () => savePreferences());

  // Context
  els.contextToggle.addEventListener('click', () => {
    els.contextForm.hidden = false;
    els.contextArea.hidden = false;
    state.contextFormOpen = true;
    els.contextUrlInput.focus();
  });
  els.contextAddBtn.addEventListener('click', addContextFromForm);
  els.contextCancelBtn.addEventListener('click', () => {
    els.contextForm.hidden = true;
    state.contextFormOpen = false;
    els.contextUrlInput.value = '';
 els.contextTextInput.value = '';
  });

  // Screenshot lightbox
  els.screenshotLightboxClose.addEventListener('click', () => { els.screenshotLightbox.hidden = true; });
  els.screenshotLightbox.addEventListener('click', (e) => { if (e.target === els.screenshotLightbox) els.screenshotLightbox.hidden = true; });

  // Extension messages
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
    if (msg.payload?.type === 'execution_event') {
      handleExtensionExecutionEvent(msg.payload);
    }
  });
}

function addContextFromForm() {
  const url = els.contextUrlInput.value.trim();
  const text = els.contextTextInput.value.trim();
  if (url) {
    try { new URL(url); } catch { showError('Invalid URL'); return; }
    addContextRef('url', url, url);
  }
  if (text) {
    addContextRef('text', text, text.slice(0, 40));
  }
  els.contextUrlInput.value = '';
  els.contextTextInput.value = '';
  els.contextForm.hidden = true;
  state.contextFormOpen = false;
}

// ── Submit ──
async function handleSubmit() {
  const input = els.goalInput.value.trim();
  if (!input) return;

  // Check for command
  const parsed = parseCommand(input);
  if (parsed) {
    els.goalInput.value = '';
    hideCommandPalette();
    const handled = await executeCommand(parsed.cmd, parsed.args);
    if (handled) return;
    // If command wasn't handled (shouldn't happen), fall through as normal text
  }

  await submitGoal(input);
}

async function submitGoal(goal) {
  const plannerModel = resolvePlannerModel();
  const executorModel = resolveExecutorModel();
  if (!plannerModel || !executorModel) {
    showError('Planner and executor models are required. Check Settings (Ctrl+,).');
    return;
  }

  state.iterations = [];
  state.sessionTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  els.sendButton.disabled = true;

  const contextStr = formatContextString();
  const contextRefs = [...state.pendingContext];

  try {
    let task;

    if (state.extSession?.conversationId) {
      const res = await chrome.runtime.sendMessage({
        type: 'start_task',
        payload: { goal, plannerModel, executorModel, conversationId: state.extConversationId },
      });
      if (!res?.ok) throw new Error(res?.error || 'Extension start failed');
      state.extSession = res.session || state.extSession;
      task = { id: res.session?.taskId };
    } else {
      let convId = state.loadedConversationId;
      if (!convId) {
        const conv = await apiFetch('/conversations', { method: 'POST' });
        convId = conv.id;
        state.loadedConversationId = convId;
      }
      task = await apiFetch(`/conversations/${convId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: goal,
          plannerModel,
          browserConfig: buildBrowserConfig(),
          context: contextStr,
        }),
      });
      state.sessionTaskId = task.id;
      await savePreferences();
    }

    // Add user message to chat
    addChatMessage('user', goal, {
      contextRefs: contextRefs.length > 0 ? contextRefs : null,
    });
    state.pendingContext = [];
    renderContextChips();
    renderChat();

    els.goalInput.value = '';
    hideCommandPalette();
    await refresh();
  } catch (e) {
    const msg = e.message || 'Unknown error';
    if (msg.includes('model is required') || msg.includes('Planner model')) {
      showError('No model configured. Set models in Settings (Ctrl+,).');
    } else if (msg.includes('LLM Router')) {
      showError('AI model unavailable. Check model configuration in Settings.');
    } else {
      showError(msg);
    }
  } finally {
    els.sendButton.disabled = false;
  }
}

// ── Plan Actions ──
async function approvePlanById(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  els.sendButton.disabled = true;
  try {
    state.iterations = [];
    state.sessionTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    state.sessionTaskId = taskId;
    connectSSE();

    await apiFetch(`/tasks/${taskId}/run`, {
      method: 'POST',
      body: JSON.stringify({ executorModel: resolveExecutorModel() }),
    });
    // Remove the plan card and replace with a system message
    state.chatMessages = state.chatMessages.filter(m => m.type !== 'plan');
    addChatMessage('system', 'Task started — waiting for first observation...');
    renderChat();
    await savePreferences();
    await refresh();
  } catch (e) {
    showError(e.message);
  } finally {
    els.sendButton.disabled = false;
  }
}

async function cancelPlanById(taskId) {
  try {
    await apiFetch(`/tasks/${taskId}/cancel`, { method: 'POST' });
    state.sessionTaskId = null;
    state.iterations = [];
    state.sessionTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    state.chatMessages = state.chatMessages.filter(m => m.taskId !== taskId);
    addChatMessage('system', 'Plan cancelled.');
    renderChat();
    await savePreferences();
    await refresh();
  } catch (e) {
    showError(e.message);
  }
}

async function cancelTask() {
  const task = state.activeTask;
  if (!task) return;
  try {
    await apiFetch(`/tasks/${task.id}/cancel`, { method: 'POST' });
    state.sessionTaskId = null;
    state.iterations = [];
    state.sessionTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    addChatMessage('system', 'Task cancelled.');
    renderChat();
    await savePreferences();
    await refresh();
  } catch (e) {
    showError(e.message);
  }
}

async function resumeTask() {
  const task = state.activeTask || state.loadedTask;
  if (!task) return;
  try {
    await apiFetch(`/tasks/${task.id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ plannerModel: resolvePlannerModel() }),
    });
    await apiFetch(`/tasks/${task.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ executorModel: resolveExecutorModel() }),
    });
    addChatMessage('system', 'Resuming task...');
    renderChat();
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

function isExtensionTask(task) {
  return Boolean(task && (task.executionSource === 'extension' || state.extSession?.taskId === task.id));
}

function getLatestTaskUrl(taskEvents) {
  const event = taskEvents.find(item => item.summary?.url || item.data?.url || item.summary?.action === 'navigate');
  return event?.summary?.url || event?.data?.url || null;
}

async function openAutomationTab() {
  if (state.extSession?.tabId) {
    try { await chrome.tabs.update(state.extSession.tabId, { active: true }); return; } catch { /* fall through */ }
  }
  const taskEvents = filterTaskEvents();
  const url = getLatestTaskUrl(taskEvents);
  if (url) {
    const [tab] = await chrome.tabs.query({ url });
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
  } catch (e) { showError(e.message); }
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
    state.goals = svcState.goals || [];
    if (cfg) state.runtimeConfig = cfg;
    deriveActiveConversation();
    if (state.loadedConversationId) {
      state.loadedTask = selectCurrentTask(svcState.tasks, state.loadedConversationId);
    }
    if (state.activeTask && ['completed', 'failed', 'cancelled'].includes(state.activeTask.status)) {
      if (state.sessionTaskId === state.activeTask.id) {
        state.sessionTaskId = null;
        savePreferences();
      }
    }
    if (!state.sseConnected && state.activeTask?.id) {
      const polledIterations = deriveIterations(state.activeTask.id, state.events);
      if (polledIterations.length > 0) {
        state.iterations = polledIterations;
        let pt = 0, ct = 0, tt = 0;
        for (const it of polledIterations) {
          if (it.tokenUsage) { pt += it.tokenUsage.promptTokens || 0; ct += it.tokenUsage.completionTokens || 0; tt += it.tokenUsage.totalTokens || 0; }
        }
        if (tt > 0) state.sessionTokens = { promptTokens: pt, completionTokens: ct, totalTokens: tt };
      }
    }
    if (state.activeTask?.status === 'running' && state.iterations.length > 0) {
      updateAgentLoopInChat();
    }
    render();
  } catch {
    render();
  }
}

function deriveActiveConversation() {
  const task = state.activeTask;
  if (task?.conversationId) {
    state.activeConversation = state.conversations.find(c => c.id === task.conversationId) || null;
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
    applyModelTierPreset(tier);
  }
  savePreferences();
}

function toggleConfig() {
  state.configOpen = !state.configOpen;
  if (state.configOpen) state.historyOpen = false;
  renderPanels();
}

function closeConfig() {
  state.configOpen = false;
  renderPanels();
}

function saveCredentials() {
  try {
    const text = els.credsEditor.value.trim();
    if (!text) { state.preferences.credentials = null; }
    else { JSON.parse(text); state.preferences.credentials = text; }
    savePreferences();
  } catch { showError('Invalid JSON in credentials'); }
}

async function loadCredentialsFile() {
  try {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      JSON.parse(text);
      els.credsEditor.value = text;
      state.preferences.credentials = text;
      await savePreferences();
    };
    input.click();
  } catch { showError('Failed to load credentials file'); }
}

// ── Preferences ──
async function loadPreferences() {
  try {
    const stored = await chrome.storage.local.get(STORE_KEY);
    const data = stored?.[STORE_KEY];
    if (data && typeof data === 'object') {
      state.preferences = { ...state.preferences, ...(data.preferences || data) };
      if (data.sessionTaskId) state.sessionTaskId = data.sessionTaskId;
      // Restore session if we had an active task
      if (data.sessionTaskId && !state.activeTask) {
        // Will be populated by refresh()
      }
    }
  } catch { /* ignore */ }
}

async function savePreferences() {
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
  updateModelTierPill();
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

  // Header
  renderHeader(task);
  renderHistoryToggleState();
  renderPanels();
  updateModelTierPill();

  const planSignal = getPlanSignal(task, state.events);
  const handoffSignal = getModelHandoffSignal(task, state.events);

  // Handoff banner
  if (handoffSignal) {
    renderHandoffBanner(handoffSignal, task);
  } else {
    els.handoffBanner.hidden = true;
  }

  // Build chat timeline from state
  buildChatTimeline(task, planSignal);

  // Show empty state if no messages
  if (state.chatMessages.length === 0) {
    els.chatEmpty.hidden = false;
  }

  renderChat();
  renderContextChips();
}

function buildChatTimeline(task, planSignal) {
  // Only rebuild if the task state changed significantly
  const lastMsg = state.chatMessages[state.chatMessages.length - 1];

  if (!task) {
    // No active task — check if we have a loaded conversation to display
    if (state.loadedConversationId && state.chatMessages.length === 0) {
      const conv = state.conversations.find(c => c.id === state.loadedConversationId);
      if (conv) {
        const messages = buildChatMessages(conv, state.loadedTask, null);
        for (const msg of messages) {
          addChatMessage(msg.role, msg.content, { type: msg.tone === 'notice' ? 'system' : 'text' });
        }
      }
    }
    return;
  }

  // Plan signal → plan card
  if (planSignal && !state.chatMessages.some(m => m.type === 'plan' && m.planBadge === planSignal.badge)) {
    // Remove previous plan cards for this task
    state.chatMessages = state.chatMessages.filter(m => m.type !== 'plan');
    addChatMessage('assistant', planSignal.summary || '', {
      type: 'plan',
      planDraft: { steps: planSignal.steps || [] },
      planBadge: planSignal.badge,
      planActionable: planSignal.actionable,
      taskId: task.id,
      planId: task.planId || null,
    });
  }

  // Task status transitions
  if (task.status === 'completed' && !state.chatMessages.some(m => m.type === 'result')) {
    addChatMessage('assistant', task.resultSummary || 'Task completed.', {
      type: 'result',
      resultSummary: task.resultSummary,
    });
  }

  if (task.status === 'failed' && !state.chatMessages.some(m => m.type === 'text' && m.content.includes('failed'))) {
    addChatMessage('system', `Task failed${task.resultSummary ? ': ' + task.resultSummary : ''}`);
  }

  // Ensure agent loop is in chat if running
  if (task.status === 'running' && state.iterations.length > 0) {
    updateAgentLoopInChat();
  }
}

function renderHeader(task) {
  const status = task?.status || 'idle';
  els.statusDot.className = 'status-dot ' + statusClass(status);
  els.statusLabel.textContent = statusLabel(status);
  if (!task && state.loadedConversationId) {
    const conv = state.conversations.find(c => c.id === state.loadedConversationId);
    els.headerGoal.textContent = getConversationTitle(conv) || 'Auto Browser';
  } else {
    els.headerGoal.textContent = 'Auto Browser';
  }
  els.headerModel.hidden = !task;
}

function renderHandoffBanner(signal, task) {
  const isExt = isExtensionTask(task);
  const taskEvents = filterTaskEvents();
  els.handoffBanner.hidden = false;
  els.handoffTitle.textContent = signal.title;
  els.handoffMessage.textContent = isExt
    ? `Model requests human intervention: ${signal.reason}. Return to sidebar when done.`
    : `Model requests human intervention: ${signal.reason}. Click Continue when done to replan remaining steps.`;
  els.handoffResume.disabled = false;
  els.handoffOpenTab.hidden = !isExt && !getLatestTaskUrl(taskEvents);
}

function closeOverlays() {
  state.configOpen = false;
  state.historyOpen = false;
  hideModelTierDropdown();
  renderPanels();
  renderHistoryToggleState();
}

function renderPanels() {
  renderConfig();
  renderHistoryPanel();
  renderGoalsPanel();
  els.overlayBackdrop.hidden = !(state.configOpen || state.historyOpen);
}

function renderConfig() {
  const open = state.configOpen;
  els.configPanel.classList.toggle('open', open);
  els.configPanel.setAttribute('aria-hidden', String(!open));
}

// ── History Views ──
function toggleHistory() {
  state.historyOpen = !state.historyOpen;
  if (state.historyOpen) {
    state.configOpen = false;
    if (state.historyViewMode !== 'detail') state.historyViewMode = 'list';
  }
  render();
}

function closeHistory() {
  state.historyOpen = false;
  state.selectedHistoryConversationId = null;
  state.historyViewMode = 'list';
  renderPanels();
  renderHistoryToggleState();
}

function backToHistoryList() {
  state.historyViewMode = 'list';
  state.selectedHistoryConversationId = null;
  renderHistoryPanel();
}

function renderHistoryToggleState() {
  const active = state.historyOpen;
  els.historyToggle.classList.toggle('active', active);
  els.historyToggle.setAttribute('aria-pressed', String(active));
}

function renderHistoryPanel() {
  const open = state.historyOpen;
  els.historyPanel.classList.toggle('open', open);
  els.historyPanel.setAttribute('aria-hidden', String(!open));
  if (!open) { els.historyView.hidden = true; els.historyDetailView.hidden = true; els.goalsView.hidden = true; return; }

  // Determine active tab
  const activeTab = state.historyViewPanel || 'history';
  els.historyView.hidden = activeTab !== 'history';
  els.historyDetailView.hidden = true; // detail view controlled separately
  els.goalsView.hidden = activeTab !== 'goals';

  if (activeTab === 'history') {
    if (state.historyViewMode === 'detail') { renderHistoryDetail(); } else { renderHistoryList(); }
  } else if (activeTab === 'goals') {
    renderGoalsList();
  }

  // Update tab active state
  els.panelTabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.panel === activeTab);
  });
}

function renderGoalsList() {
  if (!els.goalsList) return;
  const goals = state.goals || [];
  els.goalsEmpty.hidden = goals.length > 0;
  els.goalsList.innerHTML = goals.map(g => `
    <li class="history-item" data-goal-id="${g.id}">
      <div class="history-item-title">${escapeHtml(g.title)}</div>
      <div class="history-item-meta">${g.status} · ${(g.createdAt || '').slice(0, 10)}</div>
    </li>
  `).join('');

  els.goalsList.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const goalId = item.dataset.goalId;
      const goal = state.goals.find(g => g.id === goalId);
      if (!goal) return;
      // Find task associated with this goal
      const task = state.tasks.find(t => t.goalId === goalId);
      if (task) {
        state.loadedConversationId = task.conversationId;
        state.loadedTask = task;
        state.historyOpen = false;
        state.historyViewPanel = 'history';
        refresh();
      }
    });
  });
}

function renderHistoryList() {
  els.historyView.hidden = false;
  els.historyDetailView.hidden = true;
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
    const date = conv.updatedAt ? new Date(conv.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
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
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;
  const latestTask = selectCurrentTask(state.tasks, id);
  state.loadedConversationId = id;
  state.loadedTask = latestTask;
  state.selectedHistoryConversationId = null;
  state.historyViewMode = 'list';
  state.historyOpen = false;
  // Rebuild chat from conversation
  state.chatMessages = [];
  state.iterations = [];
  const messages = buildChatMessages(conv, latestTask, null);
  for (const msg of messages) {
    addChatMessage(msg.role, msg.content, { type: msg.tone === 'notice' ? 'system' : 'text' });
  }
  render();
}

function renderHistoryDetail() {
  els.historyView.hidden = true;
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

// ── Helpers ──
function filterTaskEvents() {
  const taskId = state.activeTask?.id;
  if (!taskId) return [];
  return (state.events || []).filter(e => e.taskId === taskId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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
    idle: 'Idle',
    draft: 'Draft',
    ready: 'Ready',
    running: 'Running',
    handoff: 'Handoff',
    blocked: 'Blocked',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return map[status] || status;
}
