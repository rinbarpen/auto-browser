/**
 * Cookie Manager — import/show/remove cookies for auto-browser.
 *
 * Designed for EditThisCookie JSON exports. Converts to Playwright
 * storage state format ({ cookies, origins }) consumed by --cookies-path.
 *
 * Usage:
 *   cookie-manager import <file>              # From EditThisCookie JSON file
 *   cookie-manager import --json '<json>'     # Paste JSON directly
 *   cookie-manager show <file>                # Display cookies
 *   cookie-manager remove <file> --domain d   # Remove by domain
 *   cookie-manager remove <file> --name n     # Remove by name
 *   cookie-manager help                       # Show usage
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isExecutedAsMain } from './cli.js';

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  [key: string]: unknown;
}

interface StorageState {
  cookies: Cookie[];
  origins: unknown[];
}

function usage(exitCode = 0): void {
  console.log(`
Usage: cookie-manager <command> [options]

Commands:
  import [file]              Import cookies from EditThisCookie export
    --json, -j <json>        Paste cookie JSON directly (instead of file)
    --output, -o <path>      Output path (default: cookies.json)
    --domain, -d <domain>    Only keep cookies matching this domain

  show <file>                Display cookies from a cookie file

  remove <file>              Remove cookies from a cookie file
    --domain, -d <domain>    Remove cookies matching this domain
    --name, -n <name>        Remove cookies matching this name

  help                       Show this usage information

Examples:
  cookie-manager import ./editthis-export.json
  cookie-manager import --json '[{"domain":".example.com","name":"x","value":"1"}]'
  cookie-manager import ./export.json --output ./cookies.json --domain example.com
  cookie-manager show ./cookies.json
  cookie-manager remove ./cookies.json --name session
`);
  process.exit(exitCode);
}

// ── Parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { cmd: string; args: string[]; flags: Record<string, string> } {
  const cmd = argv[2] || 'help';
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && !argv[i + 1].startsWith('-')) {
        const k = arg.slice(2);
        i++;
        flags[k] = argv[i];
      } else {
        flags[arg.slice(2)] = 'true';
      }
    } else if (arg.startsWith('-') && !arg.startsWith('--')) {
      const shortKey = arg.slice(1);
      const longMap: Record<string, string> = { j: 'json', o: 'output', d: 'domain', n: 'name' };
      const k = longMap[shortKey] || shortKey;
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        i++;
        flags[k] = argv[i];
      } else {
        flags[k] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { cmd, args: positional, flags };
}

// ── EditThisCookie → Playwright conversion ──────────────────────────

function isEditThisCookieFormat(data: unknown): data is Cookie[] {
  return Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null && 'name' in data[0] && 'value' in data[0] && 'domain' in data[0];
}

export function normalizeCookies(raw: Cookie[]): Cookie[] {
  return raw.map((c) => {
    const cookie: Cookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite: c.sameSite || 'Lax',
    };
    // Convert EditThisCookie field names
    if (c.expirationDate !== undefined && typeof c.expirationDate === 'number') {
      cookie.expires = c.expirationDate;
    } else if (c.expires !== undefined) {
      cookie.expires = c.expires;
    }
    return cookie;
  });
}

function validateCookies(cookies: Cookie[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < cookies.length; i++) {
    const c = cookies[i];
    if (!c.name) errors.push(`[${i}] missing "name"`);
    if (c.value === undefined || c.value === null) errors.push(`[${i}] missing "value"`);
    if (!c.domain) errors.push(`[${i}] missing "domain"`);
  }
  return errors;
}

function readCookiesFromSource(filePath?: string, jsonStr?: string): Cookie[] {
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr) as unknown;
      if (isEditThisCookieFormat(parsed)) return parsed;
      // Maybe it's already wrapped as storage state
      if (parsed && typeof parsed === 'object' && 'cookies' in parsed && Array.isArray((parsed as StorageState).cookies)) {
        return (parsed as StorageState).cookies;
      }
      throw new Error('JSON does not match EditThisCookie format (expected array of cookies)');
    } catch (e) {
      throw new Error(`Failed to parse --json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!filePath) throw new Error('No input provided. Use a file path or --json.');
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) throw new Error(`File not found: ${resolvedPath}`);

  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  // Already wrapped as storage state
  if (parsed && typeof parsed === 'object' && 'cookies' in parsed) {
    const state = parsed as StorageState;
    if (Array.isArray(state.cookies)) return state.cookies;
  }

  if (isEditThisCookieFormat(parsed)) return parsed;

  throw new Error('Unrecognized cookie format. Expected an array of cookie objects or { cookies: [...] }');
}

export function loadStorageState(filePath: string): StorageState {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) return { cookies: [], origins: [] };
  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (parsed && typeof parsed === 'object' && 'cookies' in parsed) {
    return parsed as StorageState;
  }
  if (Array.isArray(parsed)) {
    return { cookies: parsed, origins: [] };
  }
  return { cookies: [], origins: [] };
}

// ── Commands ─────────────────────────────────────────────────────────

function cmdImport(args: string[], flags: Record<string, string>): void {
  const filePath = args[0];
  const jsonStr = flags.json;
  const domainFilter = flags.domain || flags.d;
  const outputPath = resolve(flags.output || flags.o || 'cookies.json');

  const rawCookies = readCookiesFromSource(filePath, jsonStr);
  const errors = validateCookies(rawCookies);
  if (errors.length > 0) {
    console.error(`Error: ${errors.length} invalid cookie(s):`);
    errors.forEach((e) => console.error(`  ${e}`));
    process.exit(1);
  }

  let cookies = normalizeCookies(rawCookies);

  // Domain filter
  if (domainFilter) {
    const filterDomain = domainFilter.startsWith('.') ? domainFilter : `.${domainFilter}`;
    const before = cookies.length;
    cookies = cookies.filter(
      (c) => c.domain === domainFilter || c.domain === filterDomain || c.domain.endsWith(filterDomain)
    );
    const removed = before - cookies.length;
    if (removed > 0) console.log(`  Filtered out ${removed} cookies not matching "${domainFilter}"`);
  }

  if (cookies.length === 0) {
    console.error('Error: No valid cookies to import.');
    process.exit(1);
  }

  const state: StorageState = { cookies, origins: [] };
  writeFileSync(outputPath, JSON.stringify(state, null, 2), 'utf-8');

  const domains = [...new Set(cookies.map((c) => c.domain))].join(', ');
  console.log(`✓ Imported ${cookies.length} cookies for ${domains} → ${outputPath}`);
}

function cmdShow(args: string[], _flags: Record<string, string>): void {
  if (args.length === 0) {
    console.error('Error: missing <file> argument');
    usage(1);
  }
  const state = loadStorageState(args[0]);
  const { cookies } = state;

  if (cookies.length === 0) {
    console.log('No cookies found.');
    return;
  }

  // Group by domain
  const groups = new Map<string, Cookie[]>();
  for (const c of cookies) {
    const domain = c.domain || '(no domain)';
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain)!.push(c);
  }

  const now = Date.now() / 1000;
  let totalExpired = 0;

  for (const [domain, domainCookies] of [...groups.entries()].sort()) {
    console.log(`\n  ${domain} (${domainCookies.length} cookies):`);
    for (const c of domainCookies) {
      const expired = c.expires !== undefined && c.expires < now;
      if (expired) totalExpired++;
      const expiryStr = c.expires !== undefined
        ? expired
          ? '[expired]'
          : `expires ${timeAgo(c.expires)}`
        : '[session]';
      const flags = [
        c.httpOnly ? 'HttpOnly' : '',
        c.secure ? 'Secure' : '',
        c.sameSite && c.sameSite !== 'None' ? c.sameSite : '',
      ].filter(Boolean).join(', ');
      console.log(`    ${c.name.padEnd(30)} ${expiryStr}${flags ? `  [${flags}]` : ''}`);
    }
  }

  console.log(`\n  Total: ${cookies.length} cookies${totalExpired > 0 ? ` (${totalExpired} expired)` : ''}`);
}

function cmdRemove(args: string[], flags: Record<string, string>): void {
  if (args.length === 0) {
    console.error('Error: missing <file> argument');
    usage(1);
  }
  const domainFilter = flags.domain || flags.d;
  const nameFilter = flags.name || flags.n;

  if (!domainFilter && !nameFilter) {
    console.error('Error: specify --domain or --name to filter cookies to remove');
    usage(1);
  }

  const filePath = resolve(args[0]);
  if (!existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  const state = loadStorageState(filePath);
  const before = state.cookies.length;

  state.cookies = state.cookies.filter((c) => {
    if (domainFilter && nameFilter) {
      return !(matchesDomain(c.domain, domainFilter) && c.name === nameFilter);
    }
    if (domainFilter) return !matchesDomain(c.domain, domainFilter);
    if (nameFilter) return c.name !== nameFilter;
    return true;
  });

  const removed = before - state.cookies.length;
  if (removed === 0) {
    console.log('No matching cookies found to remove.');
    return;
  }

  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  console.log(`✓ Removed ${removed} cookies from ${filePath}`);
}

export function matchesDomain(cookieDomain: string, filter: string): boolean {
  const fd = filter.startsWith('.') ? filter : `.${filter}`;
  return cookieDomain === filter || cookieDomain === fd || cookieDomain.endsWith(fd);
}

// ── Helpers ──────────────────────────────────────────────────────────

function timeAgo(expires: number): string {
  const now = Date.now() / 1000;
  const diff = expires - now;
  if (diff <= 0) return 'now';
  const hours = diff / 3600;
  if (hours < 24) return `in ${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `in ${Math.round(days)}d`;
  const months = days / 30;
  if (months < 12) return `in ${Math.round(months)}mo`;
  return `in ${Math.round(months / 12)}y`;
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const { cmd, args, flags } = parseArgs(process.argv);

  switch (cmd) {
    case 'import':
      cmdImport(args, flags);
      break;
    case 'show':
      cmdShow(args, flags);
      break;
    case 'remove':
      cmdRemove(args, flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      usage(0);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage(1);
  }
}

if (isExecutedAsMain(import.meta.url, process.argv[1])) {
  main();
}
