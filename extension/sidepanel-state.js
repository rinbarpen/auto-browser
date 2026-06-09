function getTimestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortConversationsByRecent(conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) {
    return [];
  }

  return [...conversations].sort((left, right) => {
    const updatedDelta = getTimestamp(right.updatedAt) - getTimestamp(left.updatedAt);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return getTimestamp(right.createdAt) - getTimestamp(left.createdAt);
  });
}

export function resolveInitialConversationId(conversations, sessionConversationId, storedConversationId) {
  if (sessionConversationId && conversations.some((conversation) => conversation.id === sessionConversationId)) {
    return sessionConversationId;
  }
  if (storedConversationId && conversations.some((conversation) => conversation.id === storedConversationId)) {
    return storedConversationId;
  }
  return sortConversationsByRecent(conversations)[0]?.id ?? null;
}

export function selectCurrentConversation(conversations, selectedConversationId) {
  if (!selectedConversationId) {
    return null;
  }
  return conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;
}

export function getFallbackConversationTitle(conversation) {
  const firstUserMessage = (conversation?.messages ?? []).find((message) => message.role === 'user');
  const text = String(firstUserMessage?.content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return 'Untitled conversation';
  }
  return text.slice(0, 56) + (text.length > 56 ? '…' : '');
}

export function getConversationTitle(conversation) {
  const explicitTitle = String(conversation?.title ?? '').trim();
  return explicitTitle || getFallbackConversationTitle(conversation);
}

export function selectNextConversationIdAfterDelete(conversations, deletedConversationId) {
  return sortConversationsByRecent(conversations).find((conversation) => conversation.id !== deletedConversationId)?.id ?? null;
}

export function selectCurrentTask(tasks, conversationId) {
  if (!conversationId) {
    return null;
  }

  const matchingTasks = tasks.filter((task) => task.conversationId === conversationId);
  if (matchingTasks.length === 0) {
    return null;
  }

  return [...matchingTasks].sort((left, right) => {
    const updatedDelta = getTimestamp(right.updatedAt) - getTimestamp(left.updatedAt);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return getTimestamp(right.createdAt) - getTimestamp(left.createdAt);
  })[0] ?? null;
}

export function buildChatMessages(conversation, task, transientNotice) {
  if (!conversation) {
    const messages = [
      {
        role: 'assistant',
        tone: 'empty',
        content: 'Describe the next goal. Auto Browser will continue from the current page in a dedicated automation tab.',
      },
    ];
    if (transientNotice) {
      messages.push({ role: 'assistant', content: transientNotice, tone: 'notice' });
    }
    return messages;
  }

  const messages = (conversation.messages ?? []).map((message) => ({
    role: message.role,
    content: message.content,
    tone: message.role === 'assistant' ? 'default' : 'default',
  }));

  const draftContent =
    task?.status !== 'completed' && task?.planDraft?.summary ? `Draft ready: ${task.planDraft.summary}` : null;
  const resultContent = task?.status === 'completed' && task.resultSummary ? task.resultSummary : null;

  if (draftContent && !messages.some((message) => message.role === 'assistant' && message.content === draftContent)) {
    messages.push({ role: 'assistant', content: draftContent, tone: 'default' });
  }

  if (resultContent && !messages.some((message) => message.role === 'assistant' && message.content === resultContent)) {
    messages.push({ role: 'assistant', content: resultContent, tone: 'default' });
  }

  if (transientNotice) {
    messages.push({ role: 'assistant', content: transientNotice, tone: 'notice' });
  }

  return messages;
}

export function filterTaskEvents(events, taskId) {
  if (!taskId) {
    return [];
  }
  return (events ?? []).filter((event) => event.taskId === taskId).slice(-40).reverse();
}

