import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';

export type BrowserFamily = 'chromium' | 'chrome' | 'edge' | 'cloak';
export type BrowserLaunchMode = 'auto' | 'headless' | 'headed';
export type BrowserRuntimeMode = 'system' | 'managed';

export interface BrowserRuntimeConfig {
  mode: BrowserRuntimeMode;
  browserFamily: BrowserFamily;
  executablePath: string;
  profilePath: string;
  cookiesPath: string;
  credentialsPath: string;
  launchMode: BrowserLaunchMode;
  extensionEnabled: boolean;
  previewEnabled: boolean;
  cdpUrl: string;
  cloakHumanize: boolean;
  cloakFingerprintSeed: string;
  cloakTimezone: string;
  cloakLocale: string;
}

export type ProfileValidationResult =
  | {
      ok: true;
      normalizedPath: string;
    }
  | {
      ok: false;
      reason: 'missing_profile' | 'invalid_profile' | 'profile_locked';
      message: string;
    };

const CHROMIUM_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];

export class BrowserRegistry {
  validateExecutablePath(mode: BrowserRuntimeMode, executablePath: string): void {
    if (mode === 'managed') {
      return;
    }

    if (!existsSync(executablePath)) {
      throw new Error(`Browser executable not found at ${executablePath}`);
    }

    const stats = statSync(executablePath);
    if (!stats.isFile()) {
      throw new Error(`Browser executable path must point to a file: ${executablePath}`);
    }
  }

  validateProfilePath(profilePath: string): ProfileValidationResult {
    if (!profilePath.trim()) {
      return {
        ok: true,
        normalizedPath: '',
      };
    }

    if (!existsSync(profilePath)) {
      mkdirSync(profilePath, { recursive: true });
    }

    const stats = statSync(profilePath);
    if (!stats.isDirectory()) {
      return {
        ok: false,
        reason: 'invalid_profile',
        message: `Browser profile path must be a directory: ${profilePath}`,
      };
    }

    for (const fileName of CHROMIUM_LOCK_FILES) {
      const lockPath = `${profilePath}/${fileName}`;
      if (existsSync(lockPath)) {
        return {
          ok: false,
          reason: 'profile_locked',
          message: `Browser profile is currently in use. Please close the browser using ${profilePath} before starting a task.`,
        };
      }
    }

    return {
      ok: true,
      normalizedPath: realpathSync(profilePath),
    };
  }
}
