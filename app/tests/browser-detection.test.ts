import { describe, expect, it } from 'vitest';
import { detectBrowserInstanceCandidates } from '../src/workbench/browser-detection';
import type { BrowserInstanceRecord } from '../src/workbench/types';

describe('detectBrowserInstanceCandidates', () => {
  it('returns a system browser candidate from platform defaults', () => {
    const candidates = detectBrowserInstanceCandidates([], {
      platform: 'linux',
      env: {},
      exists: (path) => path === '/usr/bin/google-chrome',
    });

    expect(candidates[0]).toMatchObject({
      mode: 'system',
      browserFamily: 'chrome',
      executablePath: '/usr/bin/google-chrome',
      detected: true,
    });
  });

  it('falls back to managed Chromium when no system browser is found', () => {
    const candidates = detectBrowserInstanceCandidates([], {
      platform: 'linux',
      env: {},
      exists: () => false,
    });

    expect(candidates[0]).toMatchObject({
      mode: 'managed',
      browserFamily: 'chromium',
      executablePath: '',
      detected: false,
    });
  });

  it('marks an equivalent existing instance as already imported', () => {
    const existing = makeInstance({
      id: 'instance-1',
      mode: 'system',
      browserFamily: 'chrome',
      executablePath: '/usr/bin/google-chrome',
    });

    const candidates = detectBrowserInstanceCandidates([existing], {
      platform: 'linux',
      env: {},
      exists: (path) => path === '/usr/bin/google-chrome',
    });

    expect(candidates[0].importedInstanceId).toBe('instance-1');
  });
});

function makeInstance(patch: Partial<BrowserInstanceRecord>): BrowserInstanceRecord {
  return {
    id: 'instance',
    name: 'Browser',
    status: 'stopped',
    startUrl: 'https://example.com',
    mode: 'managed',
    browserFamily: 'chromium',
    executablePath: '',
    profilePath: null,
    cookieJarId: null,
    viewport: { width: 1440, height: 900 },
    headless: false,
    createdAt: '2026-04-09T12:00:00.000Z',
    updatedAt: '2026-04-09T12:00:00.000Z',
    ...patch,
  };
}