export function getPlanSignal(task, events) {
  if (!task?.id || !task.planDraft) {
    return null;
  }

  const event = getEventsForTask(events, task.id)
    .filter((item) => item.type === 'task.drafted' || item.type === 'task.replanned')
    .sort((left, right) => getTimestamp(right.createdAt) - getTimestamp(left.createdAt))[0];

  if (!event) {
    return null;
  }

  return {
    taskId: task.id,
    eventType: event.type,
    badge: event.type === 'task.replanned' ? 'Replanned' : 'Draft',
    goal: task.goal || '',
    summary: task.planDraft.summary || '',
    steps: Array.isArray(task.planDraft.steps) ? task.planDraft.steps : [],
    actionable: task.status === 'draft' || task.status === 'ready',
  };
}

export function getModelHandoffSignal(task, events) {
  if (!task?.id || !['running', 'handoff', 'blocked'].includes(task.status)) {
    return null;
  }

  const taskEvents = getEventsForTask(events, task.id);
  const boundaryTimestamp = getLatestExecutionBoundaryTimestamp(taskEvents);
  const handoffEvents = taskEvents
    .map((event) => toModelHandoffCandidate(event, task))
    .filter(Boolean)
    .filter((candidate) => getTimestamp(candidate.createdAt) >= boundaryTimestamp)
    .filter((candidate) => !isNonModelHandoffReason(candidate.reason))
    .sort((left, right) => getTimestamp(right.createdAt) - getTimestamp(left.createdAt));

  const signal = handoffEvents[0];
  if (!signal) {
    return null;
  }

  return {
    taskId: task.id,
    title: isCaptchaReason(signal.reason) ? '需要验证码操作' : '需要人工操作',
    reason: signal.reason,
    sourceEventType: signal.type,
  };
}

export function formatPageContext(tab) {
  if (!tab) {
    return 'No active browser tab';
  }

  const title = tab.title || 'Untitled';
  const url = tab.url || '';
  return `${title} • ${url}`;
}

function getEventsForTask(events, taskId) {
  if (!taskId) {
    return [];
  }
  return (events ?? []).filter((event) => event?.taskId === taskId);
}

function toModelHandoffCandidate(event, task) {
  if (!event) {
    return null;
  }

  if (
    event.summary?.action === 'handoff' &&
    ['task.execution.action_started', 'task.execution.completed', 'task.execution.iteration.completed'].includes(event.type)
  ) {
    return {
      type: event.type,
      createdAt: event.createdAt,
      reason: String(event.summary.reason || event.data?.message || task.resultSummary || '').trim(),
    };
  }

  if (event.type === 'task.execution.llm.completion') {
    const parsed = parseExecutorJson(String(event.data?.content ?? ''));
    if (parsed?.action === 'handoff') {
      return {
        type: event.type,
        createdAt: event.createdAt,
        reason: String(parsed.reason || event.data?.message || task.resultSummary || '').trim(),
      };
    }
  }

  return null;
}

function getLatestExecutionBoundaryTimestamp(events) {
  const boundaryEvent = (events ?? [])
    .filter((event) => event.type === 'task.running' || event.type === 'task.replanned')
    .sort((left, right) => getTimestamp(right.createdAt) - getTimestamp(left.createdAt))[0];
  return boundaryEvent ? getTimestamp(boundaryEvent.createdAt) : 0;
}

