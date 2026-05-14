import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadCredentials, saveCredentials, matchCredentials, detectLoginForm } from './credential-store.js';

const HOME = os.homedir();
const CRED_PATH = path.join(HOME, '.auto-browser', 'credentials.json');

describe('credential-store', () => {
  const originalCreds = loadCredentials();

  beforeEach(() => {
    saveCredentials({ sites: {} });
  });

  afterEach(() => {
    saveCredentials(originalCreds);
  });

  describe('loadCredentials / saveCredentials', () => {
    it('returns empty file structure when no file exists', () => {
      fs.rmSync(CRED_PATH, { force: true });
      const result = loadCredentials();
      expect(result).toEqual({ sites: {} });
    });

    it('round-trips credentials correctly', () => {
      const testCreds = { sites: { 'test.com': { username: 'u', password: 'p' } } };
      saveCredentials(testCreds);
      const loaded = loadCredentials();
      expect(loaded).toEqual(testCreds);
    });

    it('handles corrupt JSON gracefully', () => {
      fs.mkdirSync(path.dirname(CRED_PATH), { recursive: true });
      fs.writeFileSync(CRED_PATH, '{not json}', 'utf-8');
      const result = loadCredentials();
      expect(result).toEqual({ sites: {} });
    });
  });

  describe('matchCredentials', () => {
    const creds = {
      sites: {
        'weibo.com': { username: 'weibo_user', password: 'weibo_pass' },
        'example.com': { username: 'user@example.com', password: 'pass123' },
        'mail.example.com': { username: 'mail_user', password: 'mail_pass' },
      },
    };

    it('matches exact hostname', () => {
      const result = matchCredentials('https://weibo.com/login', creds);
      expect(result).toEqual({ username: 'weibo_user', password: 'weibo_pass' });
    });

    it('strips www. prefix', () => {
      const result = matchCredentials('https://www.example.com/page', creds);
      expect(result).toEqual({ username: 'user@example.com', password: 'pass123' });
    });

    it('matches subdomain', () => {
      const result = matchCredentials('https://mail.example.com/', creds);
      expect(result).toEqual({ username: 'mail_user', password: 'mail_pass' });
    });

    it('returns null for unknown host', () => {
      const result = matchCredentials('https://google.com', creds);
      expect(result).toBeNull();
    });

    it('returns null for empty URL', () => {
      const result = matchCredentials('', creds);
      expect(result).toBeNull();
    });

    it('ignores path/query in URL', () => {
      const result = matchCredentials('https://weibo.com/some/path?q=1', creds);
      expect(result).toEqual({ username: 'weibo_user', password: 'weibo_pass' });
    });
  });

  describe('detectLoginForm', () => {
    it('detects username+password textbox refs', () => {
      const refs: any[] = [
        { ref: 'e1', role: 'textbox', name: 'username' },
        { ref: 'e2', role: 'textbox', name: 'password' },
        { ref: 'e3', role: 'button', name: 'login' },
      ];
      const result = detectLoginForm(refs);
      expect(result.detected).toBe(true);
      expect(result.usernameRef).toBe('e1');
      expect(result.passwordRef).toBe('e2');
      expect(result.submitRef).toBe('e3');
    });

    it('detects form with user/email field', () => {
      const refs: any[] = [
        { ref: 'e1', role: 'textbox', name: 'email' },
        { ref: 'e2', role: 'textbox', name: 'password' },
      ];
      const result = detectLoginForm(refs);
      expect(result.detected).toBe(true);
      expect(result.usernameRef).toBe('e1');
      expect(result.submitRef).toBeUndefined();
    });

    it('detects searchbox role inputs', () => {
      const refs: any[] = [
        { ref: 'e1', role: 'searchbox', name: 'login_name' },
        { ref: 'e2', role: 'searchbox', name: 'password' },
      ];
      const result = detectLoginForm(refs);
      expect(result.detected).toBe(true);
      expect(result.usernameRef).toBe('e1');
    });

    it('returns detected:false when no password field', () => {
      const refs: any[] = [
        { ref: 'e1', role: 'textbox', name: 'username' },
        { ref: 'e2', role: 'button', name: 'submit' },
      ];
      const result = detectLoginForm(refs);
      expect(result.detected).toBe(false);
    });

    it('handles Chinese keyword field names', () => {
      const refs: any[] = [
        { ref: 'e1', role: 'textbox', name: '用户名' },
        { ref: 'e2', role: 'textbox', name: '密码' },
        { ref: 'e3', role: 'button', name: '登录' },
      ];
      const result = detectLoginForm(refs);
      expect(result.detected).toBe(true);
      expect(result.usernameRef).toBe('e1');
      expect(result.passwordRef).toBe('e2');
    });

    it('handles refs without role field gracefully', () => {
      const refs: any[] = [
        { ref: 'e1', name: 'textbox' },
        { ref: 'e2', name: 'button' },
      ];
      const result = detectLoginForm(refs);
      expect(result.detected).toBe(false);
    });

    it('handles empty refs array', () => {
      const result = detectLoginForm([]);
      expect(result.detected).toBe(false);
    });

    it('handles record-shaped refs', () => {
      const refs = { e1: { role: 'textbox', name: 'username' }, e2: { role: 'textbox', name: 'password' } };
      const result = detectLoginForm(refs as any);
      expect(result.detected).toBe(true);
      expect(result.usernameRef).toBe('e1');
    });
  });
});
