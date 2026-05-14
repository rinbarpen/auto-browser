import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RefDescriptor } from './control-service.js';

export interface SiteCredentials {
  username: string;
  password: string;
}

export interface CredentialFile {
  sites: Record<string, SiteCredentials>;
}

export function getCredentialsFilePath(): string {
  return join(homedir(), '.auto-browser', 'credentials.json');
}

export function loadCredentials(customPath?: string): CredentialFile {
  const path = customPath ?? getCredentialsFilePath();
  if (!existsSync(path)) {
    return { sites: {} };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as CredentialFile;
    if (!parsed.sites || typeof parsed.sites !== 'object') {
      return { sites: {} };
    }
    return parsed;
  } catch {
    return { sites: {} };
  }
}

export function saveCredentials(creds: CredentialFile): void {
  const path = getCredentialsFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2), 'utf-8');
  // Restrict file permissions on Unix-like systems
  try {
    const { chmodSync } = require('node:fs');
    chmodSync(path, 0o600);
  } catch {
    // Best-effort
  }
}

export function matchCredentials(url: string, creds: CredentialFile): SiteCredentials | null {
  if (!url || !creds.sites) {
    return null;
  }
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    // Direct match
    if (creds.sites[hostname]) {
      return creds.sites[hostname];
    }
    // Suffix match: login.example.com -> example.com
    const parts = hostname.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join('.');
      if (creds.sites[candidate]) {
        return creds.sites[candidate];
      }
    }
    // Also try bare domain (e.g., "weibo.com" matches "login.weibo.com")
    const fullMatch = Object.keys(creds.sites).find((key) => hostname.endsWith(key) || key.endsWith(hostname));
    if (fullMatch) {
      return creds.sites[fullMatch];
    }
  } catch {
    // Invalid URL
  }
  return null;
}

export interface LoginFormDetection {
  detected: boolean;
  usernameRef?: string;
  passwordRef?: string;
  submitRef?: string;
}

const USERNAME_KEYWORDS = [
  'username', 'user name', 'email', 'e-mail', 'login', 'account',
  '手机号', '手机号码', '手机', '电话', '邮箱', '账号', '帐号',
  '用户名', '用户', '用户信息', '登录名', '登录账号',
  'phone', 'mobile', 'tel',
];

const PASSWORD_KEYWORDS = [
  'password', 'passwd', 'pwd', 'pass', '密码', '口令',
  '验证码', '短信验证码',
];

export function detectLoginForm(
  refs: RefDescriptor[] | Record<string, { role: string; name?: string }>
): LoginFormDetection {
  const entries: Array<{ ref: string; role: string; name?: string }> = Array.isArray(refs)
    ? refs.map((r) => ({ ref: r.ref, role: r.role, name: r.name }))
    : Object.entries(refs).map(([ref, data]) => ({ ref, role: data.role, name: data.name }));

  if (entries.length === 0) {
    return { detected: false };
  }

  let usernameRef: string | undefined;
  let passwordRef: string | undefined;
  let submitRef: string | undefined;

  for (const entry of entries) {
    const lowerName = (entry.name ?? '').toLowerCase();
    const lowerRole = (entry.role ?? '').toLowerCase();

    if (lowerRole === 'textbox' || lowerRole === 'searchbox') {
      if (USERNAME_KEYWORDS.some((kw) => lowerName.includes(kw))) {
        usernameRef = entry.ref;
      }
    }

    if (lowerRole === 'textbox' || lowerRole === 'searchbox') {
      if (PASSWORD_KEYWORDS.some((kw) => lowerName.includes(kw))) {
        // If it's both a username and password keyword, prefer it as password
        passwordRef = entry.ref;
      }
    }

    // Type=password is usually represented as role=textbox with "password" in the name
    // but sometimes as a different role. Also check for direct password field indication.
    if (lowerRole === 'password') {
      passwordRef = entry.ref;
    }

    if (
      lowerRole === 'button' &&
      (lowerName.includes('login') ||
        lowerName.includes('sign in') ||
        lowerName.includes('log in') ||
        lowerName.includes('submit') ||
        lowerName.includes('登录') ||
        lowerName.includes('登入') ||
        lowerName.includes('登 录') ||
        lowerName.includes('提交') ||
        lowerName.includes('下一步') ||
        lowerName.includes('发送验证码') ||
        lowerName.includes('获取验证码') ||
        lowerName.includes('立即登录') ||
        lowerName.includes('注册/登录'))
    ) {
      submitRef = entry.ref;
    }
  }

  // If no explicit username ref detected but we have a password ref, use the first textbox as username
  if (!usernameRef && passwordRef) {
    const firstTextbox = entries.find(
      (e) =>
        (e.role === 'textbox' || e.role === 'searchbox') &&
        e.ref !== passwordRef
    );
    if (firstTextbox) {
      usernameRef = firstTextbox.ref;
    }
  }

  return {
    detected: Boolean(usernameRef && passwordRef),
    usernameRef,
    passwordRef,
    submitRef,
  };
}
