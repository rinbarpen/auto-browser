import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parse } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import next from 'next';
import { nanoid } from 'nanoid';
import { makeDefaultFlow } from './src/workbench/factory';
import { WebSocketServer } from 'ws';
import { getWorkbenchServices } from './src/workbench/services';
import { buildRecordingStopResponse } from './src/workbench/recording-stop';
import { buildSessionDebugResponse } from './src/workbench/session-debug';
import { routeUpgradeRequest } from './src/workbench/server-upgrade';
import { detectBrowserInstanceCandidates } from './src/workbench/browser-detection';
import { createServerLogger } from './src/workbench/server-logger';
import type { FlowDefinition } from './src/workbench/types';
import type { CookieRecord, LlmProviderPreset, LlmRole, LlmSettingsRecord } from './src/workbench/types';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, dir: process.cwd() });
const handle = app.getRequestHandler();
const { config, runtime, store } = getWorkbenchServices();
const logger = createServerLogger({
  service: 'workbench',
  fileName: 'workbench.log',
});

await app.prepare();
const handleUpgrade = app.getUpgradeHandler();

const previewServer = new WebSocketServer({ noServer: true });

const server = createServer((req, res) => {
  void routeLoggedRequest(req, res);
});

server.on('upgrade', (request, socket, head) => {
  void routeUpgradeRequest({
    request,
    socket,
    head,
    previewUpgrade: previewServer.handleUpgrade.bind(previewServer),
    attachPreviewSocket: (sessionId, ws) => runtime.attachPreviewSocket(sessionId, ws),
    attachInstancePreviewSocket: (instanceId, ws) => runtime.attachInstancePreviewSocket(instanceId, ws),
    nextUpgrade: handleUpgrade,
    logger,
  }).catch(() => {
    logger.error('websocket.upgrade.error', {
      pathname: request.url?.split('?')[0] ?? '',
      error: 'upgrade routing failed',
    });
    socket.destroy();
  });
});

server.listen(config.port, () => {
  logger.info('server.start', {
    host: 'localhost',
    port: config.port,
    mode: dev ? 'development' : 'production',
    databasePath: config.dbPath,
    workspaceDir: process.cwd(),
  });
  console.log(`Workbench ready at http://localhost:${config.port}`);
});

async function routeLoggedRequest(req: IncomingMessage, res: ServerResponse) {
  const startedAt = Date.now();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${config.port}`}`);
  let loggedCompletion = false;
  const logCompletion = (reason: 'finish' | 'close'): void => {
    if (loggedCompletion) {
      return;
    }
    loggedCompletion = true;
    logger.info('http.request.finish', {
      method: req.method ?? 'UNKNOWN',
      pathname: url.pathname,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      reason,
    });
  };

  logger.info('http.request.start', {
    method: req.method ?? 'UNKNOWN',
    pathname: url.pathname,
  });
  res.once('finish', () => logCompletion('finish'));
  res.once('close', () => logCompletion('close'));

  try {
    await routeRequest(req, res);
  } catch (error) {
    logger.error('http.request.error', {
      method: req.method,
      pathname: url.pathname,
      statusCode: 500,
      error: getErrorMessage(error),
    });
    if (!res.headersSent) {
      sendJson(res, 500, { error: getErrorMessage(error) });
      return;
    }
    res.end();
  }
}

