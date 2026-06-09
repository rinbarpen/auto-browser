import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryControlService,
  buildExecutorMessages,
  parseExecutorAction,
  type BrowserRuntimeConfig,
  type ExecutorAction,
  type ExecutionDriver,
  type ExecutorDecider,
  type Planner,
  sanitizeTextPreview,
  summarizeExecutorAction,
} from './control-service.js';
import { extractErrorContext } from './error-context.js';

class StubPlanner implements Planner {
  readonly draftModels: string[] = [];
  readonly replanModels: string[] = [];

  async draft(goal: string, _browserConfig: BrowserRuntimeConfig, model: string) {
    this.draftModels.push(model);
    return {
      summary: `Plan for ${goal}`,
      steps: [
        { id: 'step-1', title: 'Open target page', intent: 'Navigate to the requested site' },
        { id: 'step-2', title: 'Extract result', intent: 'Collect the answer for the user' },
      ],
    };
  }

  async replanRemaining(taskId: string, _task: unknown, model: string) {
    this.replanModels.push(model);
    return {
      summary: `Replanned ${taskId}`,
      steps: [{ id: 'step-3', title: 'Resume after handoff', intent: 'Continue from current page' }],
    };
  }
}

class StubExecutionDriver implements ExecutionDriver {
  readonly runs: string[] = [];
  readonly executorModels: Array<string | null> = [];

  async execute(taskId: string, task: { executorModel: string | null }) {
    this.runs.push(taskId);
    this.executorModels.push(task.executorModel);
    return {
      finalStatus: 'completed' as const,
      finalMessage: `Task ${taskId} completed`,
      steps: [
        { stepId: 'step-1', status: 'completed' as const },
        { stepId: 'step-2', status: 'completed' as const },
      ],
    };
  }
}

class StubExecutorDecider implements ExecutorDecider {
  readonly calls: Array<{ taskId: string; observationUrl: string }> = [];

  async decide(input: {
    task: { id: string };
    observation: { url: string };
  }): Promise<ExecutorAction> {
    this.calls.push({ taskId: input.task.id, observationUrl: input.observation.url });
    return {
      action: 'fill_ref',
      ref: '@e1',
      text: 'secret-value',
      label: 'Fill login form',
      textPreview: 'se******',
    };
  }
}

const browserConfig: BrowserRuntimeConfig = {
  mode: 'system',
  browserFamily: 'chrome',
  executablePath: process.execPath,
  profilePath: mkdtempSync(join(tmpdir(), 'agent-browser-control-service-')),
  cookiesPath: '',
  credentialsPath: '',
  launchMode: 'auto',
  extensionEnabled: true,
  previewEnabled: true,
  cdpUrl: '',
  cloakHumanize: false,
  cloakFingerprintSeed: '',
  cloakTimezone: '',
  cloakLocale: '',
};

