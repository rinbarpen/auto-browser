import { describe, expect, it, vi } from 'vitest';
import { createResourceApiServer } from '../src/server/api';

describe('resource API logging', () => {
  it('logs crawl start and asynchronous crawl failures without logging request bodies', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const app = await createResourceApiServer({
      logger,
      crawlRunner: async () => {
        throw new Error('crawl exploded');
      },
    });

    const response = await app.inject({ method: 'POST', url: '/api/crawl', payload: { apiKey: 'sk-secret' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.statusCode).toBe(200);
    expect(logger.info).toHaveBeenCalledWith('crawl.start', { headless: true });
    expect(logger.error).toHaveBeenCalledWith('crawl.failed', { error: 'crawl exploded' });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('sk-secret');
    await app.close();
  });
});
