import { describe, expect, it, vi } from 'vitest';
import { BrowserInstaller } from './browser-installer.js';

const missingChromiumError = new Error(
  "browserType.launchPersistentContext: Executable doesn't exist at /tmp/chromium\nPlease run the following command to download new browsers: playwright install"
);

describe('BrowserInstaller', () => {
  it('installs Chromium and retries once when the managed browser is missing', async () => {
    const installChromium = vi.fn(async () => undefined);
    const launch = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(missingChromiumError)
      .mockResolvedValueOnce(undefined);
    const installer = new BrowserInstaller({ installChromium });

    await installer.launchManagedBrowser(launch);

    expect(installChromium).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('returns a readable error when installation fails', async () => {
    const installer = new BrowserInstaller({
      installChromium: async () => {
        throw new Error('network unavailable');
      },
    });

    await expect(
      installer.launchManagedBrowser(async () => {
        throw missingChromiumError;
      })
    ).rejects.toThrow('automatic installation failed: network unavailable');
  });

  it('returns a readable error when launch still fails after installation', async () => {
    const installer = new BrowserInstaller({
      installChromium: async () => undefined,
    });
    const launch = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(missingChromiumError)
      .mockRejectedValueOnce(new Error('sandbox denied launch'));

    await expect(installer.launchManagedBrowser(launch)).rejects.toThrow(
      'Managed Chromium was installed, but launching the browser still failed: sandbox denied launch'
    );
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
