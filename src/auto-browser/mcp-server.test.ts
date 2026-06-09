import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlService, registerAllTools } from './mcp-server.js';
import { InMemoryControlService } from './control-service.js';
import { loadStorageState, normalizeCookies } from './cookie-manager.js';

const root = resolve(import.meta.dirname, '../..');

describe('auto-browser MCP server', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('publishes an auto-browser-mcp bin from the root package', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.['auto-browser-mcp']).toBe('./dist/auto-browser/mcp-server.js');
  });

  it('createControlService returns a valid service in test mode', () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    expect(service).toBeInstanceOf(InMemoryControlService);
  });

  it('submit_goal drafts a plan with DemoPlanner', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    const conversation = service.createConversation();
    const task = await service.submitUserMessage(conversation.id, 'search for cats', {
      browserConfig: {
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
        cookiesPath: '',
        credentialsPath: '',
        launchMode: 'auto',
        extensionEnabled: false,
        previewEnabled: false,
        cdpUrl: '',
        cloakHumanize: false,
        cloakFingerprintSeed: '',
        cloakTimezone: '',
        cloakLocale: '',
      },
      plannerModel: 'test-model',
      modelTier: 'standard',
      context: '',
    });

    expect(task.id).toBeTruthy();
    expect(task.conversationId).toBe(conversation.id);
    expect(task.goal).toBe('search for cats');
    expect(task.status).toBe('draft');
    expect(task.planDraft.steps.length).toBeGreaterThanOrEqual(0);
  });

  it('approve_and_run completes a task with DemoExecutionDriver', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    const conversation = service.createConversation();
    const task = await service.submitUserMessage(conversation.id, 'search for cats', {
      browserConfig: {
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
        cookiesPath: '',
        credentialsPath: '',
        launchMode: 'auto',
        extensionEnabled: false,
        previewEnabled: false,
        cdpUrl: '',
        cloakHumanize: false,
        cloakFingerprintSeed: '',
        cloakTimezone: '',
        cloakLocale: '',
      },
      plannerModel: 'test-model',
      modelTier: 'standard',
      context: '',
    });

    const completed = await service.approveTask(task.id, {
      executorModel: 'test-model',
      modelTier: 'standard',
    });

    expect(completed.status).toBe('completed');
    expect(completed.resultSummary).toBeTruthy();
  });

  it('get_task returns task details', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    const conversation = service.createConversation();
    const task = await service.submitUserMessage(conversation.id, 'test task', {
      browserConfig: {
        mode: 'managed',
        browserFamily: 'chromium',
        executablePath: '',
        profilePath: '',
        cookiesPath: '',
        credentialsPath: '',
        launchMode: 'auto',
        extensionEnabled: false,
        previewEnabled: false,
        cdpUrl: '',
        cloakHumanize: false,
        cloakFingerprintSeed: '',
        cloakTimezone: '',
        cloakLocale: '',
      },
      plannerModel: 'test-model',
      modelTier: '',
      context: '',
    });

    const fetched = service.getTask(task.id);
    expect(fetched.id).toBe(task.id);
    expect(fetched.goal).toBe('test task');
  });

  it('list_tasks returns all tasks', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    const conversation = service.createConversation();
    await service.submitUserMessage(conversation.id, 'first task', {
      browserConfig: {
        mode: 'managed', browserFamily: 'chromium', executablePath: '', profilePath: '',
        cookiesPath: '', credentialsPath: '', launchMode: 'auto',
        extensionEnabled: false, previewEnabled: false, cdpUrl: '', cloakHumanize: false, cloakFingerprintSeed: '', cloakTimezone: '', cloakLocale: '',
      },
      plannerModel: 'test-model', modelTier: '', context: '',
    });
    await service.submitUserMessage(conversation.id, 'second task', {
      browserConfig: {
        mode: 'managed', browserFamily: 'chromium', executablePath: '', profilePath: '',
        cookiesPath: '', credentialsPath: '', launchMode: 'auto',
        extensionEnabled: false, previewEnabled: false, cdpUrl: '', cloakHumanize: false, cloakFingerprintSeed: '', cloakTimezone: '', cloakLocale: '',
      },
      plannerModel: 'test-model', modelTier: '', context: '',
    });

    const tasks = service.getTasks();
    expect(tasks.length).toBe(2);
  });

  it('cancel_task transitions status to cancelled', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    const conversation = service.createConversation();
    const task = await service.submitUserMessage(conversation.id, 'cancellable task', {
      browserConfig: {
        mode: 'managed', browserFamily: 'chromium', executablePath: '', profilePath: '',
        cookiesPath: '', credentialsPath: '', launchMode: 'auto',
        extensionEnabled: false, previewEnabled: false, cdpUrl: '', cloakHumanize: false, cloakFingerprintSeed: '', cloakTimezone: '', cloakLocale: '',
      },
      plannerModel: 'test-model', modelTier: '', context: '',
    });

    const cancelled = await service.cancelTask(task.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('throws on unknown task ID', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();

    try {
      service.getTask('nonexistent-task');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('not found');
    }
  });

  it('resume_task replans a handed-off task', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    const conversation = service.createConversation();
    const task = await service.submitUserMessage(conversation.id, 'handoff test', {
      browserConfig: {
        mode: 'managed', browserFamily: 'chromium', executablePath: '', profilePath: '',
        cookiesPath: '', credentialsPath: '', launchMode: 'auto',
        extensionEnabled: false, previewEnabled: false, cdpUrl: '', cloakHumanize: false, cloakFingerprintSeed: '', cloakTimezone: '', cloakLocale: '',
      },
      plannerModel: 'test-model', modelTier: '', context: '',
    });

    const handedOff = service.enterHandoff(task.id, 'test');
    expect(handedOff.status).toBe('handoff');

    const resumed = await service.resumeTask(task.id, { plannerModel: 'test-model', modelTier: '' });
    expect(resumed.status).toBe('draft');
  });

  it('create_goal and get_goal work correctly', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    const goal = service.createGoal('Test goal', 'A description', 'Some context');
    expect(goal.id).toMatch(/^goal_/);
    expect(goal.title).toBe('Test goal');
    expect(goal.status).toBe('active');

    const fetched = service.getGoal(goal.id);
    expect(fetched.description).toBe('A description');
  });

  it('list_goals returns all goals', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    service.createGoal('Goal 1');
    service.createGoal('Goal 2');
    const goals = service.getGoals();
    expect(goals.length).toBe(2);
  });

  it('draft_plan_for_goal creates a plan with DemoPlanner', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    const goal = service.createGoal('Draft plan test');
    const plan = await service.draftPlanForGoal(goal.id, {
      browserConfig: {
        mode: 'managed', browserFamily: 'chromium', executablePath: '', profilePath: '',
        cookiesPath: '', credentialsPath: '', launchMode: 'auto',
        extensionEnabled: false, previewEnabled: false, cdpUrl: '',
      },
      plannerModel: 'test-model',
      modelTier: '',
    });
    expect(plan.id).toMatch(/^plan_/);
    expect(plan.goalId).toBe(goal.id);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.status).toBe('draft');
  });

  it('edit_plan creates a new version', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    const goal = service.createGoal('Edit plan test');
    const plan = service.createPlan(goal.id, 'Original', [
      { id: 's1', title: 'Step 1', intent: 'Do it' },
    ], 1);

    const edited = service.updatePlanSteps(plan.id, [
      { stepId: 's1', title: 'Updated step' },
    ]);
    expect(edited.version).toBe(2);
    expect(edited.steps[0].title).toBe('Updated step');

    const plans = service.getPlansForGoal(goal.id);
    expect(plans.length).toBe(2);
  });

  it('get_state returns conversations, tasks, activeTask, events', async () => {
    vi.stubGlobal('process', { ...process, env: { ...process.env, NODE_ENV: 'test' } });
    const service = createControlService();
    service.createConversation();
    const conv2 = service.createConversation();

    const task = await service.submitUserMessage(conv2.id, 'state test goal', {
      browserConfig: {
        mode: 'managed', browserFamily: 'chromium', executablePath: '', profilePath: '',
        cookiesPath: '', credentialsPath: '', launchMode: 'auto',
        extensionEnabled: false, previewEnabled: false, cdpUrl: '', cloakHumanize: false, cloakFingerprintSeed: '', cloakTimezone: '', cloakLocale: '',
      },
      plannerModel: 'test-model', modelTier: '', context: '',
    });

    const conversations = service.getConversations();
    const tasks = service.getTasks();
    const activeTask = service.getActiveTask();
    const events = service.getEventsSince(0);

    expect(conversations.length).toBe(2);
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(task.id);
    expect(events.length).toBeGreaterThan(0);
    // activeTask should be null since no task is running
    expect(activeTask).toBeNull();
  });
});

