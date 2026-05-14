import {
  createEmptySession,
  getOrigin,
  hostPatternForOrigin,
  reduceSession,
  shouldRequestPermission,
} from './background-state.js';
import { resolveAutomationTabUrl } from './start-task.js';

const API_BASE = 'http://127.0.0.1:4317/api';
const CONTENT_SCRIPT = 'content-script.js';

let session = createEmptySession();
const actionHistory = [];

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleRuntimeMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      const lastError = error instanceof Error ? error.message : String(error);
      session = reduceSession(session, { lastError });
      emitSession();
      sendResponse({ ok: false, error: lastError });
    });
  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId !== session.tabId || changeInfo.status !== 'complete') return;
  const nextOrigin = getOrigin(tab.url);
  if (!nextOrigin) return;
  if (shouldRequestPermission(session, nextOrigin)) {
    session = reduceSession(session, {
      origin: nextOrigin,
      permission: 'pending',
      status: 'blocked',
      lastError: `Permission required for ${nextOrigin}`,
    });
    emitSession();
    await notifySidepanel({
      type: 'permission_required',
      origin: nextOrigin,
      taskId: session.taskId,
    });
    return;
  }
  await ensureContentScript(tabId);
});

async function handleRuntimeMessage(message) {
  switch (message?.type) {
    case 'get_session':
      return { session };
    case 'start_task':
      return startTask(message.payload ?? {});
    case 'request_permission':
      return requestPermission(message.origin);
    case 'resume_extension':
      return resumeExtensionExecution();
    case 'handoff_task':
      return handoffTask();
    case 'sidepanel_event':
      return {};
    default:
      throw new Error(`Unsupported background message: ${String(message?.type)}`);
  }
}

