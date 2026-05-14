const CAPTCHA_POLL_INTERVAL_MS = 5_000;
const CAPTCHA_MAX_WAIT_MS = 120_000;
const TWOCAPTCHA_BASE_URL = 'https://2captcha.com';

export interface CaptchaSolveResult {
  solved: boolean;
  token?: string;
  error?: string;
}

export class CaptchaSolver {
  private readonly apiKey: string;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(config: {
    apiKey: string;
    provider?: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  }) {
    this.apiKey = config.apiKey;
    this.pollIntervalMs = config.pollIntervalMs ?? CAPTCHA_POLL_INTERVAL_MS;
    this.maxWaitMs = config.maxWaitMs ?? CAPTCHA_MAX_WAIT_MS;
  }

  async solveRecaptchaV2(siteKey: string, pageUrl: string): Promise<CaptchaSolveResult> {
    try {
      const inRes = await fetch(
        `${TWOCAPTCHA_BASE_URL}/in.php?key=${this.apiKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`,
        { method: 'POST' }
      );
      const inData = (await inRes.json()) as { status?: number; request?: string };

      if (inData.status !== 1 || !inData.request) {
        return { solved: false, error: `2captcha submit failed: ${JSON.stringify(inData)}` };
      }

      const captchaId = inData.request;
      const deadline = Date.now() + this.maxWaitMs;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
        const resRes = await fetch(
          `${TWOCAPTCHA_BASE_URL}/res.php?key=${this.apiKey}&action=get&id=${captchaId}&json=1`
        );
        const resData = (await resRes.json()) as { status?: number; request?: string };

        if (resData.status === 1 && resData.request) {
          return { solved: true, token: resData.request };
        }

        if (resData.request?.startsWith('ERROR_')) {
          return { solved: false, error: `2captcha: ${resData.request}` };
        }

        // CAPCHA_NOT_READY — continue polling
      }

      return { solved: false, error: '2captcha: timeout waiting for solution' };
    } catch (error) {
      return {
        solved: false,
        error: `2captcha API error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async solveImageCaptcha(imageBase64: string): Promise<CaptchaSolveResult> {
    try {
      const body = new URLSearchParams({
        key: this.apiKey,
        method: 'base64',
        body: imageBase64,
        json: '1',
      });

      const inRes = await fetch(`${TWOCAPTCHA_BASE_URL}/in.php`, {
        method: 'POST',
        body: body.toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      const inData = (await inRes.json()) as { status?: number; request?: string };

      if (inData.status !== 1 || !inData.request) {
        return { solved: false, error: `2captcha image submit failed: ${JSON.stringify(inData)}` };
      }

      const captchaId = inData.request;
      const deadline = Date.now() + this.maxWaitMs;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
        const resRes = await fetch(
          `${TWOCAPTCHA_BASE_URL}/res.php?key=${this.apiKey}&action=get&id=${captchaId}&json=1`
        );
        const resData = (await resRes.json()) as { status?: number; request?: string };

        if (resData.status === 1 && resData.request) {
          return { solved: true, token: resData.request };
        }

        if (resData.request?.startsWith('ERROR_')) {
          return { solved: false, error: `2captcha: ${resData.request}` };
        }
      }

      return { solved: false, error: '2captcha: timeout waiting for image solution' };
    } catch (error) {
      return {
        solved: false,
        error: `2captcha API error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export function createCaptchaSolverFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CaptchaSolver | null {
  const apiKey = env.AUTO_BROWSER_CAPTCHA_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  return new CaptchaSolver({ apiKey });
}

const CAPTCHA_SIGNALS = [
  'captcha',
  'recaptcha',
  'hcaptcha',
  'verify you are human',
  '验证码',
  '人机验证',
  '图形验证码',
  '安全验证',
];

export function detectCaptchaSignal(observation: Record<string, unknown>): boolean {
  const title = typeof observation.title === 'string' ? observation.title.toLowerCase() : '';
  const visibleText =
    typeof observation.visibleText === 'string' ? observation.visibleText.toLowerCase() : '';
  const combined = `${title} ${visibleText}`;

  return CAPTCHA_SIGNALS.some((s) => combined.includes(s));
}

export function extractRecaptchaSiteKey(observation: Record<string, unknown>): string | null {
  const snapshot = typeof observation.snapshot === 'string' ? observation.snapshot : '';
  const refEntries = observation.refs;
  const refsText = Array.isArray(refEntries)
    ? refEntries.map((r: Record<string, unknown>) => String(r.name ?? '')).join(' ')
    : typeof refEntries === 'object' && refEntries
      ? Object.values(refEntries)
          .map((r: unknown) => String((r as Record<string, unknown>)?.name ?? ''))
          .join(' ')
      : '';

  const combined = `${snapshot} ${refsText} ${observation.visibleText ?? ''}`;
  const siteKeyMatch = combined.match(/data-sitekey=["']?([^"'&\s]+)/);
  if (siteKeyMatch?.[1]) {
    return siteKeyMatch[1];
  }

  // Also check visible text for sitekey patterns
  const visibleKeyMatch = String(observation.visibleText ?? '').match(/sitekey["']?\s*[:=]\s*["']([^"'&\s]+)/);
  if (visibleKeyMatch?.[1]) {
    return visibleKeyMatch[1];
  }

  return null;
}
