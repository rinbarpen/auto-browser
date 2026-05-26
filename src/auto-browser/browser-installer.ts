import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);

export interface BrowserInstallerOptions {
  installChromium?: () => Promise<void>;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissingManagedChromiumError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    message.includes("Executable doesn't exist") &&
    message.toLowerCase().includes('chromium')
  ) || message.includes('Please run the following command to download new browsers');
}

async function runPlaywrightInstallChromium(): Promise<void> {
  const cliPath = resolvePlaywrightCliPath();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'pipe',
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `playwright install chromium exited with code ${code}`));
    });
  });
}

function resolvePlaywrightCliPath(): string {
  try {
    return require.resolve('playwright/cli.js');
  } catch {
    return resolve(import.meta.dirname, '../../agent-browser/node_modules/playwright/cli.js');
  }
}

export class BrowserInstaller {
  private readonly installChromiumImpl: () => Promise<void>;

  constructor(options: BrowserInstallerOptions = {}) {
    this.installChromiumImpl = options.installChromium ?? runPlaywrightInstallChromium;
  }

  async launchManagedBrowser(launch: () => Promise<void>): Promise<void> {
    try {
      await launch();
      return;
    } catch (error) {
      if (!isMissingManagedChromiumError(error)) {
        throw error;
      }
    }

    try {
      await this.installChromiumImpl();
    } catch (error) {
      throw new Error(
        `Managed Chromium is required but automatic installation failed: ${formatErrorMessage(error)}`
      );
    }

    try {
      await launch();
    } catch (error) {
      throw new Error(
        `Managed Chromium was installed, but launching the browser still failed: ${formatErrorMessage(error)}`
      );
    }
  }

  async resolveCloakBrowserBinary(env: NodeJS.ProcessEnv = process.env): Promise<string> {
    const binaryPath = env.CLOAKBROWSER_BINARY_PATH?.trim();
    if (binaryPath && existsSync(binaryPath)) {
      return binaryPath;
    }

    try {
      const cloakbrowser = await import('cloakbrowser');
      const info = cloakbrowser.binaryInfo?.() as { path?: string } | undefined;
      if (info?.path && existsSync(info.path)) {
        return info.path;
      }
      await cloakbrowser.ensureBinary();
      const updatedInfo = cloakbrowser.binaryInfo?.() as { path?: string } | undefined;
      if (updatedInfo?.path && existsSync(updatedInfo.path)) {
        return updatedInfo.path;
      }
      throw new Error('CloakBrowser binary path not found after ensureBinary()');
    } catch (error) {
      if (error instanceof Error && error.message.includes('CloakBrowser binary path')) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `CloakBrowser is required but the package or binary could not be loaded. Install it with: npm install cloakbrowser\n${message}`
      );
    }
  }
}
