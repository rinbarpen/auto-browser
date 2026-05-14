import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserInstaller } from './browser-installer.js';
import {
  BrowserExecutionDriver,
  parseSearchGoal,
  type ManagedBrowser,
} from './control-service.js';
import type { BrowserRuntimeConfig, Task } from './control-service.js';

class FakeBrowser implements ManagedBrowser {
  readonly launchCalls: unknown[] = [];
  readonly gotoCalls: unknown[] = [];
  closed = false;

  async launch(options: unknown): Promise<void> {
    this.launchCalls.push(options);
  }

  getPage() {
    return {
      goto: async (url: string, options: unknown) => {
        this.gotoCalls.push({ url, options });
      },
      title: async () => 'BIG BROTHER - Google Search',
      url: () => 'https://www.google.com/search?q=the%20BIG%20BROTHER',
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const browserConfig: BrowserRuntimeConfig = {
  mode: 'system',
  browserFamily: 'chromium',
  executablePath: process.execPath,
  profilePath: mkdtempSync(join(tmpdir(), 'auto-browser-execution-profile-')),
  cookiesPath: '',
  credentialsPath: '',
  launchMode: 'auto',
  extensionEnabled: false,
  previewEnabled: true,
  cdpUrl: '',
};

function makeTask(goal: string): Task {
  return {
    id: 'task-search',
    conversationId: 'conv-search',
    goal,
    context: null,
    status: 'running',
    planDraft: {
      summary: `Plan for ${goal}`,
      steps: [
        { id: 'plan-open', title: 'Open search results', intent: 'Navigate to the search page' },
      ],
    },
    browserConfig,
    currentStepIndex: 0,
    resultSummary: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handoffSource: null,
    executionSource: 'service',
  };
}

const ORIGINAL_PROXY_ENV = {
  ALL_PROXY: process.env.ALL_PROXY,
  all_proxy: process.env.all_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
  http_proxy: process.env.http_proxy,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
  AGENT_BROWSER_PROXY: process.env.AGENT_BROWSER_PROXY,
  AGENT_BROWSER_PROXY_BYPASS: process.env.AGENT_BROWSER_PROXY_BYPASS,
};

describe('parseSearchGoal', () => {
  it('extracts the query from a direct search request', () => {
    expect(parseSearchGoal('search the BIG BROTHER')).toBe('the BIG BROTHER');
  });

  it('extracts the query from a search-for request', () => {
    expect(parseSearchGoal('search for the BIG BROTHER')).toBe('the BIG BROTHER');
  });

  it('rejects non-search goals', () => {
    expect(parseSearchGoal('open my inbox')).toBeNull();
  });
});

describe('BrowserExecutionDriver', () => {
  beforeEach(() => {
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    delete process.env.AGENT_BROWSER_PROXY;
    delete process.env.AGENT_BROWSER_PROXY_BYPASS;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_PROXY_ENV)) {
      if (typeof value === 'string') {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  });

  it('launches a headed browser in auto mode when a display server is present', async () => {
    const browser = new FakeBrowser();
    const driver = new BrowserExecutionDriver({
      browserFactory: async () => browser,
      hasDisplayServer: () => true,
    });

    const result = await driver.execute('task-search', makeTask('search the BIG BROTHER'));

    expect(browser.launchCalls).toEqual([
      {
        id: 'task-search',
        action: 'launch',
        headless: false,
        browser: 'chromium',
        executablePath: process.execPath,
        profile: browserConfig.profilePath,
        proxy: undefined,
      },
    ]);
    expect(browser.gotoCalls).toEqual([
      {
        url: 'https://www.google.com/search?q=the%20BIG%20BROTHER',
        options: { waitUntil: 'domcontentloaded' },
      },
    ]);
    expect(result.finalMessage).toContain('BIG BROTHER - Google Search');
    expect(result.finalMessage).toContain('https://www.google.com/search?q=the%20BIG%20BROTHER');
    expect(result.steps).toEqual([{ stepId: 'plan-open', status: 'completed' }]);
    expect(browser.closed).toBe(false);
  });

  it('launches headless in auto mode when no display server is present', async () => {
    const browser = new FakeBrowser();
    const driver = new BrowserExecutionDriver({
      browserFactory: async () => browser,
      hasDisplayServer: () => false,
    });

    await driver.execute('task-search', makeTask('search the BIG BROTHER'));

    expect(browser.launchCalls).toEqual([
      expect.objectContaining({
        headless: true,
      }),
    ]);
  });

  it('creates a temporary profile when none is provided', async () => {
    const browser = new FakeBrowser();
    const driver = new BrowserExecutionDriver({
      browserFactory: async () => browser,
      hasDisplayServer: () => false,
    });

    await driver.execute('task-search', {
      ...makeTask('search the BIG BROTHER'),
      browserConfig: {
        ...browserConfig,
        profilePath: '',
      },
    });

    expect(browser.launchCalls).toEqual([
      expect.objectContaining({
        profile: expect.stringContaining(`${tmpdir()}/auto-browser-profile-`),
      }),
    ]);
  });

  it('inherits proxy settings from standard environment variables', async () => {
    process.env.ALL_PROXY = 'http://127.0.0.1:15732';
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1';

    const browser = new FakeBrowser();
    const driver = new BrowserExecutionDriver({
      browserFactory: async () => browser,
      hasDisplayServer: () => false,
    });

    await driver.execute('task-search', makeTask('search the BIG BROTHER'));

    expect(browser.launchCalls).toEqual([
      expect.objectContaining({
        proxy: {
          server: 'http://127.0.0.1:15732',
          bypass: 'localhost,127.0.0.1,::1',
        },
      }),
    ]);
  });

  it('fails clearly for explicit headed mode when no display server is present', async () => {
    const driver = new BrowserExecutionDriver({
      browserFactory: async () => new FakeBrowser(),
      hasDisplayServer: () => false,
    });

    await expect(
      driver.execute('task-search', {
        ...makeTask('search the BIG BROTHER'),
        browserConfig: {
          ...browserConfig,
          launchMode: 'headed',
        },
      })
    ).rejects.toThrow('Headed browser execution requires DISPLAY or WAYLAND_DISPLAY');
  });

  it('fails clearly for unsupported task goals', async () => {
    const driver = new BrowserExecutionDriver({
      browserFactory: async () => new FakeBrowser(),
      hasDisplayServer: () => true,
    });

    await expect(driver.execute('task-open', makeTask('open my inbox'))).rejects.toThrow(
      'Only search tasks are supported'
    );
  });

  it('does not invoke the installer for system mode launches', async () => {
    const browser = new FakeBrowser();
    const installer = new BrowserInstaller({
      installChromium: async () => {
        throw new Error('installer should not run');
      },
    });
    const driver = new BrowserExecutionDriver({
      browserFactory: async () => browser,
      browserInstaller: installer,
      hasDisplayServer: () => true,
    });

    await driver.execute('task-search', makeTask('search the BIG BROTHER'));

    expect(browser.launchCalls).toHaveLength(1);
  });
});
