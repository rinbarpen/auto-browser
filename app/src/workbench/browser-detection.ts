import { detectBrowserRuntimeDefaults } from '../../../src/auto-browser/browser-runtime-defaults';
import type { BrowserRuntimeDetectionOptions } from '../../../src/auto-browser/browser-runtime-defaults';
import type { BrowserInstanceCandidate, BrowserInstanceRecord } from './types';

const DEFAULT_START_URL = 'https://example.com';
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

export function detectBrowserInstanceCandidates(
  instances: BrowserInstanceRecord[],
  options?: BrowserRuntimeDetectionOptions
): BrowserInstanceCandidate[] {
  const defaults = detectBrowserRuntimeDefaults(options);
  const candidate: BrowserInstanceCandidate = {
    id: 'detected-default-browser',
    name: defaults.mode === 'system' ? `${formatBrowserFamily(defaults.browserFamily)} browser` : 'Managed Chromium',
    startUrl: DEFAULT_START_URL,
    mode: defaults.mode,
    browserFamily: defaults.browserFamily,
    executablePath: defaults.executablePath,
    profilePath: defaults.profilePath || null,
    viewport: DEFAULT_VIEWPORT,
    headless: false,
    detected: defaults.detected,
    message: defaults.message,
  };
  const imported = instances.find((instance) => equivalentInstance(instance, candidate));
  return [
    {
      ...candidate,
      importedInstanceId: imported?.id,
    },
  ];
}

function equivalentInstance(instance: BrowserInstanceRecord, candidate: BrowserInstanceCandidate): boolean {
  return (
    instance.mode === candidate.mode &&
    instance.browserFamily === candidate.browserFamily &&
    instance.executablePath === candidate.executablePath &&
    (instance.profilePath ?? null) === (candidate.profilePath ?? null) &&
    instance.startUrl === candidate.startUrl &&
    instance.headless === candidate.headless &&
    instance.viewport.width === candidate.viewport.width &&
    instance.viewport.height === candidate.viewport.height
  );
}

function formatBrowserFamily(browserFamily: BrowserInstanceCandidate['browserFamily']): string {
  if (browserFamily === 'chrome') return 'Chrome';
  if (browserFamily === 'edge') return 'Edge';
  return 'Chromium';
}