async function startTask(payload) {
  const state = await fetchJson('/state');
  if (state.activeTask) {
    throw new Error('Only one active task can run at a time');
  }

  const requestedConversationId =
    typeof payload.conversationId === 'string' && payload.conversationId.trim()
      ? payload.conversationId.trim()
      : session.conversationId;
  const conversation = requestedConversationId
    ? { id: requestedConversationId }
    : await fetchJson('/conversations', { method: 'POST' });
  const task = await fetchJson(`/conversations/${conversation.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: payload.goal,
      plannerModel: payload.plannerModel,
      browserConfig: {
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
        launchMode: 'auto',
        extensionEnabled: true,
        previewEnabled: true,
      },
    }),
  });

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const automationUrl = resolveAutomationTabUrl(activeTab?.url);
  const tab = await chrome.tabs.create({ url: automationUrl, active: true });
  await fetchJson(`/tasks/${task.id}/approve-extension`, {
    method: 'POST',
    body: JSON.stringify({ executorModel: payload.executorModel }),
  });

  const nextOrigin = getOrigin(tab.url);
  session = reduceSession(createEmptySession(), {
    sessionId: session.sessionId ?? crypto.randomUUID(),
    conversationId: conversation.id,
    taskId: task.id,
    tabId: tab.id ?? null,
    origin: nextOrigin,
    status: 'running',
    permission: nextOrigin ? 'pending' : 'unknown',
    lastError: null,
  });
  actionHistory.length = 0;
  emitSession();

  if (tab.id) {
    await ensurePermissionOrBlock(tab.id, tab.url).catch(() => undefined);
  }
  return { session, task };
}

async function requestPermission(origin) {
  const pattern = hostPatternForOrigin(origin);
  if (!pattern) {
    throw new Error(`Invalid origin: ${origin}`);
  }
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    session = reduceSession(session, {
      status: 'blocked',
      permission: 'denied',
      lastError: `Permission denied for ${origin}`,
    });
    emitSession();
    if (session.taskId) {
      await fetchJson(`/tasks/${session.taskId}/report`, {
        method: 'POST',
        body: JSON.stringify({
          phase: 'blocked',
          outcome: 'blocked',
          message: `Permission denied for ${origin}`,
        }),
      });
    }
    return { granted: false, session };
  }

  session = reduceSession(session, {
    origin,
    permission: 'granted',
    status: 'running',
    lastError: null,
  });
  emitSession();
  if (session.tabId !== null) {
    await ensureContentScript(session.tabId);
  }
  await resumeExtensionExecution();
  return { granted: true, session };
}

async function resumeExtensionExecution() {
  if (!session.taskId || session.tabId === null) {
    throw new Error('No active extension task');
  }
  const tab = await chrome.tabs.get(session.tabId);
  await ensurePermissionOrBlock(session.tabId, tab.url);
  let loops = 0;
  let repeatedObservationCount = 0;
  let previousObservationSignature = '';
  let pendingVisualReason = null;

  while (loops < 20) {
    loops += 1;
    const observationResponse = await sendToTab(session.tabId, { type: 'observe_page' });
    const observation = observationResponse.observation;
    const observationSignature = JSON.stringify({
      url: observation?.url,
      title: observation?.title,
      visibleText: observation?.visibleText,
      refs: observation?.refs,
    });
    repeatedObservationCount = observationSignature === previousObservationSignature ? repeatedObservationCount + 1 : 0;
    previousObservationSignature = observationSignature;
    const visualReason =
      pendingVisualReason || getVisualObservationReason(session.goal || '', observation, repeatedObservationCount);
    pendingVisualReason = null;
    if (visualReason) {
      const visual = await captureViewportVisual(session.tabId, visualReason).catch(() => null);
      if (!visual) {
        const action = {
          action: 'handoff',
          reason: 'canvas UI requires visual-capable executor',
          label: 'Request handoff',
        };
        await fetchJson(`/tasks/${session.taskId}/report`, {
          method: 'POST',
          body: JSON.stringify({
            phase: 'completed',
            action,
            outcome: 'blocked',
            message: action.reason,
            observationSummary: `${observation.title} • ${observation.url}`,
          }),
        });
        session = reduceSession(session, { status: 'blocked', lastError: action.reason });
        emitSession();
        return { session };
      }
      observation.visual = visual;
    }
    const action = await fetchJson(`/tasks/${session.taskId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ observation, history: actionHistory.slice(-8) }),
    });

    await fetchJson(`/tasks/${session.taskId}/report`, {
      method: 'POST',
      body: JSON.stringify({
        phase: 'action_started',
        action,
        observationSummary: `${observation.title} • ${observation.url}`,
      }),
    });

    session = reduceSession(session, {
      status: action.action === 'handoff' ? 'blocked' : 'running',
      stepLabel: action.label || action.action,
      lastError: null,
    });
    emitSession();

    if (action.action === 'finish') {
      await fetchJson(`/tasks/${session.taskId}/report`, {
        method: 'POST',
        body: JSON.stringify({
          phase: 'completed',
          action,
          outcome: 'success',
          message: action.message || 'Completed',
          observationSummary: `${observation.title} • ${observation.url}`,
        }),
      });
      session = reduceSession(session, { status: 'completed', stepLabel: action.label || 'Finished' });
      emitSession();
      return { session };
    }

    if (action.action === 'handoff') {
      await fetchJson(`/tasks/${session.taskId}/report`, {
        method: 'POST',
        body: JSON.stringify({
          phase: 'completed',
          action,
          outcome: 'blocked',
          message: action.reason,
          observationSummary: `${observation.title} • ${observation.url}`,
        }),
      });
      session = reduceSession(session, { status: 'blocked', lastError: action.reason });
      emitSession();
      return { session };
    }

    let runResult;
    try {
      runResult = await sendToTab(session.tabId, { type: 'run_action', action });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pendingVisualReason = getVisualRetryReason(message, observation);
      if (!pendingVisualReason) {
        throw error;
      }
      actionHistory.push({ action, outcome: { status: 'failed', label: action.label || action.action, error: message }, observedAt: new Date().toISOString() });
      continue;
    }
    actionHistory.push({ action, outcome: runResult.outcome, observedAt: new Date().toISOString() });

    await fetchJson(`/tasks/${session.taskId}/report`, {
      method: 'POST',
      body: JSON.stringify({
        phase: 'action_completed',
        action,
        outcome: runResult.outcome?.status === 'blocked' ? 'blocked' : 'success',
        observationSummary: runResult.outcome?.label || action.action,
      }),
    });

    if (action.action === 'navigate') {
      return { session };
    }
  }

  throw new Error('Extension execution exceeded 20 decision loops');
}

