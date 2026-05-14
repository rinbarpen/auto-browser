import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkbenchRuntime } from '../src/workbench/runtime';
import type { WorkbenchStore } from '../src/workbench/types';

describe('WorkbenchRuntime browser launch options', () => {
  it('passes executablePath for system instances', async () => {
    const runtime = new WorkbenchRuntime(createStoreStub(), path.join(os.tmpdir(), 'workbench-launch-tests'));
    const browser = createBrowserStub();

    await (runtime as any).launchBrowser(browser, {
      id: 'instance-1',
      startUrl: 'https://example.com',
      profilePath: null,
      cookieJarId: null,
      viewport: { width: 1440, height: 900 },
      headless: false,
      mode: 'system',
      executablePath: '/usr/bin/google-chrome',
    });

    expect(browser.launchOptions).toMatchObject({ executablePath: '/usr/bin/google-chrome' });
  });

  it('omits executablePath for managed instances', async () => {
    const runtime = new WorkbenchRuntime(createStoreStub(), path.join(os.tmpdir(), 'workbench-launch-tests'));
    const browser = createBrowserStub();

    await (runtime as any).launchBrowser(browser, {
      id: 'instance-1',
      startUrl: 'https://example.com',
      profilePath: null,
      cookieJarId: null,
      viewport: { width: 1440, height: 900 },
      headless: false,
      mode: 'managed',
      executablePath: '/usr/bin/google-chrome',
    });

    expect(browser.launchOptions).not.toHaveProperty('executablePath');
  });
});

function createBrowserStub() {
  return {
    launchOptions: null as unknown,
    async launch(options: unknown) {
      this.launchOptions = options;
    },
    getPage() {
      return {
        async goto() {},
      };
    },
  };
}

function createStoreStub(): WorkbenchStore {
  return {
    saveFlow() {},
    listFlows() {
      return [];
    },
    getFlow() {
      return null;
    },
    createRun() {},
    updateRun() {},
    upsertRunStep() {},
    appendRunEvent() {},
    getRunWithDetails() {
      return null;
    },
    listBrowserInstances() {
      return [];
    },
    getBrowserInstance() {
      return null;
    },
    saveBrowserInstance() {},
    updateBrowserInstance() {},
    deleteBrowserInstance() {},
    listCookieJars() {
      return [];
    },
    getCookieJar() {
      return null;
    },
    saveCookieJar() {},
    replaceCookies() {},
    deleteCookieJar() { return true; },
    listLlmSettings() {
      return [];
    },
    getLlmSettings() {
      return null;
    },
    upsertLlmSettings() {},
    listLlmProviderPresets() {
      return [];
    },
    createLlmProviderPreset() {
      throw new Error('not implemented');
    },
    updateLlmProviderPreset() {
      return null;
    },
    deleteLlmProviderPreset() {
      return false;
    },
    listLlmPresets() {
      return { presets: [], activePresetId: null };
    },
    createLlmPreset() {
      throw new Error('not implemented');
    },
    updateLlmPreset() {
      return null;
    },
    activateLlmPreset() {
      return null;
    },
    deleteLlmPreset() {
      return false;
    },
  };
}
