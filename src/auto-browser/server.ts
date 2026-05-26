import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  AgentLoopExecutionDriver,
  DemoExecutionDriver,
  DemoPlanner,
  InMemoryControlService,
  LlmExecutorDecider,
  type BrowserRuntimeConfig,
  type ExecutorAction,
  type ExtensionExecutionReport,
  type PageObservation,
} from './control-service.js';
import { detectBrowserRuntimeDefaults } from './browser-runtime-defaults.js';
import { getErrorProblem, toErrorPayload } from './error-context.js';
import { LlmPlanner, LlmRouterClient } from './llm-router.js';
import { createServerLogger } from './server-logger.js';

interface JsonBody {
  [key: string]: unknown;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(204, headers);
  res.end();
}

async function readJson(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonBody;
}

function createControlService(): InMemoryControlService {
  if (process.env.NODE_ENV === 'test') {
    return new InMemoryControlService({
      planner: new DemoPlanner(),
      executionDriver: new DemoExecutionDriver(),
      executorDecider: {
        async decide() {
          return {
            action: 'finish',
            message: 'Done',
            label: 'Finish task',
          };
        },
      },
    });
  }

  const llmClient = new LlmRouterClient({
    baseUrl: process.env.AUTO_BROWSER_LLM_ROUTER_BASE_URL ?? 'http://127.0.0.1:18000',
    apiKey: process.env.AUTO_BROWSER_LLM_ROUTER_API_KEY ?? '',
  });

  return new InMemoryControlService({
    planner: new LlmPlanner(llmClient),
    executionDriver: new AgentLoopExecutionDriver({
      llmClient,
    }),
    executorDecider: new LlmExecutorDecider(llmClient),
  });
}

function getRuntimeConfigStatus(): {
  plannerConfigured: boolean;
  executorConfigured: boolean;
  plannerModel: string;
  executorModel: string;
  modelTier: string;
} {
  const plannerModel = process.env.AUTO_BROWSER_PLANNER_MODEL ?? '';
  const executorModel = process.env.AUTO_BROWSER_EXECUTOR_MODEL ?? '';
  const modelTier = process.env.AUTO_BROWSER_MODEL_TIER ?? '';
  return {
    plannerConfigured: Boolean(plannerModel.trim()),
    executorConfigured: Boolean(executorModel.trim()),
    plannerModel,
    executorModel,
    modelTier,
  };
}

const service = createControlService();
const logger = createServerLogger({
  service: 'auto-browser-control',
  fileName: 'auto-browser-control.log',
});

const sseClients = new Set<ServerResponse>();
service.on('event', (event) => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
});

function parseBrowserConfig(input: JsonBody): BrowserRuntimeConfig {
  const launchMode = input.launchMode;
  if (
    launchMode !== undefined &&
    launchMode !== 'auto' &&
    launchMode !== 'headless' &&
    launchMode !== 'headed'
  ) {
    throw new Error('Invalid browser launch mode. Use auto, headless, or headed.');
  }

  const explicitExecutablePath = String(input.executablePath ?? '').trim();
  const requestedMode = input.mode;
  const mode =
    explicitExecutablePath.length > 0
      ? 'system'
      : requestedMode === 'system' || requestedMode === 'managed'
        ? requestedMode
        : 'managed';

  return {
    mode,
    browserFamily:
      (input.browserFamily as BrowserRuntimeConfig['browserFamily']) ??
      (mode === 'managed' ? 'chromium' : 'chrome'),
    executablePath: explicitExecutablePath,
    profilePath: String(input.profilePath ?? ''),
    cookiesPath: String(input.cookiesPath ?? ''),
    credentialsPath: String(input.credentialsPath ?? ''),
    launchMode: (launchMode as BrowserRuntimeConfig['launchMode']) ?? 'auto',
    extensionEnabled: Boolean(input.extensionEnabled),
    previewEnabled: Boolean(input.previewEnabled ?? true),
    cdpUrl: String(input.cdpUrl ?? ''),
    cloakHumanize: Boolean(input.cloakHumanize ?? false),
    cloakFingerprintSeed: String(input.cloakFingerprintSeed ?? ''),
    cloakTimezone: String(input.cloakTimezone ?? ''),
    cloakLocale: String(input.cloakLocale ?? ''),
  };
}

function resolveRequestModel(input: unknown, fallback: string): string {
  return typeof input === 'string' && input.trim() ? input.trim() : fallback.trim();
}

