import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ServerLogLevel = 'info' | 'warn' | 'error';
export type ServerLogFields = Record<string, unknown>;

export interface ServerLogger {
  info(event: string, fields?: ServerLogFields): void;
  warn(event: string, fields?: ServerLogFields): void;
  error(event: string, fields?: ServerLogFields): void;
}

export interface ServerLoggerOptions {
  service: string;
  fileName: string;
  logDir?: string;
  consoleWriter?: (line: string, level: ServerLogLevel) => void;
}

const SENSITIVE_KEYS = new Set(['apikey', 'api_key', 'authorization', 'cookie', 'password', 'set-cookie']);

export function createServerLogger(options: ServerLoggerOptions): ServerLogger {
  const logDir = resolve(options.logDir ?? process.env.AUTO_BROWSER_LOG_DIR ?? 'logs');
  const filePath = resolve(logDir, options.fileName);
  const consoleWriter = options.consoleWriter ?? ((line, level) => {
    if (level === 'error') {
      console.error(line);
      return;
    }
    console.log(line);
  });

  function write(level: ServerLogLevel, event: string, fields: ServerLogFields = {}): void {
    const entry = redact({
      timestamp: new Date().toISOString(),
      level,
      service: options.service,
      event,
      ...fields,
    });
    mkdirSync(logDir, { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    consoleWriter(formatConsoleLine(entry), level);
  }

  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(nestedValue);
  }
  return output;
}

function formatConsoleLine(entry: unknown): string {
  const record = entry as Record<string, unknown>;
  const fields = Object.entries(record)
    .filter(([key]) => !['timestamp', 'level', 'service', 'event'].includes(key))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return `[${record.timestamp}] ${String(record.level).toUpperCase()} ${record.service} ${record.event}${
    fields ? ` ${fields}` : ''
  }`;
}
