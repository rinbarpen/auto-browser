import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createServerLogger } from '../src/workbench/server-logger';

describe('workbench server logger', () => {
  it('writes JSONL and redacts sensitive fields', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'workbench-logger-'));
    const consoleWriter = vi.fn();
    const logger = createServerLogger({
      service: 'workbench-test',
      fileName: 'workbench-test.log',
      logDir,
      consoleWriter,
    });

    logger.info('settings.updated', {
      apiKey: 'sk-secret',
      authorization: 'Bearer secret',
      cookie: 'sid=secret',
      password: 'secret-password',
      model: 'openai/gpt-5.4',
    });

    const raw = readFileSync(join(logDir, 'workbench-test.log'), 'utf8');
    expect(raw).not.toContain('sk-secret');
    expect(raw).not.toContain('Bearer secret');
    expect(raw).not.toContain('sid=secret');
    expect(raw).not.toContain('secret-password');
    expect(JSON.parse(raw)).toMatchObject({
      service: 'workbench-test',
      event: 'settings.updated',
      apiKey: '[redacted]',
      authorization: '[redacted]',
      cookie: '[redacted]',
      password: '[redacted]',
      model: 'openai/gpt-5.4',
    });
    expect(consoleWriter).toHaveBeenCalledWith(expect.stringContaining('settings.updated'), 'info');
  });
});