function serverContext(location: string, problem?: string) {
  return {
    module: 'auto-browser.server',
    file: 'src/auto-browser/server.ts',
    location,
    problem,
  };
}

function getHttpErrorStatus(error: unknown): number {
  const problem = getErrorProblem(error);
  if (
    problem === 'Invalid request' ||
    problem.startsWith('Invalid browser launch mode') ||
    problem.includes('Unexpected token')
  ) {
    return 400;
  }
  if (problem === 'Not found' || problem.startsWith('Conversation not found:') || problem.startsWith('Task not found:')) {
    return 404;
  }
  if (
    problem.startsWith('Only one active task can run at a time') ||
    problem.startsWith('Cannot hand off a ') ||
    problem.startsWith('Cannot cancel') ||
    problem.startsWith('Cannot delete conversation with active task:')
  ) {
    return 409;
  }
  return 500;
}

const server = http.createServer(async (req, res) => {
  let location = 'request:unknown';
  const startedAt = Date.now();
  let pathname = req.url ? new URL(req.url, 'http://127.0.0.1').pathname : '';
  let loggedCompletion = false;

  logger.info('http.request.start', {
    method: req.method ?? 'UNKNOWN',
    pathname,
  });

  const logCompletion = (reason: 'finish' | 'close'): void => {
    if (loggedCompletion) {
      return;
    }
    loggedCompletion = true;
    logger.info('http.request.finish', {
      method: req.method ?? 'UNKNOWN',
      pathname,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      location,
      reason,
    });
  };
  res.once('finish', () => logCompletion('finish'));
  res.once('close', () => logCompletion('close'));

  if (!req.url || !req.method) {
    sendJson(res, 400, toErrorPayload(new Error('Invalid request'), serverContext(location)));
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');
  pathname = url.pathname;

  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      location = 'route:/api/state';
      sendJson(res, 200, {
        conversations: service.getConversations(),
        tasks: service.getTasks(),
        activeTask: service.getActiveTask(),
        events: service.getEventsSince(0),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/browser-runtime/defaults') {
      location = 'route:/api/browser-runtime/defaults';
      sendJson(res, 200, detectBrowserRuntimeDefaults());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/runtime-config') {
      location = 'route:/api/runtime-config';
      sendJson(res, 200, getRuntimeConfigStatus());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      location = 'route:/api/events';
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write('\n');
      sseClients.add(res);
      logger.info('sse.connect', {
        pathname: url.pathname,
        clients: sseClients.size,
      });
      req.on('close', () => {
        sseClients.delete(res);
        logger.info('sse.close', {
          pathname: url.pathname,
          clients: sseClients.size,
        });
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/conversations') {
      location = 'route:/api/conversations';
      const conversation = service.createConversation();
      sendJson(res, 201, conversation);
      return;
    }

    if (req.method === 'PATCH' && url.pathname.match(/^\/api\/conversations\/[^/]+$/)) {
      location = 'route:/api/conversations/:id';
      const conversationId = url.pathname.split('/')[3] ?? '';
      const body = await readJson(req);
      const conversation = service.updateConversationTitle(
        conversationId,
        typeof body.title === 'string' ? body.title : null
      );
      sendJson(res, 200, conversation);
      return;
    }

    if (req.method === 'DELETE' && url.pathname.match(/^\/api\/conversations\/[^/]+$/)) {
      location = 'route:/api/conversations/:id';
      const conversationId = url.pathname.split('/')[3] ?? '';
      service.deleteConversation(conversationId);
      sendNoContent(res, {
        'access-control-allow-origin': '*',
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/conversations\/[^/]+\/messages$/)) {
      location = 'route:/api/conversations/:id/messages';
      const conversationId = url.pathname.split('/')[3] ?? '';
      const body = await readJson(req);
      const task = await service.submitUserMessage(conversationId, String(body.content ?? ''), {
        browserConfig: parseBrowserConfig(body.browserConfig as JsonBody),
        plannerModel: resolveRequestModel(body.plannerModel, process.env.AUTO_BROWSER_PLANNER_MODEL ?? ''),
        modelTier: resolveRequestModel(body.modelTier, process.env.AUTO_BROWSER_MODEL_TIER ?? ''),
        context: String(body.context ?? ''),
      });
      sendJson(res, 201, task);
      return;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/approve$/)) {
      location = 'route:/api/tasks/:id/approve';
      const taskId = url.pathname.split('/')[3] ?? '';
      const body = await readJson(req);
      const abortController = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });
      const task = await service.approveTask(taskId, {
        executorModel: resolveRequestModel(body.executorModel, process.env.AUTO_BROWSER_EXECUTOR_MODEL ?? ''),
        modelTier: resolveRequestModel(body.modelTier, process.env.AUTO_BROWSER_MODEL_TIER ?? ''),
        signal: abortController.signal,
      });
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/run$/)) {
      location = 'route:/api/tasks/:id/run';
      const taskId = url.pathname.split('/')[3] ?? '';
      const body = await readJson(req);
      const task = await service.executeTaskAsync(taskId, {
        executorModel: resolveRequestModel(body.executorModel, process.env.AUTO_BROWSER_EXECUTOR_MODEL ?? ''),
        modelTier: resolveRequestModel(body.modelTier, process.env.AUTO_BROWSER_MODEL_TIER ?? ''),
      });
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/approve-extension$/)) {
      location = 'route:/api/tasks/:id/approve-extension';
      const taskId = url.pathname.split('/')[3] ?? '';
      const body = await readJson(req);
      const task = await service.approveExtensionTask(taskId, {
        executorModel: resolveRequestModel(body.executorModel, process.env.AUTO_BROWSER_EXECUTOR_MODEL ?? ''),
        modelTier: resolveRequestModel(body.modelTier, process.env.AUTO_BROWSER_MODEL_TIER ?? ''),
      });
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/decide$/)) {
      location = 'route:/api/tasks/:id/decide';
      const taskId = url.pathname.split('/')[3] ?? '';
      const body = await readJson(req);
      const action = await service.decideAction(
        taskId,
        (body.observation ?? {}) as PageObservation,
        Array.isArray(body.history) ? (body.history as Array<Record<string, unknown>>) : []
      );
      sendJson(res, 200, action as ExecutorAction);
      return;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/report$/)) {
      location = 'route:/api/tasks/:id/report';
      const taskId = url.pathname.split('/')[3] ?? '';
      const body = await readJson(req);
      const task = service.reportTaskProgress(taskId, body as unknown as ExtensionExecutionReport);
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/handoff$/)) {
      location = 'route:/api/tasks/:id/handoff';
      const taskId = url.pathname.split('/')[3] ?? '';
      const body = await readJson(req);
      const task = service.enterHandoff(taskId, String(body.source ?? 'unknown'));
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/resume$/)) {
      location = 'route:/api/tasks/:id/resume';
      const taskId = url.pathname.split('/')[3] ?? '';
      const body = await readJson(req);
      const task = await service.resumeTask(taskId, {
        plannerModel: resolveRequestModel(body.plannerModel, process.env.AUTO_BROWSER_PLANNER_MODEL ?? ''),
        modelTier: resolveRequestModel(body.modelTier, process.env.AUTO_BROWSER_MODEL_TIER ?? ''),
      });
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/tasks\/[^/]+\/cancel$/)) {
      location = 'route:/api/tasks/:id/cancel';
      const taskId = url.pathname.split('/')[3] ?? '';
      const task = await service.cancelTask(taskId);
      sendJson(res, 200, task);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/force-clear-active') {
      location = 'route:/api/force-clear-active';
      const cleared = service.clearActiveTask();
      sendJson(res, 200, { cleared: cleared ?? null });
      return;
    }

    if (req.method === 'OPTIONS') {
      location = 'route:OPTIONS';
      sendNoContent(res, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return;
    }

    location = `route:${url.pathname}`;
    sendJson(res, 404, toErrorPayload(new Error('Not found'), serverContext(location)));
  } catch (error) {
    const statusCode = getHttpErrorStatus(error);
    logger.error('http.request.error', {
      method: req.method,
      pathname: url.pathname,
      statusCode,
      location,
      error: getErrorProblem(error),
    });
    sendJson(res, statusCode, toErrorPayload(error, serverContext(location)));
  }
});

const port = Number(process.env.AUTO_BROWSER_CONTROL_PORT ?? '4317');
server.listen(port, '127.0.0.1', () => {
  logger.info('server.start', {
    host: '127.0.0.1',
    port,
    mode: process.env.NODE_ENV ?? 'development',
    llmRouterBaseUrlConfigured: Boolean(process.env.AUTO_BROWSER_LLM_ROUTER_BASE_URL?.trim()),
  });
  console.log(`Auto Browser control service listening on http://127.0.0.1:${port}`);
});
