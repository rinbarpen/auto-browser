import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const candidates = [
  { type: 'exec', path: resolve(root, 'agent-browser/node_modules/.bin/vitest') },
  {
    type: 'node',
    path: resolve(
      root,
      'agent-browser/node_modules/.pnpm/vitest@4.0.16_@types+node@20.19.28_tsx@4.21.0_yaml@2.8.2/node_modules/vitest/vitest.mjs'
    ),
  },
  { type: 'node', path: resolve(root, 'node_modules/vitest/vitest.mjs') },
];

const args = process.argv.slice(2);
const vitestEntrypoint = await findFirstExistingFile(candidates);

if (!vitestEntrypoint) {
  console.error('Unable to find a working vitest entrypoint.');
  process.exit(1);
}

const child = spawn(
  vitestEntrypoint.type === 'exec' ? vitestEntrypoint.path : process.execPath,
  vitestEntrypoint.type === 'exec' ? args : [vitestEntrypoint.path, ...args],
  {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

async function findFirstExistingFile(paths) {
  for (const path of paths) {
    try {
      await access(path.path);
      return path;
    } catch {}
  }
  return null;
}