async function routeRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${config.port}`}`);
  const pathname = url.pathname;

  if (pathname === '/api/flows' && req.method === 'GET') {
    return sendJson(res, 200, { flows: store.listFlows() });
  }

  if (pathname === '/api/scripts' && req.method === 'GET') {
    return sendJson(res, 200, { scripts: store.listFlows() });
  }

  if (pathname === '/api/flows' && req.method === 'POST') {
    const contentType = req.headers['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      const body = (await readJson(req)) as { name?: string; startUrl?: string };
      const flow = makeDefaultFlow(body);
      store.saveFlow(flow);
      return sendJson(res, 201, { flow });
    }

    const form = await readForm(req);
    const flow = makeDefaultFlow({
      name: form.get('name') ?? undefined,
      startUrl: form.get('startUrl') ?? undefined,
    });
    store.saveFlow(flow);
    res.writeHead(303, { Location: `/flows/${flow.id}` });
    res.end();
    return;
  }

  const flowIdMatch = pathname.match(/^\/api\/flows\/([^/]+)$/);
  if (flowIdMatch && req.method === 'GET') {
    const flow = store.getFlow(flowIdMatch[1]);
    return flow ? sendJson(res, 200, { flow }) : sendJson(res, 404, { error: 'Flow not found' });
  }

  if (flowIdMatch && req.method === 'PUT') {
    const current = store.getFlow(flowIdMatch[1]);
    if (!current) return sendJson(res, 404, { error: 'Flow not found' });
    const body = (await readJson(req)) as FlowDefinition;
    const nextFlow: FlowDefinition = {
      ...body,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    store.saveFlow(nextFlow);
    return sendJson(res, 200, { flow: nextFlow });
  }

  const runMatch = pathname.match(/^\/api\/flows\/([^/]+)\/runs$/);
  if (runMatch && req.method === 'POST') {
    const flow = store.getFlow(runMatch[1]);
    if (!flow) return sendJson(res, 404, { error: 'Flow not found' });
    const body = (await readJson(req)) as { instanceId?: string | null; interactive?: boolean; pauseOnFailure?: boolean };
    try {
      const result = await runtime.runFlow(flow, {
        instanceId: body.instanceId ?? null,
        interactive: body.interactive ?? false,
        pauseOnFailure: body.pauseOnFailure ?? false,
      });
      return sendJson(res, 202, result);
    } catch (error) {
      logRuntimeError('flow.run.failed', error, { flowId: runMatch[1] });
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const scriptRunMatch = pathname.match(/^\/api\/scripts\/([^/]+)\/runs$/);
  if (scriptRunMatch && req.method === 'POST') {
    const flow = store.getFlow(scriptRunMatch[1]);
    if (!flow) return sendJson(res, 404, { error: 'Script not found' });
    const body = (await readJson(req)) as { instanceId?: string | null; interactive?: boolean; pauseOnFailure?: boolean };
    if (body.interactive && !body.instanceId) {
      return sendJson(res, 400, { error: 'instanceId is required for interactive script runs' });
    }
    try {
      const result = await runtime.runFlow(flow, {
        instanceId: body.instanceId ?? null,
        interactive: body.interactive ?? false,
        pauseOnFailure: body.pauseOnFailure ?? false,
      });
      return sendJson(res, 202, result);
    } catch (error) {
      logRuntimeError('script.run.failed', error, { scriptId: scriptRunMatch[1] });
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const skillExportMatch = pathname.match(/^\/api\/scripts\/([^/]+)\/export\/skill$/);
  if (skillExportMatch && req.method === 'GET') {
    const flow = store.getFlow(skillExportMatch[1]);
    if (!flow) return sendJson(res, 404, { error: 'Script not found' });
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slugify(flow.name)}-SKILL.md"`,
    });
    res.end(buildSkillMarkdown(flow));
    return;
  }

  if (pathname === '/api/instances' && req.method === 'GET') {
    return sendJson(res, 200, { instances: runtime.listInstances() });
  }

  if (pathname === '/api/instances/detected' && req.method === 'GET') {
    return sendJson(res, 200, { candidates: detectBrowserInstanceCandidates(runtime.listInstances()) });
  }

  if (pathname === '/api/instances' && req.method === 'POST') {
    const body = (await readJson(req)) as {
      name?: string;
      startUrl?: string;
      mode?: 'managed' | 'system';
      browserFamily?: 'chromium' | 'chrome' | 'edge';
      executablePath?: string;
      profilePath?: string | null;
      cookieJarId?: string | null;
      viewport?: { width: number; height: number };
      headless?: boolean;
    };
    const instance = await runtime.createInstance(body);
    return sendJson(res, 201, { instance });
  }

  const instanceActionMatch = pathname.match(/^\/api\/instances\/([^/]+)\/(start|stop|refresh)$/);
  if (instanceActionMatch && req.method === 'POST') {
    try {
      const [, instanceId, action] = instanceActionMatch;
      if (action === 'start') {
        return sendJson(res, 200, { instance: await runtime.startInstance(instanceId) });
      }
      if (action === 'refresh') {
        return sendJson(res, 200, { instance: await runtime.refreshInstance(instanceId) });
      }
      await runtime.stopInstance(instanceId);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      logRuntimeError('instance.action.failed', error, {
        instanceId: instanceActionMatch[1],
        action: instanceActionMatch[2],
      });
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const instanceCookieActionMatch = pathname.match(/^\/api\/instances\/([^/]+)\/cookies\/(capture|apply)$/);
  if (instanceCookieActionMatch && req.method === 'POST') {
    try {
      const body = (await readJson(req)) as { jarId?: string };
      if (!body.jarId) return sendJson(res, 400, { error: 'jarId is required' });
      const result =
        instanceCookieActionMatch[2] === 'capture'
          ? await runtime.captureCookies(instanceCookieActionMatch[1], body.jarId)
          : await runtime.applyCookies(instanceCookieActionMatch[1], body.jarId);
      return sendJson(res, 200, result);
    } catch (error) {
      logRuntimeError('instance.cookies.failed', error, {
        instanceId: instanceCookieActionMatch[1],
        action: instanceCookieActionMatch[2],
      });
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (pathname === '/api/cookie-jars' && req.method === 'GET') {
    return sendJson(res, 200, { jars: store.listCookieJars() });
  }

  if (pathname === '/api/cookie-jars' && req.method === 'POST') {
    const body = (await readJson(req)) as { name?: string; site?: string; account?: string | null; cookies?: unknown[] };
    const now = new Date().toISOString();
    const jar = {
      id: nanoid(),
      name: body.name?.trim() || 'Cookie jar',
      site: body.site?.trim() || 'https://example.com',
      account: body.account?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    store.saveCookieJar(jar);
    if (Array.isArray(body.cookies)) {
      store.replaceCookies(jar.id, body.cookies.map((cookie) => normalizeCookie(jar.id, cookie)));
    }
    return sendJson(res, 201, { jar: store.getCookieJar(jar.id) });
  }

  const cookieImportMatch = pathname.match(/^\/api\/cookie-jars\/([^/]+)\/import$/);
  if (cookieImportMatch && req.method === 'POST') {
    const jar = store.getCookieJar(cookieImportMatch[1]);
    if (!jar) return sendJson(res, 404, { error: 'Cookie jar not found' });
    const body = (await readJson(req)) as { cookies?: unknown[] } | unknown[];
    const cookies = Array.isArray(body) ? body : Array.isArray(body.cookies) ? body.cookies : [];
    store.replaceCookies(jar.id, cookies.map((cookie) => normalizeCookie(jar.id, cookie)));
    return sendJson(res, 200, { jar: store.getCookieJar(jar.id) });
  }

  const cookieJarActionMatch = pathname.match(/^\/api\/cookie-jars\/([^/]+)\/(export|download)$/);
  if (cookieJarActionMatch && req.method === 'POST') {
    const jar = store.getCookieJar(cookieJarActionMatch[1]);
    if (!jar) return sendJson(res, 404, { error: 'Cookie jar not found' });
    // Convert to Playwright storage-state format
    const cookieEntries = jar.cookies.map((c) => {
      const entry: Record<string, unknown> = {
        name: c.name,
        value: c.value,
        domain: c.domain ?? jar.site,
        path: c.path ?? '/',
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite ?? 'Lax',
      };
      if (c.expires != null && c.expires >= 0) entry.expires = c.expires;
      return entry;
    });
    const state = { cookies: cookieEntries, origins: [] };
    if (cookieJarActionMatch[2] === 'download') {
      const json = JSON.stringify(state, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slugify(jar.name)}-cookies.json"`,
      });
      res.end(json);
      return;
    }
    // Export to root cookies.json
    const rootCookiesPath = path.resolve(process.cwd(), '..', 'cookies.json');
    fs.writeFileSync(rootCookiesPath, JSON.stringify(state, null, 2), 'utf-8');
    return sendJson(res, 200, { path: rootCookiesPath, cookieCount: cookieEntries.length });
  }

  const cookieJarSingleMatch = pathname.match(/^\/api\/cookie-jars\/([^/]+)$/);
  if (cookieJarSingleMatch && req.method === 'GET') {
    const jar = store.getCookieJar(cookieJarSingleMatch[1]);
    return jar ? sendJson(res, 200, { jar }) : sendJson(res, 404, { error: 'Cookie jar not found' });
  }
  if (cookieJarSingleMatch && req.method === 'DELETE') {
    const deleted = store.deleteCookieJar(cookieJarSingleMatch[1]);
    return deleted
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, 404, { error: 'Cookie jar not found' });
  }

  if (pathname === '/api/settings/llm' && req.method === 'GET') {
    return sendJson(res, 200, { settings: store.listLlmSettings() });
  }

  if (pathname === '/api/settings/llm/presets' && req.method === 'GET') {
    return sendJson(res, 200, { ...store.listLlmPresets(), providerPresets: store.listLlmProviderPresets() });
  }

  if (pathname === '/api/settings/llm/provider-presets' && req.method === 'GET') {
    return sendJson(res, 200, { providerPresets: store.listLlmProviderPresets() });
  }

  if (pathname === '/api/settings/llm/provider-presets' && req.method === 'POST') {
    const body = (await readJson(req)) as Partial<LlmProviderPreset>;
    const now = new Date().toISOString();
    const preset = store.createLlmProviderPreset({
      id: nanoid(),
      ...normalizeProviderPresetInput(body),
      createdAt: now,
      updatedAt: now,
    });
    return sendJson(res, 201, { preset, providerPresets: store.listLlmProviderPresets() });
  }

  const llmProviderPresetMatch = pathname.match(/^\/api\/settings\/llm\/provider-presets\/([^/]+)$/);
  if (llmProviderPresetMatch && req.method === 'PUT') {
    const body = (await readJson(req)) as Partial<LlmProviderPreset>;
    const now = new Date().toISOString();
    const preset = store.updateLlmProviderPreset(llmProviderPresetMatch[1], {
      ...normalizeProviderPresetInput(body),
      apiKey: body.apiKey ? String(body.apiKey) : '__KEEP__',
      updatedAt: now,
    });
    return preset
      ? sendJson(res, 200, { preset, providerPresets: store.listLlmProviderPresets() })
      : sendJson(res, 404, { error: 'Provider preset not found' });
  }

  if (llmProviderPresetMatch && req.method === 'DELETE') {
    const deleted = store.deleteLlmProviderPreset(llmProviderPresetMatch[1]);
    return deleted
      ? sendJson(res, 200, { providerPresets: store.listLlmProviderPresets() })
      : sendJson(res, 400, { error: 'Cannot delete provider preset' });
  }

  if (pathname === '/api/settings/llm/presets' && req.method === 'POST') {
    const body = (await readJson(req)) as { name?: string; roles?: Partial<Record<LlmRole, Partial<LlmSettingsRecord>>> };
    const now = new Date().toISOString();
    const current = Object.fromEntries(
      store.listLlmSettings().map((setting) => [setting.role, setting])
    ) as Partial<Record<LlmRole, Partial<LlmSettingsRecord>>>;
    const roles = normalizePresetRoles({ ...current, ...(body.roles ?? {}) }, now);
    const preset = store.createLlmPreset({
      id: nanoid(),
      name: String(body.name ?? '').trim() || 'New preset',
      roles,
      createdAt: now,
      updatedAt: now,
    });
    return sendJson(res, 201, { preset, ...store.listLlmPresets(), providerPresets: store.listLlmProviderPresets() });
  }

  const llmPresetMatch = pathname.match(/^\/api\/settings\/llm\/presets\/([^/]+)$/);
  if (llmPresetMatch && req.method === 'PUT') {
    const body = (await readJson(req)) as { name?: string; roles?: Partial<Record<LlmRole, Partial<LlmSettingsRecord>>> };
    const now = new Date().toISOString();
    const roles = body.roles ? normalizePartialPresetRoles(body.roles, now) : undefined;
    const preset = store.updateLlmPreset(llmPresetMatch[1], { name: body.name, roles, updatedAt: now });
    return preset
      ? sendJson(res, 200, { preset, ...store.listLlmPresets(), providerPresets: store.listLlmProviderPresets() })
      : sendJson(res, 404, { error: 'Preset not found' });
  }

  if (llmPresetMatch && req.method === 'DELETE') {
    const deleted = store.deleteLlmPreset(llmPresetMatch[1]);
    return deleted
      ? sendJson(res, 200, { ...store.listLlmPresets(), providerPresets: store.listLlmProviderPresets() })
      : sendJson(res, 400, { error: 'Cannot delete preset' });
  }

  const llmPresetActivateMatch = pathname.match(/^\/api\/settings\/llm\/presets\/([^/]+)\/activate$/);
  if (llmPresetActivateMatch && req.method === 'POST') {
    const preset = store.activateLlmPreset(llmPresetActivateMatch[1], new Date().toISOString());
    return preset
      ? sendJson(res, 200, { preset, ...store.listLlmPresets(), providerPresets: store.listLlmProviderPresets() })
      : sendJson(res, 404, { error: 'Preset not found' });
  }

  if (pathname === '/api/settings/llm' && req.method === 'PUT') {
    const body = (await readJson(req)) as Partial<LlmSettingsRecord>;
    const role = body.role;
    if (!role || !['planner', 'executor', 'vision'].includes(role)) {
      return sendJson(res, 400, { error: 'role must be planner, executor, or vision' });
    }
    const current = store.getLlmSettings(role);
    store.upsertLlmSettings({
      role,
      providerPresetId: body.providerPresetId ?? current?.providerPresetId ?? store.listLlmProviderPresets()[0]?.id ?? 'default-provider',
      provider: body.provider ?? current?.provider ?? 'llm-router',
      baseUrl: body.baseUrl ?? current?.baseUrl ?? 'http://127.0.0.1:18000/v1',
      apiKey: body.apiKey ? body.apiKey : '__KEEP__',
      model: body.model ?? current?.model ?? 'openai/gpt-4o',
      enabled: body.enabled ?? current?.enabled ?? true,
      updatedAt: new Date().toISOString(),
    });
    return sendJson(res, 200, { settings: store.listLlmSettings() });
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    const body = (await readJson(req)) as { message?: string; role?: LlmSettingsRecord['role'] };
    const role = body.role ?? 'planner';
    const settings = runtime.getLlmSettings(role);
    return sendJson(res, 200, {
      role,
      model: settings?.model ?? null,
      enabled: settings?.enabled ?? false,
      message: settings?.enabled
        ? `Loaded ${role} model ${settings.model} from current LLM settings.`
        : 'No enabled LLM setting is configured for this role.',
      echo: body.message ?? '',
    });
  }

  const runsDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runsDetailMatch && req.method === 'GET') {
    const run = store.getRunWithDetails(runsDetailMatch[1]);
    return run ? sendJson(res, 200, run) : sendJson(res, 404, { error: 'Run not found' });
  }

  const runControlMatch = pathname.match(/^\/api\/runs\/([^/]+)\/(pause|resume|cancel)$/);
  if (runControlMatch && req.method === 'POST') {
    const runId = runControlMatch[1];
    const action = runControlMatch[2];
    if (!store.getRunWithDetails(runId)) {
      return sendJson(res, 404, { error: 'Run not found' });
    }
    if (action === 'pause') {
      const accepted = runtime.requestRunPause(runId);
      return accepted ? sendJson(res, 202, { ok: true }) : sendJson(res, 409, { error: 'Run is not running' });
    }
    if (action === 'resume') {
      const accepted = runtime.resumeRun(runId);
      return accepted ? sendJson(res, 202, { ok: true }) : sendJson(res, 409, { error: 'Run is not paused' });
    }
    const accepted = await runtime.cancelRun(runId);
    return accepted ? sendJson(res, 202, { ok: true }) : sendJson(res, 409, { error: 'Run is already finished' });
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    const body = (await readJson(req)) as { flowId: string };
    const flow = store.getFlow(body.flowId);
    if (!flow) return sendJson(res, 404, { error: 'Flow not found' });
    try {
      const result = await runtime.createSession(flow);
      return sendJson(res, 201, result);
    } catch (error) {
      logRuntimeError('session.create.failed', error, { flowId: body.flowId });
      return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const recordingStartMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/recording\/start$/);
  if (recordingStartMatch && req.method === 'POST') {
    try {
      const result = await runtime.startRecording(recordingStartMatch[1]);
      return sendJson(res, 201, result);
    } catch (error) {
      logRuntimeError('recording.start.failed', error, { sessionId: recordingStartMatch[1] });
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const recordingStopMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/recording\/stop$/);
  if (recordingStopMatch && req.method === 'POST') {
    try {
      const response = await buildRecordingStopResponse({
        runtime,
        store,
        sessionId: recordingStopMatch[1],
      });
      return sendJson(res, response.statusCode, response.payload);
    } catch (error) {
      logRuntimeError('recording.stop.failed', error, { sessionId: recordingStopMatch[1] });
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const sessionDebugMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/debug$/);
  if (sessionDebugMatch && req.method === 'GET') {
    const response = await buildSessionDebugResponse({
      isDev: dev,
      runtime,
      sessionId: sessionDebugMatch[1],
    });
    return sendJson(res, response.statusCode, response.payload);
  }

  // --- Auto-Browser Control Service Proxy Routes ---
  // The control service runs on port 4317 with permissive CORS.
  const CS = `http://127.0.0.1:4317`;

  // GET /api/instances/:id/cdp-endpoint — CDP endpoint for a running instance
  const cdpEndpointMatch = pathname.match(/^\/api\/instances\/([^/]+)\/cdp-endpoint$/);
  if (cdpEndpointMatch && req.method === 'GET') {
    const cdpEndpoint = runtime.getInstanceCdpEndpoint(cdpEndpointMatch[1]);
    return sendJson(res, 200, { cdpEndpoint });
  }

  // POST /api/auto-browser/start — Start a workbench instance for auto-browser + get CDP endpoint
  if (pathname === '/api/auto-browser/start' && req.method === 'POST') {
    try {
      const body = (await readJson(req)) as {
        instanceId?: string;
        startUrl?: string;
      };
      let instanceId = body.instanceId;

      // Create a new instance if no instanceId provided
      if (!instanceId) {
        const instance = await runtime.createInstance({
          name: 'Auto Browser',
          startUrl: body.startUrl || 'https://example.com',
          headless: false,
        });
        instanceId = instance.id;
      }

      // Start the instance with CDP enabled
      const instanceRecord = await runtime.startInstance(instanceId);
      const cdpUrl = runtime.getInstanceCdpEndpoint(instanceId);

      return sendJson(res, 200, { instance: instanceRecord, cdpUrl });
    } catch (error) {
      return sendJson(res, 400, { error: getErrorMessage(error) });
    }
  }

  // Proxy: GET /api/auto-browser/state
  if (pathname === '/api/auto-browser/state' && req.method === 'GET') {
    const response = await fetch(`${CS}/api/state`);
    const data = await response.json();
    return sendJson(res, response.status, data);
  }

  // Proxy: POST /api/auto-browser/conversations
  if (pathname === '/api/auto-browser/conversations' && req.method === 'POST') {
    const response = await fetch(`${CS}/api/conversations`, { method: 'POST' });
    const data = await response.json();
    return sendJson(res, response.status, data);
  }

  // Proxy: POST /api/auto-browser/conversations/:id/messages
  const convMessageMatch = pathname.match(/^\/api\/auto-browser\/conversations\/([^/]+)\/messages$/);
  if (convMessageMatch && req.method === 'POST') {
    const body = await readJson(req);
    const response = await fetch(`${CS}/api/conversations/${convMessageMatch[1]}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return sendJson(res, response.status, data);
  }

  // Proxy: POST /api/auto-browser/tasks/:id/run
  const taskRunMatch = pathname.match(/^\/api\/auto-browser\/tasks\/([^/]+)\/run$/);
  if (taskRunMatch && req.method === 'POST') {
    const response = await fetch(`${CS}/api/tasks/${taskRunMatch[1]}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'service' }),
    });
    const data = await response.json();
    return sendJson(res, response.status, data);
  }

  // Proxy: POST /api/auto-browser/tasks/:id/handoff
  const taskHandoffMatch = pathname.match(/^\/api\/auto-browser\/tasks\/([^/]+)\/handoff$/);
  if (taskHandoffMatch && req.method === 'POST') {
    const body = await readJson(req);
    const response = await fetch(`${CS}/api/tasks/${taskHandoffMatch[1]}/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return sendJson(res, response.status, data);
  }

  // Proxy: POST /api/auto-browser/tasks/:id/resume
  const taskResumeMatch = pathname.match(/^\/api\/auto-browser\/tasks\/([^/]+)\/resume$/);
  if (taskResumeMatch && req.method === 'POST') {
    const body = await readJson(req);
    const response = await fetch(`${CS}/api/tasks/${taskResumeMatch[1]}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return sendJson(res, response.status, data);
  }

  // Proxy: POST /api/auto-browser/tasks/:id/cancel
  const taskCancelMatch = pathname.match(/^\/api\/auto-browser\/tasks\/([^/]+)\/cancel$/);
  if (taskCancelMatch && req.method === 'POST') {
    const response = await fetch(`${CS}/api/tasks/${taskCancelMatch[1]}/cancel`, {
      method: 'POST',
    });
    const data = response.status === 204 ? { ok: true } : await response.json();
    return sendJson(res, response.status, data);
  }

  // --- Credential Management Routes ---
  // GET /api/auto-browser/credentials — list saved credential sites
  if (pathname === '/api/auto-browser/credentials' && req.method === 'GET') {
    try {
      const { loadCredentials } = await import(
        '../src/auto-browser/credential-store.js'
      ) as typeof import('../src/auto-browser/credential-store');
      const creds = loadCredentials();
      const sites = Object.fromEntries(
        Object.entries(creds.sites).map(([site, data]) => [
          site,
          { username: data.username, hasPassword: Boolean(data.password) },
        ])
      );
      return sendJson(res, 200, { sites });
    } catch (error) {
      return sendJson(res, 200, { sites: {} });
    }
  }

  // POST /api/auto-browser/credentials — save new credential
  if (pathname === '/api/auto-browser/credentials' && req.method === 'POST') {
    try {
      const body = (await readJson(req)) as { site: string; username: string; password: string };
      const { loadCredentials, saveCredentials } = await import(
        '../src/auto-browser/credential-store.js'
      ) as typeof import('../src/auto-browser/credential-store');
      const creds = loadCredentials();
      creds.sites[body.site] = { username: body.username, password: body.password };
      saveCredentials(creds);
      return sendJson(res, 201, { saved: true });
    } catch (error) {
      return sendJson(res, 400, { error: getErrorMessage(error) });
    }
  }

  // DELETE /api/auto-browser/credentials/:site — delete credential
  const credDeleteMatch = pathname.match(/^\/api\/auto-browser\/credentials\/([^/]+)$/);
  if (credDeleteMatch && req.method === 'DELETE') {
    try {
      const site = decodeURIComponent(credDeleteMatch[1]);
      const { loadCredentials, saveCredentials } = await import(
        '../src/auto-browser/credential-store.js'
      ) as typeof import('../src/auto-browser/credential-store');
      const creds = loadCredentials();
      delete creds.sites[site];
      saveCredentials(creds);
      return sendJson(res, 200, { deleted: true });
    } catch (error) {
      return sendJson(res, 400, { error: getErrorMessage(error) });
    }
  }

  await handle(req, res, parse(req.url ?? '/', true));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  return body.length > 0 ? JSON.parse(body) : {};
}

async function readForm(req: IncomingMessage): Promise<Map<string, string>> {
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  return new Map(Array.from(params.entries()));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function logRuntimeError(event: string, error: unknown, fields: Record<string, unknown>) {
  logger.error(event, {
    ...fields,
    error: getErrorMessage(error),
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCookie(jarId: string, raw: unknown): CookieRecord {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  return {
    id: nanoid(),
    jarId,
    name: String(input.name ?? ''),
    value: String(input.value ?? ''),
    domain: typeof input.domain === 'string' ? input.domain : null,
    path: typeof input.path === 'string' ? input.path : null,
    expires: typeof input.expires === 'number' && input.expires >= 0 ? input.expires : null,
    httpOnly: Boolean(input.httpOnly),
    secure: Boolean(input.secure),
    sameSite:
      input.sameSite === 'Strict' || input.sameSite === 'Lax' || input.sameSite === 'None'
        ? input.sameSite
        : null,
    url: typeof input.url === 'string' ? input.url : null,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizePresetRoles(
  roles: Partial<Record<LlmRole, Partial<LlmSettingsRecord>>>,
  updatedAt: string
): Record<LlmRole, LlmSettingsRecord> {
  return {
    planner: normalizePresetRole('planner', roles.planner, updatedAt),
    executor: normalizePresetRole('executor', roles.executor, updatedAt),
    vision: normalizePresetRole('vision', roles.vision, updatedAt),
  };
}

function normalizePartialPresetRoles(
  roles: Partial<Record<LlmRole, Partial<LlmSettingsRecord>>>,
  updatedAt: string
): Partial<Record<LlmRole, LlmSettingsRecord>> {
  const normalized: Partial<Record<LlmRole, LlmSettingsRecord>> = {};
  for (const role of ['planner', 'executor', 'vision'] as const) {
    if (roles[role]) {
      normalized[role] = normalizePresetRole(role, roles[role], updatedAt);
    }
  }
  return normalized;
}

function normalizePresetRole(
  role: LlmRole,
  input: Partial<LlmSettingsRecord> | undefined,
  updatedAt: string
): LlmSettingsRecord {
  return {
    role,
    providerPresetId: String(input?.providerPresetId ?? 'default-provider'),
    provider: String(input?.provider ?? 'llm-router'),
    baseUrl: String(input?.baseUrl ?? 'http://127.0.0.1:18000/v1'),
    apiKey: input?.apiKey ? String(input.apiKey) : '__KEEP__',
    model: String(input?.model ?? (role === 'vision' ? '' : 'openai/gpt-4o')),
    enabled: input?.enabled ?? role !== 'vision',
    updatedAt,
  };
}

function normalizeProviderPresetInput(
  input: Partial<LlmProviderPreset> | undefined
): Pick<LlmProviderPreset, 'name' | 'provider' | 'baseUrl' | 'apiKey'> {
  return {
    name: String(input?.name ?? '').trim() || 'Provider preset',
    provider: String(input?.provider ?? 'llm-router').trim() || 'llm-router',
    baseUrl: String(input?.baseUrl ?? 'http://127.0.0.1:18000/v1').trim() || 'http://127.0.0.1:18000/v1',
    apiKey: input?.apiKey ? String(input.apiKey) : '',
  };
}

function buildSkillMarkdown(flow: FlowDefinition): string {
  const safeName = flow.name.replace(/[\r\n]+/g, ' ').trim();
  return `---
name: ${slugify(safeName)}
description: Run the "${safeName}" browser automation script through the local Auto Browser Workbench.
---

# ${safeName}

This skill calls the local Auto Browser Workbench API to run a recorded browser script. It does not embed cookie values. Bind a cookie jar or browser instance in the workbench before running when authentication is required.

## Parameters

- \`instanceId\` (optional): existing browser instance to run against. If omitted, the workbench creates a temporary browser for the run.
- \`interactive\` (optional): set to \`true\` with \`instanceId\` to allow pause/resume and human handoff in the managed browser preview.
- \`pauseOnFailure\` (optional): set to \`true\` to pause after a failed or timed-out step instead of ending the run immediately.
- \`baseUrl\` (optional): workbench origin. Defaults to \`http://127.0.0.1:${config.port}\`.

## Steps

1. Ensure the workbench server is running.
2. Optionally start or select a browser instance with the desired profile and cookie jar.
3. POST to \`/api/scripts/${flow.id}/runs\` with \`{"instanceId":"...","interactive":true,"pauseOnFailure":true}\` when using a managed instance, or \`{}\` for a temporary browser.
4. Poll \`/api/runs/{runId}\` until the run status is \`success\`, \`failed\`, \`paused\`, or \`canceled\`.
5. For interactive runs, use \`POST /api/runs/{runId}/pause\`, \`/resume\`, and \`/cancel\` to control execution.

## Script Metadata

- Script id: \`${flow.id}\`
- Start URL: \`${flow.startUrl}\`
- Steps: ${flow.steps.length}
`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'workbench-script';
}
