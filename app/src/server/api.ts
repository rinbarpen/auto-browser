import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAll, findById } from '../storage/db.js';
import { config } from '../config.js';
import { runCrawl, getCrawlStatus } from '../crawler/crawl.js';
import { downloadToLocal } from '../downloader/local.js';
import { saveToBaiduPan } from '../downloader/baidu.js';
import { createServerLogger, type ServerLogger } from '../workbench/server-logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultLogger = createServerLogger({
  service: 'resource-api',
  fileName: 'resource-api.log',
});
const requestStarts = new WeakMap<object, number>();

export async function createResourceApiServer(options: {
  crawlRunner?: typeof runCrawl;
  logger?: ServerLogger;
} = {}) {
  const logger = options.logger ?? defaultLogger;
  const crawlRunner = options.crawlRunner ?? runCrawl;
  const app = Fastify({ logger: true });
  app.addHook('onRequest', async (req) => {
    requestStarts.set(req, Date.now());
  });
  app.addHook('onResponse', async (req, reply) => {
    const startedAt = requestStarts.get(req) ?? Date.now();
    logger.info('http.request.finish', {
      method: req.method,
      pathname: req.url.split('?')[0],
      statusCode: reply.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  app.addHook('onError', async (req, reply, error) => {
    logger.error('http.request.error', {
      method: req.method,
      pathname: req.url.split('?')[0],
      statusCode: reply.statusCode || 500,
      error: getErrorMessage(error),
    });
  });
  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'static'),
    prefix: '/',
  });
  app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));

  app.get('/api/resources', async (req, reply) => {
    const q = req.query as { category?: string; limit?: string; offset?: string };
    const resources = findAll({
      category: q.category,
      limit: q.limit ? parseInt(q.limit, 10) : 50,
      offset: q.offset ? parseInt(q.offset, 10) : 0,
    });
    return reply.send({ resources });
  });

  app.get('/api/resources/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const resource = findById(id);
    if (!resource) return reply.status(404).send({ error: 'Not found' });
    return reply.send(resource);
  });

  app.get('/api/crawl/status', async (_req, reply) => {
    return reply.send(getCrawlStatus());
  });

  app.post('/api/crawl', async (_req, reply) => {
    const status = getCrawlStatus();
    if (status.phase !== 'idle' && status.phase !== 'done' && status.phase !== 'error') {
      return reply.status(409).send({ error: '采集任务已在运行中' });
    }
    logger.info('crawl.start', { headless: true });
    crawlRunner({ headless: true }).catch((err) => {
      app.log.error(err, 'Crawl failed');
      logger.error('crawl.failed', { error: getErrorMessage(err) });
    });
    return reply.send({ success: true, message: '采集已启动' });
  });

  app.post('/api/download/local', async (req, reply) => {
    try {
      const body = req.body as { resourceId: string; outputDir?: string };
      const outputDir = body.outputDir ?? process.env.DOWNLOAD_DIR ?? './downloads';
      const result = await downloadToLocal(body.resourceId, outputDir);
      if (result.success) {
        return reply.send({ success: true, message: `Saved to ${result.path}` });
      }
      logger.warn('download.local.failed', { resourceId: body.resourceId, error: result.error });
      return reply.status(400).send({ error: result.error });
    } catch (err) {
      logger.error('download.local.error', { error: getErrorMessage(err) });
      return reply.status(500).send({ error: String(err) });
    }
  });

  app.post('/api/download/baidu', async (req, reply) => {
    try {
      const body = req.body as { resourceId: string; targetPath?: string };
      const result = await saveToBaiduPan(body.resourceId, body.targetPath);
      if (result.success) {
        return reply.send({ success: true, message: 'Saved to Baidu Pan' });
      }
      logger.warn('download.baidu.failed', { resourceId: body.resourceId, error: result.error });
      return reply.status(400).send({ error: result.error });
    } catch (err) {
      logger.error('download.baidu.error', { error: getErrorMessage(err) });
      return reply.status(500).send({ error: String(err) });
    }
  });

  return app;
}

export async function startServer(): Promise<void> {
  const app = await createResourceApiServer();
  const port = config.server.port;
  await app.listen({ port, host: '0.0.0.0' });
  defaultLogger.info('server.start', {
    host: '0.0.0.0',
    port,
  });
  console.log(`Server at http://localhost:${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    defaultLogger.error('server.start.failed', { error: getErrorMessage(error) });
    console.error(error);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
