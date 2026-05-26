import { existsSync } from 'node:fs';
import type { BrowserRuntimeMode } from './browser-registry.js';

export type BrowserRuntimeFamily = 'chromium' | 'chrome' | 'edge' | 'cloak';

export interface BrowserRuntimeDefaults {
  platform: NodeJS.Platform;
  mode: BrowserRuntimeMode;
  browserFamily: BrowserRuntimeFamily;
  executablePath: string;
  profilePath: string;
  detected: boolean;
  message: string;
}

interface BrowserCandidate {
  browserFamily: BrowserRuntimeFamily;
  executablePath: string;
}

export interface BrowserRuntimeDetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

const DEFAULT_PROFILE_PATH = '';

function windowsPath(root: string | undefined, suffix: string): string | null {
  if (!root) {
    return null;
  }
  return `${root}\\${suffix}`;
}

function getPlatformCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): BrowserCandidate[] {
  if (platform === 'darwin') {
    return [
      {
        browserFamily: 'chrome',
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      {
        browserFamily: 'edge',
        executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      },
    ];
  }

  if (platform === 'win32') {
    return [
      windowsPath(env.ProgramFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      windowsPath(env['ProgramFiles(x86)'], 'Google\\Chrome\\Application\\chrome.exe'),
      windowsPath(env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
      windowsPath(env.ProgramFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      windowsPath(env['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'),
      windowsPath(env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ].flatMap((executablePath) => {
      if (!executablePath) {
        return [];
      }
      return [
        {
          browserFamily: executablePath.includes('Microsoft\\Edge') ? 'edge' : 'chrome',
          executablePath,
        },
      ];
    });
  }

  return [
    { browserFamily: 'chrome', executablePath: '/usr/bin/google-chrome' },
    { browserFamily: 'chrome', executablePath: '/usr/bin/google-chrome-stable' },
    { browserFamily: 'chromium', executablePath: '/snap/bin/chromium' },
    { browserFamily: 'edge', executablePath: '/usr/bin/microsoft-edge' },
    { browserFamily: 'edge', executablePath: '/usr/bin/microsoft-edge-stable' },
  ];
}

export function detectBrowserRuntimeDefaults(
  options: BrowserRuntimeDetectionOptions = {}
): BrowserRuntimeDefaults {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const hasExplicitExecutableSetting =
    Object.prototype.hasOwnProperty.call(env, 'AUTO_BROWSER_EXECUTABLE_PATH') ||
    Object.prototype.hasOwnProperty.call(env, 'AGENT_BROWSER_EXECUTABLE_PATH');
  const configuredExecutablePath =
    env.AUTO_BROWSER_EXECUTABLE_PATH?.trim() || env.AGENT_BROWSER_EXECUTABLE_PATH?.trim() || '';
  if (configuredExecutablePath && !exists(configuredExecutablePath)) {
    return {
      platform,
      mode: 'system',
      browserFamily: 'chrome',
      executablePath: configuredExecutablePath,
      profilePath: DEFAULT_PROFILE_PATH,
      detected: false,
      message: `Configured browser executable was not found at ${configuredExecutablePath}. Fix AUTO_BROWSER_EXECUTABLE_PATH or provide a valid Chrome path.`,
    };
  }

  const candidates = [
    ...(configuredExecutablePath
      ? [{ browserFamily: 'chrome' as const, executablePath: configuredExecutablePath }]
      : []),
    ...(hasExplicitExecutableSetting ? [] : getPlatformCandidates(platform, env)),
  ];

  const detected = candidates.find((candidate) => exists(candidate.executablePath));
  if (detected) {
    return {
      platform,
      mode: 'system',
      browserFamily: detected.browserFamily,
      executablePath: detected.executablePath,
      profilePath: DEFAULT_PROFILE_PATH,
      detected: true,
      message: `Detected browser executable at ${detected.executablePath}. Browser sessions are ephemeral by default; pass an explicit profile path to persist state.`,
    };
  }

  return {
    platform,
    mode: 'managed',
    browserFamily: 'chromium',
    executablePath: '',
    profilePath: DEFAULT_PROFILE_PATH,
    detected: false,
    message:
      'Local Chrome was not detected. Chromium will be downloaded automatically on first run. Browser sessions are ephemeral by default; pass an explicit profile path to persist state.',
  };
}
