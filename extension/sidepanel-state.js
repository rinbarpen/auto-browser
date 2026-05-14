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

export function formatPageContext(tab) {
  if (!tab) {
    return 'No active browser tab';
  }

  const title = tab.title || 'Untitled';
  const url = tab.url || '';
  return `${title} • ${url}`;
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
