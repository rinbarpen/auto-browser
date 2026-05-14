import fs from 'node:fs';
import { getWorkbenchConfig } from './config';
import { WorkbenchRuntime } from './runtime';
import { createWorkbenchStore } from './store';

declare global {
  // eslint-disable-next-line no-var
  var __workbenchServices__: ReturnType<typeof createServices> | undefined;
}

function createServices() {
  const config = getWorkbenchConfig();
  fs.mkdirSync(config.assetsDir, { recursive: true });
  const store = createWorkbenchStore({ dbPath: config.dbPath });
  const runtime = new WorkbenchRuntime(store, config.assetsDir);
  return { config, store, runtime };
}

export function getWorkbenchServices() {
  if (!globalThis.__workbenchServices__) {
    globalThis.__workbenchServices__ = createServices();
  }
  return globalThis.__workbenchServices__;
}