function parseExecutorJson(content) {
  const text = content.trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function isCaptchaReason(reason) {
  return /captcha|verify|verification|验证|验证码|人机/i.test(reason);
}

function isNonModelHandoffReason(reason) {
  const text = String(reason || '').trim();
  if (!text || /^blocked$/i.test(text)) {
    return true;
  }
  return /permission (required|denied)|exceed(?:ed|ing)|iteration budget|max iterations|visual-capable executor|canvas UI requires visual|task handed off to user/i.test(text);
}

export function deriveIterations(taskId, events) {
  if (!taskId) return [];
  const taskEvents = (events ?? [])
    .filter((e) => e.taskId === taskId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const iterations = [];
  let current = null;

  for (const event of taskEvents) {
    switch (event.type) {
      case 'task.execution.iteration.started': {
        if (current) iterations.push(current);
        current = {
          iteration: event.data?.iteration ?? iterations.length,
          url: event.data?.url ?? event.summary?.url ?? '',
          title: event.data?.title ?? event.summary?.title ?? '',
          actionLabel: event.summary?.label ?? undefined,
          actionDetails: event.summary?.url ?? undefined,
          rawCompletion: undefined,
          tokenUsage: undefined,
          error: undefined,
        };
        break;
      }
      case 'task.execution.llm.completion': {
        if (!current) {
          current = { iteration: iterations.length, url: '', title: '', rawCompletion: undefined, tokenUsage: undefined };
        }
        if (event.data?.content) current.rawCompletion = event.data.content;
        if (event.data?.usage) current.tokenUsage = event.data.usage;
        break;
      }
      case 'task.execution.iteration.completed': {
        if (!current) {
          current = { iteration: iterations.length, url: '', title: '', rawCompletion: undefined, tokenUsage: undefined };
        }
        if (event.summary?.label) current.actionLabel = event.summary.label;
        if (event.summary?.url) current.actionDetails = event.summary.url;
        if (event.summary?.title) current.actionDetails = event.summary.title;
        if (event.summary?.error) current.error = event.summary.error;
        iterations.push(current);
        current = null;
        break;
      }
      case 'task.execution.action_started': {
        if (!current) {
          current = { iteration: iterations.length, url: '', title: '', rawCompletion: undefined, tokenUsage: undefined };
        }
        if (event.summary?.label) current.actionLabel = event.summary.label;
        break;
      }
      case 'task.execution.action_completed': {
        if (!current) {
          current = { iteration: iterations.length, url: '', title: '', rawCompletion: undefined, tokenUsage: undefined };
        }
        if (event.summary?.label) current.actionLabel = event.summary.label;
        if (event.summary?.url) current.actionDetails = event.summary.url;
        if (event.summary?.error) current.error = event.summary.error;
        break;
      }
    }
  }
  if (current) iterations.push(current);

  return iterations;
}

export function createDefaultLlmPreset(plannerModel = '', executorModel = '') {
  const now = new Date().toISOString();
  return {
    id: 'default',
    name: 'Default',
    active: true,
    roles: {
      planner: createRoleSettings('planner', plannerModel, true, now),
      executor: createRoleSettings('executor', executorModel, true, now),
      vision: createRoleSettings('vision', '', false, now),
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultProviderPreset() {
  const now = new Date().toISOString();
  return {
    id: 'default-provider',
    name: 'Local LLM router',
    provider: 'llm-router',
    baseUrl: 'http://127.0.0.1:18000/v1',
    apiKey: '',
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeLlmPreferences(value) {
  const input = value && typeof value === 'object' ? value : {};
  const { plannerModel, executorModel, providerPresets: _providerPresets, ...rest } = input;
  const rawPresets = Array.isArray(input.llmPresets) && input.llmPresets.length > 0
    ? input.llmPresets
    : [createDefaultLlmPreset(String(plannerModel ?? ''), String(executorModel ?? ''))];
  const providerPresets = normalizeProviderPresets(input.providerPresets, rawPresets);
  const presets = rawPresets.map((preset) => normalizeLlmPreset(preset, providerPresets));
  const activeLlmPresetId = presets.some((preset) => preset.id === input.activeLlmPresetId)
    ? input.activeLlmPresetId
    : presets[0].id;
  return {
    ...rest,
    providerPresets,
    llmPresets: presets.map((preset) => ({ ...preset, active: preset.id === activeLlmPresetId })),
    activeLlmPresetId,
  };
}

export function getActiveLlmPreset(preferences) {
  const normalized = normalizeLlmPreferences(preferences);
  return normalized.llmPresets.find((preset) => preset.id === normalized.activeLlmPresetId) ?? normalized.llmPresets[0];
}

function normalizeLlmPreset(preset, providerPresets) {
  const now = new Date().toISOString();
  const input = preset && typeof preset === 'object' ? preset : {};
  return {
    id: String(input.id ?? `preset-${Date.now()}`),
    name: String(input.name ?? 'Preset'),
    active: Boolean(input.active),
    roles: {
      planner: normalizeRoleSettings('planner', input.roles?.planner, now, providerPresets),
      executor: normalizeRoleSettings('executor', input.roles?.executor, now, providerPresets),
      vision: normalizeRoleSettings('vision', input.roles?.vision, now, providerPresets),
    },
    createdAt: String(input.createdAt ?? now),
    updatedAt: String(input.updatedAt ?? now),
  };
}

function normalizeRoleSettings(role, input, now, providerPresets) {
  const providerPreset = resolveRoleProviderPreset(input, providerPresets);
  return createRoleSettings(
    role,
    String(input?.model ?? ''),
    input?.enabled ?? role !== 'vision',
    String(input?.updatedAt ?? now),
    {
      providerPresetId: providerPreset.id,
      provider: providerPreset.provider,
      baseUrl: providerPreset.baseUrl,
      apiKey: providerPreset.apiKey,
    }
  );
}

function createRoleSettings(role, model, enabled, updatedAt, options = {}) {
  return {
    role,
    providerPresetId: options.providerPresetId ?? 'default-provider',
    provider: options.provider ?? 'llm-router',
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:18000/v1',
    apiKey: options.apiKey ?? '',
    model,
    enabled,
    updatedAt,
  };
}

function normalizeProviderPresets(value, rawPresets) {
  const explicit = Array.isArray(value) ? value.map(normalizeProviderPreset).filter(Boolean) : [];
  if (explicit.length > 0) return explicit;

  const providers = [];
  for (const preset of rawPresets) {
    for (const role of ['planner', 'executor', 'vision']) {
      const settings = preset?.roles?.[role];
      if (!settings) continue;
      const provider = String(settings.provider ?? 'llm-router');
      const baseUrl = String(settings.baseUrl ?? 'http://127.0.0.1:18000/v1');
      const apiKey = String(settings.apiKey ?? '');
      if (!providers.some((entry) => entry.provider === provider && entry.baseUrl === baseUrl && entry.apiKey === apiKey)) {
        const now = String(settings.updatedAt ?? new Date().toISOString());
        providers.push({
          id: providers.length === 0 ? 'default-provider' : `provider-${providers.length + 1}`,
          name: provider || `Provider ${providers.length + 1}`,
          provider,
          baseUrl,
          apiKey,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
  return providers.length > 0 ? providers : [createDefaultProviderPreset()];
}

function normalizeProviderPreset(preset) {
  if (!preset || typeof preset !== 'object') return null;
  const now = new Date().toISOString();
  return {
    id: String(preset.id ?? `provider-${Date.now()}`),
    name: String(preset.name ?? 'Provider preset'),
    provider: String(preset.provider ?? 'llm-router'),
    baseUrl: String(preset.baseUrl ?? 'http://127.0.0.1:18000/v1'),
    apiKey: String(preset.apiKey ?? ''),
    createdAt: String(preset.createdAt ?? now),
    updatedAt: String(preset.updatedAt ?? now),
  };
}

function resolveRoleProviderPreset(input, providerPresets) {
  const providerPresetId = String(input?.providerPresetId ?? '');
  const direct = providerPresets.find((preset) => preset.id === providerPresetId);
  if (direct) return direct;
  const provider = String(input?.provider ?? 'llm-router');
  const baseUrl = String(input?.baseUrl ?? 'http://127.0.0.1:18000/v1');
  const apiKey = String(input?.apiKey ?? '');
  return (
    providerPresets.find((preset) => preset.provider === provider && preset.baseUrl === baseUrl && preset.apiKey === apiKey) ??
    providerPresets[0] ??
    createDefaultProviderPreset()
  );
}
