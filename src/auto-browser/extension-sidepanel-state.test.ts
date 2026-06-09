import { describe, expect, it } from 'vitest';
import {
  buildChatMessages,
  filterTaskEvents,
  getActiveLlmPreset,
  getConversationTitle,
  getModelHandoffSignal,
  getPlanSignal,
  normalizeLlmPreferences,
  resolveInitialConversationId,
  selectCurrentConversation,
  selectCurrentTask,
  selectNextConversationIdAfterDelete,
} from '../../extension/sidepanel-state.js';

describe('extension sidepanel state helpers', () => {
  it('resolves the initial conversation using session, then stored selection, then latest update', () => {
    const conversations = [
      {
        id: 'conv_old',
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z',
        messages: [],
      },
      {
        id: 'conv_session',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-22T00:00:00.000Z',
        messages: [],
      },
    ];

    expect(resolveInitialConversationId(conversations, 'conv_session', 'conv_old')).toBe('conv_session');
    expect(resolveInitialConversationId(conversations, null, 'conv_old')).toBe('conv_old');
    expect(resolveInitialConversationId(conversations, null, null)).toBe('conv_session');
  });

  it('selects the stored conversation and latest task in that conversation', () => {
    const conversation = selectCurrentConversation(
      [
        {
          id: 'conv_old',
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z',
          messages: [],
        },
        {
          id: 'conv_selected',
          createdAt: '2026-04-10T00:00:00.000Z',
          updatedAt: '2026-04-22T00:00:00.000Z',
          messages: [],
        },
      ],
      'conv_selected'
    );

    const task = selectCurrentTask(
      [
        {
          id: 'task_old',
          conversationId: 'conv_selected',
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z',
        },
        {
          id: 'task_new',
          conversationId: 'conv_selected',
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-21T00:00:00.000Z',
        },
      ],
      conversation?.id ?? null
    );

    expect(conversation?.id).toBe('conv_selected');
    expect(task?.id).toBe('task_new');
  });

  it('uses explicit titles and falls back to the first user message', () => {
    expect(
      getConversationTitle({
        title: 'Renamed',
        messages: [{ role: 'user', content: 'Ignored' }],
      })
    ).toBe('Renamed');

    expect(
      getConversationTitle({
        title: null,
        messages: [{ role: 'user', content: 'Check the latest pricing page and summarize it for me' }],
      })
    ).toContain('Check the latest pricing page');
  });

  it('selects the next most recent conversation after delete', () => {
    expect(
      selectNextConversationIdAfterDelete(
        [
          {
            id: 'conv_1',
            createdAt: '2026-04-20T00:00:00.000Z',
            updatedAt: '2026-04-21T00:00:00.000Z',
          },
          {
            id: 'conv_2',
            createdAt: '2026-04-19T00:00:00.000Z',
            updatedAt: '2026-04-23T00:00:00.000Z',
          },
        ],
        'conv_2'
      )
    ).toBe('conv_1');
  });

  it('synthesizes draft and completion notices without duplicating assistant messages', () => {
    const baseConversation = {
      id: 'conv_1',
      createdAt: '2026-04-20T00:00:00.000Z',
      messages: [{ id: 'msg_1', role: 'user', content: 'Do it', createdAt: '2026-04-20T00:00:00.000Z' }],
    };

    const draftMessages = buildChatMessages(
      baseConversation,
      {
        id: 'task_1',
        status: 'running',
        planDraft: { summary: 'Open the current page and inspect it', steps: [] },
        resultSummary: null,
      },
      'Only one active task can run at a time'
    );
    expect(draftMessages.map((message) => message.content)).toEqual([
      'Do it',
      'Draft ready: Open the current page and inspect it',
      'Only one active task can run at a time',
    ]);

    const completedMessages = buildChatMessages(
      {
        ...baseConversation,
        messages: [
          ...baseConversation.messages,
          {
            id: 'msg_2',
            role: 'assistant',
            content: 'Done from the extension tab',
            createdAt: '2026-04-20T00:01:00.000Z',
          },
        ],
      },
      {
        id: 'task_2',
        status: 'completed',
        planDraft: { summary: 'Open the current page and inspect it', steps: [] },
        resultSummary: 'Done from the extension tab',
      },
      null
    );
    expect(completedMessages.map((message) => message.content)).toEqual(['Do it', 'Done from the extension tab']);
  });

  it('filters timeline events to the current task', () => {
    const events = filterTaskEvents(
      [
        { id: 'evt_1', taskId: 'task_1', type: 'task.ready' },
        { id: 'evt_2', taskId: 'task_2', type: 'task.running' },
        { id: 'evt_3', taskId: 'task_1', type: 'task.execution.completed' },
      ],
      'task_1'
    );

    expect(events.map((event) => event.id)).toEqual(['evt_3', 'evt_1']);
  });

  it('returns a plan signal only when the planner produced a draft or replan for the task', () => {
    const task = {
      id: 'task_plan',
      goal: 'Check my inbox',
      status: 'draft',
      planDraft: {
        summary: 'Open mail and inspect the inbox',
        steps: [{ id: 'step_1', title: 'Open mail', intent: 'Navigate to the inbox' }],
      },
    };

    expect(
      getPlanSignal(task, [
        {
          id: 'evt_1',
          taskId: 'task_plan',
          type: 'task.drafted',
          createdAt: '2026-05-15T01:00:00.000Z',
        },
      ])
    ).toMatchObject({
      taskId: 'task_plan',
      badge: 'Draft',
      actionable: true,
      summary: 'Open mail and inspect the inbox',
    });

    expect(
      getPlanSignal(
        { ...task, status: 'running' },
        [
          {
            id: 'evt_2',
            taskId: 'task_plan',
            type: 'task.replanned',
            createdAt: '2026-05-15T01:02:00.000Z',
          },
        ]
      )
    ).toMatchObject({ badge: 'Replanned', actionable: false });

    expect(
      getPlanSignal(task, [
        {
          id: 'evt_other',
          taskId: 'task_other',
          type: 'task.drafted',
          createdAt: '2026-05-15T01:00:00.000Z',
        },
      ])
    ).toBeNull();
  });

  it('returns a handoff signal for explicit executor model handoff actions', () => {
    const task = {
      id: 'task_handoff',
      status: 'handoff',
      resultSummary: 'Two-factor code is required',
    };

    expect(
      getModelHandoffSignal(task, [
        {
          id: 'evt_1',
          taskId: 'task_handoff',
          type: 'task.execution.iteration.completed',
          createdAt: '2026-05-15T01:00:00.000Z',
          summary: {
            action: 'handoff',
            label: 'Request handoff',
            reason: 'Two-factor code is required on the verification page',
          },
          data: {},
        },
      ])
    ).toMatchObject({
      taskId: 'task_handoff',
      title: '需要验证码操作',
      reason: 'Two-factor code is required on the verification page',
    });

    expect(
      getModelHandoffSignal(task, [
        {
          id: 'evt_2',
          taskId: 'task_handoff',
          type: 'task.execution.llm.completion',
          createdAt: '2026-05-15T01:01:00.000Z',
          data: { content: '{"action":"handoff","reason":"Login requires human approval"}' },
        },
      ])
    ).toMatchObject({ title: '需要人工操作', reason: 'Login requires human approval' });
  });

  it('does not treat permission blocks, generic failures, or iteration budget handoffs as model handoff prompts', () => {
    const task = {
      id: 'task_blocked',
      status: 'blocked',
      resultSummary: 'Permission required for https://example.test',
    };

    expect(
      getModelHandoffSignal(task, [
        {
          id: 'evt_permission',
          taskId: 'task_blocked',
          type: 'task.execution.blocked',
          createdAt: '2026-05-15T01:00:00.000Z',
          data: { message: 'Permission required for https://example.test' },
        },
      ])
    ).toBeNull();

    expect(
      getModelHandoffSignal(
        { ...task, status: 'handoff', resultSummary: 'Task paused after exceeding 2 iterations' },
        [
          {
            id: 'evt_budget',
            taskId: 'task_blocked',
            type: 'task.execution.completed',
            createdAt: '2026-05-15T01:01:00.000Z',
            summary: { action: 'handoff', label: 'Request handoff' },
            data: { message: 'Task paused after exceeding 2 iterations' },
          },
        ]
      )
    ).toBeNull();

    expect(
      getModelHandoffSignal(
        { ...task, status: 'failed', resultSummary: 'Login requires human approval' },
        [
          {
            id: 'evt_failed',
            taskId: 'task_blocked',
            type: 'task.execution.llm.completion',
            createdAt: '2026-05-15T01:02:00.000Z',
            data: { content: '{"action":"handoff","reason":"Login requires human approval"}' },
          },
        ]
      )
    ).toBeNull();

    expect(
      getModelHandoffSignal(
        { ...task, status: 'running', resultSummary: null },
        [
          {
            id: 'evt_old_handoff',
            taskId: 'task_blocked',
            type: 'task.execution.llm.completion',
            createdAt: '2026-05-15T01:02:00.000Z',
            data: { content: '{"action":"handoff","reason":"Login requires human approval"}' },
          },
          {
            id: 'evt_new_run',
            taskId: 'task_blocked',
            type: 'task.running',
            createdAt: '2026-05-15T01:03:00.000Z',
            data: { currentStepIndex: 0 },
          },
        ]
      )
    ).toBeNull();
  });

  it('migrates legacy model preferences to a default llm preset', () => {
    const preferences = normalizeLlmPreferences({
      plannerModel: 'legacy-planner',
      executorModel: 'legacy-executor',
      selectedConversationId: 'conv_1',
    });

    expect(preferences.activeLlmPresetId).toBe('default');
    expect(preferences.llmPresets[0]).toMatchObject({
      name: 'Default',
      roles: {
        planner: { model: 'legacy-planner', providerPresetId: 'default-provider' },
        executor: { model: 'legacy-executor', providerPresetId: 'default-provider' },
      },
    });
    expect(preferences.providerPresets[0]).toMatchObject({
      id: 'default-provider',
      provider: 'llm-router',
    });
    expect('plannerModel' in preferences).toBe(false);
    expect('executorModel' in preferences).toBe(false);
    expect(getActiveLlmPreset(preferences).roles.planner.model).toBe('legacy-planner');
  });

  it('keeps multiple extension roles on the same provider preset id', () => {
    const preferences = normalizeLlmPreferences({
      providerPresets: [
        {
          id: 'shared',
          name: 'Shared',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-shared',
        },
      ],
      llmPresets: [
        {
          id: 'default',
          roles: {
            planner: { providerPresetId: 'shared', model: 'planner-model' },
            executor: { providerPresetId: 'shared', model: 'executor-model' },
          },
        },
      ],
    });

    const activePreset = getActiveLlmPreset(preferences);
    expect(activePreset.roles.planner.providerPresetId).toBe('shared');
    expect(activePreset.roles.executor.providerPresetId).toBe('shared');
    expect(activePreset.roles.planner.provider).toBe('openai');
  });
});