describe('InMemoryControlService', () => {
  it('creates a draft task from a user message and completes it after approval', async () => {
    const planner = new StubPlanner();
    const executionDriver = new StubExecutionDriver();
    const service = new InMemoryControlService({
      planner,
      executionDriver,
    });

    const conversation = service.createConversation();
    expect(conversation.title).toBeNull();
    expect(conversation.updatedAt).toBe(conversation.createdAt);
    const draft = await service.submitUserMessage(conversation.id, 'Log in and check my inbox', {
      browserConfig,
      plannerModel: 'planner-model',
    });

    expect(draft.status).toBe('draft');
    expect(draft.goal).toBe('Log in and check my inbox');
    expect(draft.plannerModel).toBe('planner-model');
    expect(planner.draftModels).toEqual(['planner-model']);
    expect(draft.planDraft.steps).toHaveLength(2);

    const completed = await service.approveTask(draft.id, { executorModel: 'executor-model' });

    expect(completed.status).toBe('completed');
    expect(completed.executorModel).toBe('executor-model');
    expect(completed.resultSummary).toContain('completed');
    expect(executionDriver.executorModels).toEqual(['executor-model']);
    expect(service.getConversation(conversation.id).messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: completed.resultSummary,
    });
    expect(service.getConversation(conversation.id).updatedAt >= conversation.createdAt).toBe(true);
    expect(service.getActiveTask()).toBeNull();
  });

  it('renames conversations and deletes non-active history with related tasks and events', async () => {
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: new StubExecutionDriver(),
    });

    const conversation = service.createConversation();
    const draft = await service.submitUserMessage(conversation.id, 'Summarize this page', {
      browserConfig,
      plannerModel: 'planner-model',
    });
    await service.approveTask(draft.id, { executorModel: 'executor-model' });

    const renamed = service.updateConversationTitle(conversation.id, 'Saved thread');
    expect(renamed.title).toBe('Saved thread');

    const eventCountBeforeDelete = service.getEventsSince(0).length;
    expect(eventCountBeforeDelete).toBeGreaterThan(0);

    service.deleteConversation(conversation.id);

    expect(service.getConversations()).toHaveLength(0);
    expect(service.getTasks()).toHaveLength(0);
    expect(service.getEventsSince(0)).toHaveLength(0);
  });

  it('rejects deleting a conversation with an active task', async () => {
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: {
        async execute() {
          return new Promise(() => undefined);
        },
      },
    });

    const conversation = service.createConversation();
    const draft = await service.submitUserMessage(conversation.id, 'First task', {
      browserConfig,
      plannerModel: 'planner-model',
    });

    const runningPromise = service.approveTask(draft.id, { executorModel: 'executor-model' });
    await Promise.resolve();

    expect(() => service.deleteConversation(conversation.id)).toThrow(
      `Cannot delete conversation with active task: ${conversation.id}`
    );

    void runningPromise;
  });

  it('blocks a second task while another task is active', async () => {
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: {
        async execute() {
          return new Promise(() => undefined);
        },
      },
    });

    const firstConversation = service.createConversation();
    const secondConversation = service.createConversation();
    const firstDraft = await service.submitUserMessage(firstConversation.id, 'First task', {
      browserConfig,
      plannerModel: 'planner-model',
    });

    const runningPromise = service.approveTask(firstDraft.id, { executorModel: 'executor-model' });
    await Promise.resolve();

    await expect(
      service.submitUserMessage(secondConversation.id, 'Second task', {
        browserConfig,
        plannerModel: 'planner-model',
      })
    ).rejects.toThrow('Only one active task');

    void runningPromise;
  });

  it('moves into handoff and replans remaining work when control is returned', async () => {
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: new StubExecutionDriver(),
    });

    const conversation = service.createConversation();
    const task = await service.submitUserMessage(conversation.id, 'Complete checkout', {
      browserConfig,
      plannerModel: 'first-planner-model',
    });

    service.enterHandoff(task.id, 'preview_window');
    const handedOff = service.getTask(task.id);
    expect(handedOff.status).toBe('handoff');

    const resumed = await service.resumeTask(task.id, { plannerModel: 'resume-planner-model' });
    expect(resumed.status).toBe('draft');
    expect(resumed.plannerModel).toBe('resume-planner-model');
    expect(resumed.planDraft.steps).toHaveLength(1);
    expect(resumed.planDraft.steps[0]?.title).toContain('Resume');
  });

  it('keeps the task in handoff when execution requests human help', async () => {
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: {
        async execute() {
          return {
            finalStatus: 'handoff' as const,
            finalMessage: 'Need a human to solve MFA',
            steps: [],
          };
        },
      },
    });

    const conversation = service.createConversation();
    const draft = await service.submitUserMessage(conversation.id, 'Log in to the bank', {
      browserConfig,
      plannerModel: 'planner-model',
    });

    const handedOff = await service.approveTask(draft.id, { executorModel: 'executor-model' });

    expect(handedOff.status).toBe('handoff');
    expect(handedOff.resultSummary).toBe('Need a human to solve MFA');
    expect(handedOff.handoffSource).toBe('execution_driver');
  });

  it('requires request-level planner and executor models', async () => {
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: new StubExecutionDriver(),
    });
    const conversation = service.createConversation();

    await expect(
      service.submitUserMessage(conversation.id, 'Open example.com', {
        browserConfig,
        plannerModel: '',
      })
    ).rejects.toThrow('Planner model is required for this request.');

    const draft = await service.submitUserMessage(conversation.id, 'Open example.com', {
      browserConfig,
      plannerModel: 'planner-model',
    });

    await expect(service.approveTask(draft.id, { executorModel: '' })).rejects.toThrow(
      'Executor model is required for this request.'
    );
  });

  it('allows managed mode without an executable path', async () => {
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: new StubExecutionDriver(),
    });
    const conversation = service.createConversation();

    const draft = await service.submitUserMessage(conversation.id, 'Open example.com', {
      browserConfig: {
        ...browserConfig,
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
      },
      plannerModel: 'planner-model',
    });

    expect(draft.browserConfig.mode).toBe('managed');
    expect(draft.browserConfig.executablePath).toBe('');
  });

  it('keeps validating executable paths in system mode', async () => {
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: new StubExecutionDriver(),
    });
    const conversation = service.createConversation();

    await expect(
      service.submitUserMessage(conversation.id, 'Open example.com', {
        browserConfig: {
          ...browserConfig,
          executablePath: '/definitely/missing/browser',
        },
        plannerModel: 'planner-model',
      })
    ).rejects.toThrow('Browser executable not found');
  });

  it('attaches control-service context to user-visible errors', async () => {
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: new StubExecutionDriver(),
    });

    try {
      await service.approveTask('missing-task', { executorModel: 'executor-model' });
      throw new Error('Expected approveTask to fail');
    } catch (error) {
      expect(extractErrorContext(error)).toEqual({
        module: 'auto-browser.control-service',
        file: 'src/auto-browser/control-service.ts',
        location: 'getTask',
        problem: 'Task not found: missing-task',
      });
    }
  });

  it('supports extension approval, model decisions, and progress reports', async () => {
    const decider = new StubExecutorDecider();
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: new StubExecutionDriver(),
      executorDecider: decider,
    });
    const conversation = service.createConversation();
    const draft = await service.submitUserMessage(conversation.id, 'Log in and check my inbox', {
      browserConfig,
      plannerModel: 'planner-model',
    });

    const running = await service.approveExtensionTask(draft.id, { executorModel: 'executor-model' });
    expect(running.status).toBe('running');
    expect(running.executionSource).toBe('extension');

    const action = await service.decideAction(draft.id, {
      url: 'https://mail.example.test/login',
      title: 'Login',
      visibleText: 'Please sign in',
      refs: [],
    }, []);
    expect(action).toMatchObject({
      action: 'fill_ref',
      ref: '@e1',
      textPreview: 'se******',
    });

    service.reportTaskProgress(draft.id, {
      phase: 'action_started',
      action,
      observationSummary: 'Login • https://mail.example.test/login',
    });
    const completed = service.reportTaskProgress(draft.id, {
      phase: 'completed',
      action: { action: 'finish', message: 'Inbox loaded', label: 'Finish inbox task' },
      outcome: 'success',
      message: 'Inbox loaded',
    });

    expect(completed.status).toBe('completed');
    expect(service.getConversation(conversation.id).messages.at(-1)?.content).toBe('Inbox loaded');
    expect(decider.calls).toEqual([{ taskId: draft.id, observationUrl: 'https://mail.example.test/login' }]);
    expect(service.getEventsSince(0).slice(-2).map((event) => event.type)).toEqual([
      'task.execution.action_started',
      'task.execution.completed',
    ]);
  });

  it('summarizes fill actions with redacted previews', () => {
    expect(sanitizeTextPreview('secret-value')).toBe('se*********');
    expect(
      summarizeExecutorAction({ action: 'fill_ref', ref: '@e2', text: 'secret-value', label: 'Fill secret' })
    ).toEqual({
      action: 'fill_ref',
      label: 'Fill secret',
      ref: '@e2',
      url: undefined,
      key: undefined,
      direction: undefined,
      amount: undefined,
      textPreview: 'se*********',
      reason: undefined,
    });
  });

  it('parses click_point actions and rejects invalid coordinates', () => {
    expect(parseExecutorAction('{"action":"click_point","x":32,"y":64,"label":"Click target"}')).toEqual({
      action: 'click_point',
      x: 32,
      y: 64,
      label: 'Click target',
    });

    expect(() => parseExecutorAction('{"action":"click_point","x":"32","y":64}')).toThrow(
      'Executor returned an invalid action payload'
    );
  });

  it('adds visual coordinate instructions to executor messages when screenshots are present', () => {
    const messages = buildExecutorMessages(
      {
        id: 'task',
        conversationId: 'conv',
        goal: 'Click the canvas target',
        context: null,
        status: 'running',
        planDraft: { summary: 'Use canvas', steps: [] },
        browserConfig,
        plannerModel: 'planner',
        executorModel: 'executor',
        modelTier: null,
        currentStepIndex: 0,
        resultSummary: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        handoffSource: null,
        executionSource: 'service',
      },
      {
        url: 'https://example.test',
        title: 'Canvas',
        visibleText: '',
        refs: [],
        canvasRects: [{ x: 0, y: 0, width: 200, height: 200 }],
        visual: {
          base64: Buffer.from('image').toString('base64'),
          mimeType: 'image/jpeg',
          viewport: { width: 800, height: 600 },
          reason: 'visible canvas with too few semantic refs',
        },
      },
      []
    );

    expect(messages[0]?.content).toContain('click_point');
    expect(messages[1]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image_url',
        }),
      ])
    );
    expect(JSON.stringify(messages[1]?.content)).toContain('viewport CSS pixels');
  });

  describe('Goal and Plan CRUD', () => {
    const service = new InMemoryControlService({
      planner: new StubPlanner(),
      executionDriver: new StubExecutionDriver(),
    });

    it('creates and retrieves a goal', () => {
      const goal = service.createGoal('Search docs', 'Find API references', 'need REST API docs');
      expect(goal.id).toMatch(/^goal_/);
      expect(goal.title).toBe('Search docs');
      expect(goal.description).toBe('Find API references');
      expect(goal.context).toBe('need REST API docs');
      expect(goal.status).toBe('active');

      const fetched = service.getGoal(goal.id);
      expect(fetched.title).toBe('Search docs');
    });

    it('lists goals with optional status filter', () => {
      const g1 = service.createGoal('Goal one');
      const g2 = service.createGoal('Goal two');
      const all = service.getGoals();
      expect(all.length).toBeGreaterThanOrEqual(3);

      const active = service.getGoals('active');
      expect(active.every((g) => g.status === 'active')).toBe(true);
    });

    it('archives a goal', () => {
      const goal = service.createGoal('Temporary');
      const archived = service.archiveGoal(goal.id);
      expect(archived.status).toBe('archived');

      const fetched = service.getGoal(goal.id);
      expect(fetched.status).toBe('archived');
    });

    it('creates a plan with goal reference and versioning', () => {
      const goal = service.createGoal('Test versioning');
      const plan1 = service.createPlan(goal.id, 'First attempt', [
        { id: 's1', title: 'Step 1', intent: 'Do first' },
        { id: 's2', title: 'Step 2', intent: 'Do second' },
      ], 1);
      expect(plan1.version).toBe(1);
      expect(plan1.status).toBe('draft');
      expect(plan1.goalId).toBe(goal.id);

      const plans = service.getPlansForGoal(goal.id);
      expect(plans.length).toBe(1);
    });

    it('creates new version on plan edit', () => {
      const goal = service.createGoal('Edit test');
      const plan = service.createPlan(goal.id, 'Original', [
        { id: 's1', title: 'Old title', intent: 'Old intent' },
      ], 1);

      const edited = service.updatePlanSteps(plan.id, [
        { stepId: 's1', title: 'New title' },
      ]);

      // Old plan is superseded
      expect(plan.status).toBe('superseded');

      // New plan has incremented version
      expect(edited.version).toBe(2);
      expect(edited.status).toBe('draft');
      expect(edited.steps[0].title).toBe('New title');

      const plans = service.getPlansForGoal(goal.id);
      expect(plans.length).toBe(2);
    });

    it('submitUserMessage creates Goal and Plan entities', async () => {
      const conv = service.createConversation();
      const task = await service.submitUserMessage(conv.id, 'test goal', {
        browserConfig,
        plannerModel: 'test-planner',
      });

      expect(task.goalId).toMatch(/^goal_/);
      expect(task.planId).toMatch(/^plan_/);

      const goal = service.getGoal(task.goalId);
      expect(goal.title).toBe('test goal');

      const plan = service.getPlan(task.planId);
      expect(plan.goalId).toBe(task.goalId);
    });

    it('backward compat helpers resolve goal and plan', async () => {
      const conv = service.createConversation();
      const task = await service.submitUserMessage(conv.id, 'backward test', {
        browserConfig,
        plannerModel: 'test-planner',
      });

      const goal = service.getGoalForTask(task.id);
      expect(goal.title).toBe('backward test');

      const plan = service.getPlanForTask(task.id);
      expect(plan.summary).toContain('backward test');
    });
  });
});
