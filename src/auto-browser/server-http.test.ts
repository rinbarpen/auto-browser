import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Failed to allocate test port'));
        }
      });
    });
  });
}

function waitForServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for server')), 5000);

    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Auto Browser control service listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before listening: ${code}`));
    });
  });
}

let serverProcess: ChildProcessWithoutNullStreams | null = null;

afterEach(() => {
  serverProcess?.kill();
  serverProcess = null;
});

describe('control service HTTP server', () => {
  it('writes startup, HTTP, error, and SSE lifecycle logs', async () => {
    const port = await getFreePort();
    const logDir = mkdtempSync(join(tmpdir(), 'auto-browser-control-logs-'));
    serverProcess = spawn('./agent-browser/node_modules/.bin/tsx', ['src/auto-browser/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTO_BROWSER_CONTROL_PORT: String(port),
        AUTO_BROWSER_LOG_DIR: logDir,
      },
    });

    await waitForServer(serverProcess);

    await fetch(`http://127.0.0.1:${port}/api/state`);
    await fetch(`http://127.0.0.1:${port}/api/not-found`);

    const controller = new AbortController();
    const eventsResponse = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
    expect(eventsResponse.status).toBe(200);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = readFileSync(join(logDir, 'auto-browser-control.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; pathname?: string; statusCode?: number });

    expect(entries).toContainEqual(expect.objectContaining({ event: 'server.start', port }));
    expect(entries).toContainEqual(
      expect.objectContaining({ event: 'http.request.finish', pathname: '/api/state', statusCode: 200 })
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ event: 'http.request.finish', pathname: '/api/not-found', statusCode: 404 })
    );
    expect(entries).toContainEqual(expect.objectContaining({ event: 'sse.connect', pathname: '/api/events' }));
    expect(entries).toContainEqual(expect.objectContaining({ event: 'sse.close', pathname: '/api/events' }));
  });

  it('responds to CORS preflight without crashing', async () => {
    const port = await getFreePort();
    serverProcess = spawn('./agent-browser/node_modules/.bin/tsx', ['src/auto-browser/server.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, AUTO_BROWSER_CONTROL_PORT: String(port) },
    });

    await waitForServer(serverProcess);

    const response = await fetch(`http://127.0.0.1:${port}/api/conversations/test/messages`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:4321',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(serverProcess.exitCode).toBeNull();
  });

  it('serves detected browser runtime defaults with CORS headers', async () => {
    const port = await getFreePort();
    serverProcess = spawn('./agent-browser/node_modules/.bin/tsx', ['src/auto-browser/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTO_BROWSER_CONTROL_PORT: String(port),
        AGENT_BROWSER_EXECUTABLE_PATH: process.execPath,
      },
    });

    await waitForServer(serverProcess);

    const response = await fetch(`http://127.0.0.1:${port}/api/browser-runtime/defaults`, {
      headers: { origin: 'http://127.0.0.1:4321' },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(payload).toMatchObject({
      platform: process.platform,
      mode: 'system',
      executablePath: process.execPath,
      detected: true,
    });
    expect(payload.browserFamily).toBe('chrome');
    expect(payload.profilePath).toBe('');
    expect(payload.message).toContain('Detected browser executable');
    expect(payload.message).toContain('ephemeral by default');
  });

  it('returns managed defaults when no local Chrome is configured', async () => {
    const port = await getFreePort();
    serverProcess = spawn('./agent-browser/node_modules/.bin/tsx', ['src/auto-browser/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTO_BROWSER_CONTROL_PORT: String(port),
        AUTO_BROWSER_EXECUTABLE_PATH: '',
        AGENT_BROWSER_EXECUTABLE_PATH: '',
      },
    });

    await waitForServer(serverProcess);

    const response = await fetch(`http://127.0.0.1:${port}/api/browser-runtime/defaults`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.mode).toBe('managed');
    expect(payload.browserFamily).toBe('chromium');
    expect(payload.executablePath).toBe('');
    expect(payload.message).toContain('downloaded automatically on first run');
  });

  it('returns a clear error when planner model is missing', async () => {
    const port = await getFreePort();
    const profilePath = mkdtempSync(join(tmpdir(), 'auto-browser-http-profile-'));
    serverProcess = spawn('./agent-browser/node_modules/.bin/tsx', ['src/auto-browser/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTO_BROWSER_CONTROL_PORT: String(port),
        AGENT_BROWSER_EXECUTABLE_PATH: process.execPath,
      },
    });

    await waitForServer(serverProcess);

    const conversationResponse = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
      method: 'POST',
    });
    const conversation = await conversationResponse.json();

    const response = await fetch(`http://127.0.0.1:${port}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Open example.com',
        browserConfig: {
          mode: 'system',
          browserFamily: 'chrome',
          executablePath: process.execPath,
          profilePath,
          extensionEnabled: false,
          previewEnabled: true,
          cdpUrl: '',
          cloakHumanize: false,
          cloakFingerprintSeed: '',
          cloakTimezone: '',
          cloakLocale: '',
        },
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      error: {
        module: 'auto-browser.control-service',
        file: 'src/auto-browser/control-service.ts',
        location: 'submitUserMessage',
        problem: 'Planner model is required for this request.',
      },
    });
  });

  it('returns structured not-found errors for missing tasks', async () => {
    const port = await getFreePort();
    serverProcess = spawn('./agent-browser/node_modules/.bin/tsx', ['src/auto-browser/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTO_BROWSER_CONTROL_PORT: String(port),
      },
    });

    await waitForServer(serverProcess);

    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/task-missing/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executorModel: 'openai/gpt-5.4' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload).toEqual({
      error: {
        module: 'auto-browser.control-service',
        file: 'src/auto-browser/control-service.ts',
        location: 'getTask',
        problem: 'Task not found: task-missing',
      },
    });
  });

  it('reports runtime configuration state for the CLI preflight check', async () => {
    const port = await getFreePort();
    serverProcess = spawn('./agent-browser/node_modules/.bin/tsx', ['src/auto-browser/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTO_BROWSER_CONTROL_PORT: String(port),
        AUTO_BROWSER_PLANNER_MODEL: 'openai/gpt-5.4',
      },
    });

    await waitForServer(serverProcess);

    const response = await fetch(`http://127.0.0.1:${port}/api/runtime-config`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      plannerConfigured: true,
      executorConfigured: false,
      plannerModel: 'openai/gpt-5.4',
      executorModel: '',
      modelTier: '',
    });
  });

  it('exposes extension execution routes through HTTP', async () => {
    const port = await getFreePort();
    const profilePath = mkdtempSync(join(tmpdir(), 'auto-browser-http-extension-profile-'));
    serverProcess = spawn('./agent-browser/node_modules/.bin/tsx', ['src/auto-browser/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTO_BROWSER_CONTROL_PORT: String(port),
        AGENT_BROWSER_EXECUTABLE_PATH: process.execPath,
        AUTO_BROWSER_PLANNER_MODEL: 'openai/gpt-5.4',
        AUTO_BROWSER_EXECUTOR_MODEL: 'openai/gpt-5.4',
      },
    });

    await waitForServer(serverProcess);

    const conversationResponse = await fetch(`http://127.0.0.1:${port}/api/conversations`, { method: 'POST' });
    const conversation = await conversationResponse.json();
    const draftResponse = await fetch(`http://127.0.0.1:${port}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Open example.com and tell me the page title',
        plannerModel: 'openai/gpt-5.4',
        browserConfig: {
          mode: 'system',
          browserFamily: 'chrome',
          executablePath: process.execPath,
          profilePath,
          launchMode: 'auto',
          extensionEnabled: true,
          previewEnabled: true,
          cdpUrl: '',
          cloakHumanize: false,
          cloakFingerprintSeed: '',
          cloakTimezone: '',
          cloakLocale: '',
        },
      }),
    });
    const draft = await draftResponse.json();

    const approveResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${draft.id}/approve-extension`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executorModel: 'openai/gpt-5.4' }),
    });
    expect(approveResponse.status).toBe(200);

    const decideResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${draft.id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        observation: {
          url: 'https://example.com',
          title: 'Example Domain',
          visibleText: 'Example Domain',
          refs: [],
        },
        history: [],
      }),
    });
    const action = await decideResponse.json();
    expect(decideResponse.status).toBe(200);
    expect(action).toMatchObject({ action: expect.any(String) });

    const reportResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${draft.id}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phase: 'completed',
        action: { action: 'finish', message: 'Title: Example Domain', label: 'Finish task' },
        outcome: 'success',
        message: 'Title: Example Domain',
      }),
    });
    expect(reportResponse.status).toBe(200);

    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
    const state = await stateResponse.json();
    expect(state.events.map((event: { type: string }) => event.type)).toContain('task.execution.completed');
    expect(state.conversations[0]).toMatchObject({
      id: conversation.id,
      title: null,
    });
    expect(typeof state.conversations[0].updatedAt).toBe('string');
  });

  it('renames and deletes conversations through HTTP, blocking active-task deletes', async () => {
    const port = await getFreePort();
    const profilePath = mkdtempSync(join(tmpdir(), 'auto-browser-http-conversation-profile-'));
    serverProcess = spawn('./agent-browser/node_modules/.bin/tsx', ['src/auto-browser/server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTO_BROWSER_CONTROL_PORT: String(port),
        AGENT_BROWSER_EXECUTABLE_PATH: process.execPath,
        AUTO_BROWSER_PLANNER_MODEL: 'openai/gpt-5.4',
      },
    });

    await waitForServer(serverProcess);

    const conversationResponse = await fetch(`http://127.0.0.1:${port}/api/conversations`, { method: 'POST' });
    const conversation = await conversationResponse.json();

    const renameResponse = await fetch(`http://127.0.0.1:${port}/api/conversations/${conversation.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Saved thread' }),
    });
    const renamed = await renameResponse.json();
    expect(renameResponse.status).toBe(200);
    expect(renamed.title).toBe('Saved thread');

    const draftResponse = await fetch(`http://127.0.0.1:${port}/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Open example.com and stop',
        plannerModel: 'openai/gpt-5.4',
        browserConfig: {
          mode: 'system',
          browserFamily: 'chrome',
          executablePath: process.execPath,
          profilePath,
          launchMode: 'auto',
          extensionEnabled: true,
          previewEnabled: true,
          cdpUrl: '',
          cloakHumanize: false,
          cloakFingerprintSeed: '',
          cloakTimezone: '',
          cloakLocale: '',
        },
      }),
    });
    const draft = await draftResponse.json();
    expect(draftResponse.status).toBe(201);

    const approveResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${draft.id}/approve-extension`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executorModel: 'openai/gpt-5.4' }),
    });
    expect(approveResponse.status).toBe(200);

    const conflictResponse = await fetch(`http://127.0.0.1:${port}/api/conversations/${conversation.id}`, {
      method: 'DELETE',
    });
    const conflictPayload = await conflictResponse.json();
    expect(conflictResponse.status).toBe(409);
    expect(conflictPayload.error.problem).toBe(
      `Cannot delete conversation with active task: ${conversation.id}`
    );

    const reportResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/${draft.id}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phase: 'completed',
        action: { action: 'finish', message: 'Done', label: 'Finish task' },
        outcome: 'success',
        message: 'Done',
      }),
    });
    expect(reportResponse.status).toBe(200);

    const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/conversations/${conversation.id}`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(204);

    const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`);
    const state = await stateResponse.json();
    expect(state.conversations).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.events).toEqual([]);
  });
});
