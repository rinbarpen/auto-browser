import { describe, expect, it } from 'vitest';
import { detectBrowserRuntimeDefaults } from './browser-runtime-defaults.js';

describe('detectBrowserRuntimeDefaults', () => {
  it('uses AUTO_BROWSER_EXECUTABLE_PATH before the legacy AGENT_BROWSER_EXECUTABLE_PATH', () => {
    const defaults = detectBrowserRuntimeDefaults({
      platform: 'linux',
      env: {
        AUTO_BROWSER_EXECUTABLE_PATH: '/custom/chrome',
        AGENT_BROWSER_EXECUTABLE_PATH: '/legacy/chrome',
      },
      exists: (path) => path === '/custom/chrome' || path === '/legacy/chrome',
    });

    expect(defaults.detected).toBe(true);
    expect(defaults.mode).toBe('system');
    expect(defaults.browserFamily).toBe('chrome');
    expect(defaults.executablePath).toBe('/custom/chrome');
  });

  it('keeps an explicitly configured but invalid executable path instead of falling back', () => {
    const defaults = detectBrowserRuntimeDefaults({
      platform: 'linux',
      env: { AUTO_BROWSER_EXECUTABLE_PATH: '/bad/chrome' },
      exists: () => false,
    });

    expect(defaults.detected).toBe(false);
    expect(defaults.mode).toBe('system');
    expect(defaults.executablePath).toBe('/bad/chrome');
    expect(defaults.message).toContain('Configured browser executable was not found');
  });

  it('selects the first available Linux Chrome candidate', () => {
    const defaults = detectBrowserRuntimeDefaults({
      platform: 'linux',
      env: {},
      exists: (path) => path === '/usr/bin/google-chrome-stable' || path === '/snap/bin/chromium',
    });

    expect(defaults.detected).toBe(true);
    expect(defaults.mode).toBe('system');
    expect(defaults.browserFamily).toBe('chrome');
    expect(defaults.executablePath).toBe('/usr/bin/google-chrome-stable');
  });

  it('selects the macOS Chrome candidate when present', () => {
    const defaults = detectBrowserRuntimeDefaults({
      platform: 'darwin',
      env: {},
      exists: (path) =>
        path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });

    expect(defaults.detected).toBe(true);
    expect(defaults.mode).toBe('system');
    expect(defaults.browserFamily).toBe('chrome');
    expect(defaults.executablePath).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('selects system Chromium when present', () => {
    const defaults = detectBrowserRuntimeDefaults({
      platform: 'linux',
      env: {},
      exists: (path) => path === '/snap/bin/chromium',
    });

    expect(defaults.detected).toBe(true);
    expect(defaults.mode).toBe('system');
    expect(defaults.browserFamily).toBe('chromium');
    expect(defaults.executablePath).toBe('/snap/bin/chromium');
  });

  it('selects Linux Edge after Chrome and Chromium candidates', () => {
    const defaults = detectBrowserRuntimeDefaults({
      platform: 'linux',
      env: {},
      exists: (path) => path === '/usr/bin/microsoft-edge-stable',
    });

    expect(defaults.detected).toBe(true);
    expect(defaults.mode).toBe('system');
    expect(defaults.browserFamily).toBe('edge');
    expect(defaults.executablePath).toBe('/usr/bin/microsoft-edge-stable');
  });

  it('selects Windows Edge when Chrome is not present', () => {
    const defaults = detectBrowserRuntimeDefaults({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: (path) => path === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    });

    expect(defaults.detected).toBe(true);
    expect(defaults.mode).toBe('system');
    expect(defaults.browserFamily).toBe('edge');
    expect(defaults.executablePath).toBe('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  });

  it('returns managed mode when no candidate exists', () => {
    const defaults = detectBrowserRuntimeDefaults({
      platform: 'linux',
      env: {},
      exists: () => false,
    });

    expect(defaults.detected).toBe(false);
    expect(defaults.mode).toBe('managed');
    expect(defaults.browserFamily).toBe('chromium');
    expect(defaults.executablePath).toBe('');
    expect(defaults.message).toContain('downloaded automatically on first run');
  });

  it('treats an explicitly empty executable path as opting out of system autodetection', () => {
    const defaults = detectBrowserRuntimeDefaults({
      platform: 'linux',
      env: { AUTO_BROWSER_EXECUTABLE_PATH: '', AGENT_BROWSER_EXECUTABLE_PATH: '' },
      exists: (path) => path === '/usr/bin/google-chrome-stable',
    });

    expect(defaults.detected).toBe(false);
    expect(defaults.mode).toBe('managed');
    expect(defaults.browserFamily).toBe('chromium');
    expect(defaults.executablePath).toBe('');
  });
});