describe('cookie tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('get_cookies reads a cookie file grouped by domain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cookies-test-'));
    const filePath = join(dir, 'cookies.json');
    writeFileSync(filePath, JSON.stringify({
      cookies: [
        { name: 'session', value: 'abc123', domain: '.example.com', path: '/', httpOnly: true, secure: true },
        { name: 'token', value: 'xyz', domain: '.example.com', path: '/', secure: true },
        { name: 'pref', value: 'dark', domain: '.other.com', path: '/', httpOnly: false },
      ],
      origins: [],
    }, null, 2), 'utf-8');

    const state = loadStorageState(filePath);
    expect(state.cookies).toHaveLength(3);

    // Get cookies for specific domain
    const exampleCookies = state.cookies.filter((c) => c.domain === '.example.com');
    expect(exampleCookies).toHaveLength(2);
    expect(exampleCookies[0].name).toBe('session');
    expect(exampleCookies[0].value).toBe('abc123');

    const otherCookies = state.cookies.filter((c) => c.domain === '.other.com');
    expect(otherCookies).toHaveLength(1);
    expect(otherCookies[0].name).toBe('pref');
  });

  it('get_cookies handles empty cookie file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cookies-test-'));
    const filePath = join(dir, 'empty.json');
    writeFileSync(filePath, JSON.stringify({ cookies: [], origins: [] }), 'utf-8');

    const state = loadStorageState(filePath);
    expect(state.cookies).toHaveLength(0);
  });

  it('get_cookies handles missing file gracefully', () => {
    const state = loadStorageState('/nonexistent/cookies.json');
    expect(state.cookies).toHaveLength(0);
  });

  it('import_cookies normalizes and saves cookies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cookies-test-'));
    const outputPath = join(dir, 'imported.json');

    const raw = [
      { name: 'auth', value: 'secret', domain: '.mysite.com', path: '/', httpOnly: true },
      { name: 'lang', value: 'en', domain: '.mysite.com', path: '/' },
    ];
    const normalized = normalizeCookies(raw);
    writeFileSync(outputPath, JSON.stringify({ cookies: normalized, origins: [] }, null, 2), 'utf-8');

    const state = loadStorageState(outputPath);
    expect(state.cookies).toHaveLength(2);
    expect(state.cookies[0].name).toBe('auth');
    expect(state.cookies[0].value).toBe('secret');
  });

  it('import_cookies validates non-array input', () => {
    expect(() => normalizeCookies([{} as any])).not.toThrow();
  });

  it('clear_cookies removes cookies by domain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cookies-test-'));
    const filePath = join(dir, 'clear-test.json');
    writeFileSync(filePath, JSON.stringify({
      cookies: [
        { name: 'a', value: '1', domain: '.example.com', path: '/' },
        { name: 'b', value: '2', domain: '.example.com', path: '/' },
        { name: 'c', value: '3', domain: '.other.com', path: '/' },
      ],
      origins: [],
    }, null, 2), 'utf-8');

    // Read, filter out .example.com, write back
    const state = loadStorageState(filePath);
    const before = state.cookies.length;
    state.cookies = state.cookies.filter((c) => !c.domain.includes('example'));
    expect(before).toBe(3);
    expect(state.cookies).toHaveLength(1);
    expect(state.cookies[0].domain).toBe('.other.com');
  });
});
