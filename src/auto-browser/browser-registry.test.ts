import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRegistry } from './browser-registry.js';

describe('BrowserRegistry', () => {
  const tempPaths: string[] = [];

  afterEach(() => {
    while (tempPaths.length > 0) {
      const dir = tempPaths.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('rejects a profile when a known Chromium lock file exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-browser-profile-'));
    tempPaths.push(root);
    const profilePath = join(root, 'Default');
    mkdirSync(profilePath, { recursive: true });
    writeFileSync(join(profilePath, 'SingletonLock'), 'busy');

    const registry = new BrowserRegistry();
    const result = registry.validateProfilePath(profilePath);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected a locked profile to be rejected');
    }
    expect(result.reason).toBe('profile_locked');
    expect(result.message).toContain('close the browser');
  });

  it('accepts an existing profile with no lock files', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-browser-profile-'));
    tempPaths.push(root);
    const profilePath = join(root, 'Profile 1');
    mkdirSync(profilePath, { recursive: true });

    const registry = new BrowserRegistry();
    const result = registry.validateProfilePath(profilePath);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`Expected profile validation to pass, got ${result.message}`);
    }
    expect(result.normalizedPath).toBe(profilePath);
  });

  it('creates a missing profile directory before validation succeeds', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-browser-profile-root-'));
    tempPaths.push(root);
    const profilePath = join(root, 'New Profile');

    const registry = new BrowserRegistry();
    const result = registry.validateProfilePath(profilePath);

    expect(result.ok).toBe(true);
    expect(existsSync(profilePath)).toBe(true);
  });

  it('accepts an empty profile path for ephemeral sessions', () => {
    const registry = new BrowserRegistry();
    const result = registry.validateProfilePath('');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`Expected empty profile path validation to pass, got ${result.message}`);
    }
    expect(result.normalizedPath).toBe('');
  });

  it('skips executable validation in managed mode', () => {
    const registry = new BrowserRegistry();

    expect(() => {
      registry.validateExecutablePath('managed', '');
    }).not.toThrow();
  });

  it('still validates executable paths in system mode', () => {
    const registry = new BrowserRegistry();

    expect(() => {
      registry.validateExecutablePath('system', '/definitely/missing/browser');
    }).toThrow('Browser executable not found');
  });
});
