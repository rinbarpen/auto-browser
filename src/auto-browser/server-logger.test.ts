import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createServerLogger } from './server-logger.js';

describe('server logger', () => {
  it('writes JSONL to the configured log directory and mirrors to the console writer', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'auto-browser-logger-'));
    const consoleWriter = vi.fn();
    const logger = createServerLogger({
      service: 'test-service',
      fileName: 'test.log',
      logDir,
      consoleWriter,
    });

    logger.info('request.finished', { method: 'GET', pathname: '/api/state', statusCode: 200 });

    const lines = readFileSync(join(logDir, 'test.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'info',
      service: 'test-service',
      event: 'request.finished',
      method: 'GET',
      pathname: '/api/state',
      statusCode: 200,
    });
    expect(consoleWriter).toHaveBeenCalledWith(expect.stringContaining('request.finished'), 'info');
  });

  it('redacts sensitive fields before writing logs', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'auto-browser-logger-redact-'));
    const logger = createServerLogger({
      service: 'test-service',
      fileName: 'redact.log',
      logDir,
      consoleWriter: vi.fn(),
    });

    logger.error('secret.test', {
      apiKey: 'sk-secret',
      headers: {
        authorization: 'Bearer secret',
        cookie: 'sid=secret',
      },
      nested: { password: 'secret-password' },
    });

    const raw = readFileSync(join(logDir, 'redact.log'), 'utf8');
    expect(raw).not.toContain('sk-secret');
    expect(raw).not.toContain('Bearer secret');
    expect(raw).not.toContain('sid=secret');
    expect(raw).not.toContain('secret-password');
    expect(JSON.parse(raw)).toMatchObject({
      apiKey: '[redacted]',
      headers: {
        authorization: '[redacted]',
        cookie: '[redacted]',
      },
      nested: { password: '[redacted]' },
    });
  });
});
