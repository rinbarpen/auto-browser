import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkbenchStore } from '../src/workbench/store';
import type { FlowDefinition, FlowRunRecord } from '../src/workbench/types';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-store-'));
  tempDirs.push(dir);
  return path.join(dir, 'workbench.db');
}

describe('createWorkbenchStore', () => {
  it('persists flows and returns them newest-first', () => {
    const store = createWorkbenchStore({ dbPath: createTempDbPath() });

    const older = makeFlow('flow-older', 'Login flow', '2026-04-09T10:00:00.000Z');
    const newer = makeFlow('flow-newer', 'Checkout flow', '2026-04-09T11:00:00.000Z');

    store.saveFlow(older);
    store.saveFlow(newer);

    const flows = store.listFlows();
    expect(flows.map((flow) => flow.id)).toEqual(['flow-newer', 'flow-older']);
    expect(store.getFlow('flow-older')?.steps).toHaveLength(1);
  });

  it('persists runs, steps, and timeline events together', () => {
    const store = createWorkbenchStore({ dbPath: createTempDbPath() });
    store.saveFlow(makeFlow('flow-1', 'Demo flow'));

    const run: FlowRunRecord = {
      id: 'run-1',
      flowId: 'flow-1',
      sessionId: 'session-1',
      status: 'running',
      startedAt: '2026-04-09T12:00:00.000Z',
      finishedAt: null,
      currentStepId: 'step-1',
      errorSummary: null,
    };

    store.createRun(run);
    store.upsertRunStep({
      runId: 'run-1',
      stepId: 'step-1',
      status: 'success',
      startedAt: '2026-04-09T12:00:01.000Z',
      finishedAt: '2026-04-09T12:00:02.000Z',
      durationMs: 1000,
      pageUrl: 'https://example.com',
      screenshotPath: '/tmp/shot.png',
      inputSnapshot: { value: 'person@example.com' },
      message: 'Filled email',
      errorDetail: null,
    });
    store.appendRunEvent({
      id: 'event-1',
      runId: 'run-1',
      type: 'step_succeeded',
      createdAt: '2026-04-09T12:00:02.000Z',
      payload: { stepId: 'step-1' },
    });

    const summary = store.getRunWithDetails('run-1');
    expect(summary?.run.status).toBe('running');
    expect(summary?.steps).toHaveLength(1);
    expect(summary?.events[0]).toMatchObject({
      type: 'step_succeeded',
      payload: { stepId: 'step-1' },
    });
  });

  it('persists browser instances, cookie jars, cookies, and masked llm settings', () => {
    const store = createWorkbenchStore({ dbPath: createTempDbPath() });
    const now = '2026-04-09T12:00:00.000Z';

    store.saveBrowserInstance({
      id: 'instance-1',
      name: 'Research browser',
      status: 'stopped',
      startUrl: 'https://example.com',
      mode: 'system',
      browserFamily: 'chrome',
      executablePath: '/usr/bin/google-chrome',
      profilePath: './browser-profile/research',
      cookieJarId: 'jar-1',
      viewport: { width: 1280, height: 720 },
      headless: false,
      createdAt: now,
      updatedAt: now,
    });

    store.saveCookieJar({
      id: 'jar-1',
      name: 'Example account',
      site: 'https://example.com',
      account: 'person@example.com',
      createdAt: now,
      updatedAt: now,
    });
    store.replaceCookies('jar-1', [
      {
        id: 'cookie-1',
        jarId: 'jar-1',
        name: 'session',
        value: 'secret',
        domain: 'example.com',
        path: '/',
        expires: null,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        url: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    store.upsertLlmSettings({
      role: 'planner',
      providerPresetId: '',
      provider: 'llm-router',
      baseUrl: 'http://127.0.0.1:18000/v1',
      apiKey: 'sk-secret',
      model: 'openai/gpt-4o',
      enabled: true,
      updatedAt: now,
    });

    expect(store.getBrowserInstance('instance-1')).toMatchObject({
      name: 'Research browser',
      mode: 'system',
      browserFamily: 'chrome',
      executablePath: '/usr/bin/google-chrome',
      cookieJarId: 'jar-1',
      viewport: { width: 1280, height: 720 },
    });
    expect(store.listCookieJars()[0]).toMatchObject({ id: 'jar-1', cookieCount: 1 });
    expect(store.getCookieJar('jar-1')?.cookies[0]).toMatchObject({ name: 'session', value: 'secret' });
    expect(store.listLlmSettings()[0]).toMatchObject({
      role: 'planner',
      hasApiKey: true,
      model: 'openai/gpt-4o',
    });
    expect('apiKey' in store.listLlmSettings()[0]).toBe(false);
  });

  it('migrates legacy browser instances with default runtime fields', () => {
    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE browser_instances (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        startUrl TEXT NOT NULL,
        profilePath TEXT,
        cookieJarId TEXT,
        viewport TEXT NOT NULL,
        headless INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.prepare('INSERT INTO browser_instances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-instance',
      'Legacy browser',
      'stopped',
      'https://example.com',
      null,
      null,
      JSON.stringify({ width: 1280, height: 720 }),
      0,
      '2026-04-09T12:00:00.000Z',
      '2026-04-09T12:00:00.000Z'
    );
    db.close();

    const store = createWorkbenchStore({ dbPath });

    expect(store.getBrowserInstance('legacy-instance')).toMatchObject({
      mode: 'managed',
      browserFamily: 'chromium',
      executablePath: '',
    });
  });

  it('migrates legacy llm settings into a default active preset', () => {
    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE llm_settings (
        role TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        baseUrl TEXT NOT NULL,
        apiKey TEXT NOT NULL,
        model TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.prepare('INSERT INTO llm_settings VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'planner',
      'legacy',
      'https://legacy.example/v1',
      'sk-legacy',
      'legacy/planner',
      1,
      '2026-04-09T12:00:00.000Z'
    );
    db.close();

    const store = createWorkbenchStore({ dbPath });
    const { presets, activePresetId } = store.listLlmPresets();

    expect(activePresetId).toBe('default');
    expect(presets[0]).toMatchObject({
      id: 'default',
      name: 'Default',
      active: true,
      roles: {
        planner: {
          providerPresetId: 'default-provider',
          provider: 'legacy',
          model: 'legacy/planner',
          hasApiKey: true,
        },
      },
    });
    expect(store.getLlmSettings('planner')?.model).toBe('legacy/planner');
    expect(store.listLlmProviderPresets()[0]).toMatchObject({
      provider: 'legacy',
      hasApiKey: true,
    });
    expect('apiKey' in presets[0].roles.planner).toBe(false);
  });

  it('resolves provider preset updates across referencing roles and protects provider deletion', () => {
    const store = createWorkbenchStore({ dbPath: createTempDbPath() });
    const now = '2026-04-09T12:00:00.000Z';
    const provider = store.createLlmProviderPreset({
      id: 'shared-provider',
      name: 'Shared',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-shared',
      createdAt: now,
      updatedAt: now,
    });
    store.createLlmPreset({
      id: 'preset-1',
      name: 'Shared roles',
      roles: {
        planner: { ...makeLlmRole('planner', 'planner-model', now), providerPresetId: provider.id },
        executor: { ...makeLlmRole('executor', 'executor-model', now), providerPresetId: provider.id },
        vision: makeLlmRole('vision', 'vision-model', now),
      },
      createdAt: now,
      updatedAt: now,
    });

    store.updateLlmProviderPreset('shared-provider', {
      baseUrl: 'https://proxy.example/v1',
      apiKey: '__KEEP__',
      updatedAt: now,
    });

    expect(store.getLlmSettings('planner')).toMatchObject({
      providerPresetId: 'shared-provider',
      baseUrl: 'https://proxy.example/v1',
      apiKey: 'sk-shared',
    });
    expect(store.getLlmSettings('executor')?.baseUrl).toBe('https://proxy.example/v1');
    expect(store.deleteLlmProviderPreset('shared-provider')).toBe(false);
    expect(store.deleteLlmProviderPreset('default-provider')).toBe(true);
    expect(store.deleteLlmProviderPreset('shared-provider')).toBe(false);
    expect('apiKey' in store.listLlmProviderPresets()[0]).toBe(false);
  });

  it('creates, updates, activates, and deletes llm presets', () => {
    const store = createWorkbenchStore({ dbPath: createTempDbPath() });
    const now = '2026-04-09T12:00:00.000Z';
    const makeRoles = (model: string) => ({
      planner: makeLlmRole('planner', model, now),
      executor: makeLlmRole('executor', `${model}-executor`, now),
      vision: makeLlmRole('vision', `${model}-vision`, now),
    });

    const first = store.createLlmPreset({ id: 'preset-1', name: 'First', roles: makeRoles('first'), createdAt: now, updatedAt: now });
    const second = store.createLlmPreset({ id: 'preset-2', name: 'Second', roles: makeRoles('second'), createdAt: now, updatedAt: now });

    expect(first.active).toBe(true);
    expect(second.active).toBe(true);
    expect(store.getLlmSettings('planner')?.model).toBe('second');

    store.activateLlmPreset('preset-1', now);
    expect(store.getLlmSettings('executor')?.model).toBe('first-executor');

    store.updateLlmPreset('preset-1', {
      name: 'Renamed',
      roles: { planner: { ...makeLlmRole('planner', 'updated', now), apiKey: '__KEEP__' } },
      updatedAt: now,
    });
    expect(store.listLlmPresets().presets[0]).toMatchObject({
      id: 'preset-1',
      name: 'Renamed',
      roles: { planner: { model: 'updated', hasApiKey: true } },
    });

    expect(store.deleteLlmPreset('preset-1')).toBe(true);
    expect(store.listLlmPresets().activePresetId).toBe('preset-2');
    expect(store.deleteLlmPreset('preset-2')).toBe(false);
  });
});

function makeLlmRole(role: 'planner' | 'executor' | 'vision', model: string, updatedAt: string) {
  return {
    role,
    providerPresetId: '',
    provider: 'llm-router',
    baseUrl: 'http://127.0.0.1:18000/v1',
    apiKey: `sk-${role}`,
    model,
    enabled: true,
    updatedAt,
  };
}

function makeFlow(id: string, name: string, updatedAt = '2026-04-09T10:00:00.000Z'): FlowDefinition {
  return {
    id,
    name,
    startUrl: 'https://example.com/login',
    sessionConfig: {
      sessionName: `${id}-session`,
      viewport: { width: 1440, height: 900 },
      headless: false,
      profile: null,
    },
    steps: [
      {
        id: `${id}-step-1`,
        type: 'open',
        label: 'Open login page',
        enabled: true,
        timeoutMs: 30000,
        target: null,
        input: { url: 'https://example.com/login' },
      },
    ],
    createdAt: '2026-04-09T09:00:00.000Z',
    updatedAt,
  };
}