async function handoffTask() {
  if (!session.taskId) {
    return { session };
  }
  await fetchJson(`/tasks/${session.taskId}/handoff`, {
    method: 'POST',
    body: JSON.stringify({ source: 'extension_sidepanel' }),
  });
  session = reduceSession(session, { status: 'blocked', lastError: 'Task handed off to user' });
  emitSession();
  return { session };
}

async function ensurePermissionOrBlock(tabId, rawUrl) {
  const origin = getOrigin(rawUrl);
  if (!origin) {
    session = reduceSession(session, { permission: 'unknown', origin: null });
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [hostPatternForOrigin(origin)] });
  if (!granted) {
    session = reduceSession(session, {
      origin,
      permission: 'pending',
      status: 'blocked',
      lastError: `Permission required for ${origin}`,
    });
    emitSession();
    await notifySidepanel({ type: 'permission_required', origin, taskId: session.taskId });
    throw new Error(`Permission required for ${origin}`);
  }
  session = reduceSession(session, { origin, permission: 'granted', status: 'running', lastError: null });
  emitSession();
  await ensureContentScript(tabId);
}

async function ensureContentScript(tabId) {
  try {
    await sendToTab(tabId, { type: 'show_visual', visual: { label: session.stepLabel || 'Connected' } });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT],
    });
  }
}

async function sendToTab(tabId, message) {
  const response = await chrome.tabs.sendMessage(tabId, message);
  if (!response?.ok) {
    throw new Error(response?.error || 'Content script request failed');
  }
  return response;
}

async function captureViewportVisual(tabId, reason) {
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  const viewport = await sendToTab(tabId, { type: 'viewport_size' }).catch(() => ({
    width: tab.width || 1280,
    height: tab.height || 720,
  }));
  return {
    base64: match[2],
    mimeType: match[1],
    viewport: {
      width: Number(viewport.width || tab.width || 1280),
      height: Number(viewport.height || tab.height || 720),
    },
    reason,
  };
}

function getVisualObservationReason(goal, observation, repeatedObservationCount) {
  const canvasRects = Array.isArray(observation?.canvasRects) ? observation.canvasRects : [];
  if (canvasRects.length === 0) return null;
  const refCount = Array.isArray(observation?.refs) ? observation.refs.length : 0;
  if (refCount < 2) return 'visible canvas with too few semantic refs';
  if (repeatedObservationCount >= 2) return 'visible canvas after repeated unchanged observations';
  const text = `${goal || ''}\n${observation?.visibleText || ''}`;
  if (/\b(canvas|game|chart|graph|diagram|map|drawing|whiteboard)\b|图形|画布|地图|图表|游戏/i.test(text)) {
    return 'task or page text suggests a graphical canvas UI';
  }
  return null;
}

function getVisualRetryReason(message, observation) {
  const canvasRects = Array.isArray(observation?.canvasRects) ? observation.canvasRects : [];
  if (canvasRects.length === 0) return null;
  if (/target ref not found|unknown snapshot ref|invalid action payload|ref .*not found/i.test(message)) {
    return 'ref action failed on a visible canvas page';
  }
  return null;
}

async function fetchJson(path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.problem || `HTTP ${response.status}`);
  }
  return response.json();
}

async function notifySidepanel(message) {
  await chrome.runtime.sendMessage({ type: 'sidepanel_event', payload: message }).catch(() => undefined);
}

function emitSession() {
  notifySidepanel({ type: 'session_updated', session }).catch(() => undefined);
}
