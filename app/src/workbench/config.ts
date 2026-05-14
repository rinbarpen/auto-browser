import path from 'node:path';

export function getWorkbenchConfig() {
  const rootDir = process.cwd();
  return {
    dbPath: path.resolve(rootDir, process.env.WORKBENCH_DB_PATH ?? './data/workbench.db'),
    assetsDir: path.resolve(rootDir, process.env.WORKBENCH_ASSETS_DIR ?? './data/workbench-assets'),
    port: parseInt(process.env.PORT ?? '3137', 10),
  };
}
