import { config } from '../config.js';

interface CapsolverTaskResult {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: 'ready' | 'processing';
  solution?: {
    token?: string;
    type?: string;
    userAgent?: string;
    expireTime?: number;
  };
  taskId?: string;
}

const CAPSOLVER_BASE = 'https://api.capsolver.com';

function getApiKey(): string {
  const key = config.captcha.apiKey;
  if (!key) throw new Error('CAPTCHA_API_KEY not configured. Set CAPSOLVER_API_KEY env var.');
  return key;
}

/**
 * Create a Turnstile solving task on Capsolver.
 */
async function createTurnstileTask(
  websiteURL: string,
  websiteKey: string,
  apiKey: string
): Promise<string> {
  const res = await fetch(`${CAPSOLVER_BASE}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL,
        websiteKey,
        metadata: { action: 'managed_challenge' },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Capsolver createTask failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as CapsolverTaskResult;
  if (data.errorId !== 0) {
    throw new Error(`Capsolver error: ${data.errorCode} - ${data.errorDescription}`);
  }

  return data.taskId!;
}

/**
 * Poll Capsolver until the task is ready or timeout.
 */
async function waitForResult(
  taskId: string,
  apiKey: string,
  timeoutMs = 180_000
): Promise<CapsolverTaskResult> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const res = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Capsolver getTaskResult failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as CapsolverTaskResult;
    if (data.errorId !== 0) {
      throw new Error(`Capsolver error: ${data.errorCode} - ${data.errorDescription}`);
    }

    if (data.status === 'ready') {
      return data;
    }

    // Wait 1-3 seconds before polling again
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
  }

  throw new Error(`Capsolver task ${taskId} timed out after ${timeoutMs}ms`);
}

/**
 * Extract the Turnstile sitekey from the challenge page HTML or frame URLs.
 * In Managed Challenge, the sitekey is often embedded in the iframe URL path,
 * not in the main page HTML.
 */
function extractTurnstileSiteKey(html: string, frameUrls?: string[]): string | null {
  // Pattern 1: data-sitekey attribute in HTML
  const htmlPatterns = [
    /data-sitekey=["']([^"']+)["']/,
    /cf-chl-widget[^>]+data-sitekey=["']([^"']+)["']/,
    /challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\/[^"]*sitekey=([^&"']+)/,
  ];

  for (const pattern of htmlPatterns) {
    const m = html.match(pattern);
    if (m?.[1]) return m[1];
  }

  // Pattern 2: sitekey as path segment in iframe Turnstile URLs
  // e.g. .../turnstile/f/ov2/av0/rch/7kegw/0x4AAAAAAADnPIDROrmt1Wwj/light/...
  // Turnstile sitekeys are base64-ish strings starting with "0x" followed by
  // alphanumeric characters (not just hex).
  if (frameUrls?.length) {
    const urlPattern = /challenges\.cloudflare\.com\/.*?\/turnstile\/.*?\/(0x[0-9A-Za-z_-]{20,})/;
    for (const url of frameUrls) {
      const m = url.match(urlPattern);
      if (m?.[1]) return m[1];
    }
  }

  return null;
}

/**
 * Solve a Cloudflare Turnstile challenge using Capsolver.
 * Returns the solution token on success, or null if no API key configured.
 */
export async function solveTurnstileChallenge(
  html: string,
  pageUrl: string,
  frameUrls?: string[]
): Promise<{ token: string; userAgent?: string } | null> {
  if (!config.captcha.apiKey) return null;

  const siteKey = extractTurnstileSiteKey(html, frameUrls);
  if (!siteKey) {
    console.warn('[Capsolver] Could not extract Turnstile sitekey from page HTML');
    return null;
  }

  console.log(`[Capsolver] Solving Turnstile sitekey=${siteKey} for ${pageUrl}`);

  try {
    const apiKey = config.captcha.apiKey;
    const taskId = await createTurnstileTask(pageUrl, siteKey, apiKey);
    console.log(`[Capsolver] Task created: ${taskId}, waiting for solution...`);
    const result = await waitForResult(taskId, apiKey);

    if (!result.solution?.token) {
      console.warn('[Capsolver] No token in solution');
      return null;
    }

    console.log('[Capsolver] Challenge solved!');
    return {
      token: result.solution.token,
      userAgent: result.solution.userAgent,
    };
  } catch (err) {
    console.error('[Capsolver] Error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Inject a Turnstile solution token into the page.
 * This sets the hidden input value and triggers the challenge callback.
 */
export async function injectTurnstileToken(
  page: any,
  token: string
): Promise<boolean> {
  try {
    // Method 1: Find and set the cf-turnstile-response input
    const injected = await page.evaluate((t: string) => {
      // Find the Turnstile response input
      const input = document.querySelector<HTMLInputElement>(
        'input[name="cf-turnstile-response"]'
      );
      if (input) {
        input.value = t;

        // Trigger events so the page JS picks up the change
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        // Also try setting it on the specific widget input
        const widgetInput = document.querySelector<HTMLInputElement>(
          'input[id^="cf-chl-widget"][id$="_response"]'
        );
        if (widgetInput && widgetInput !== input) {
          widgetInput.value = t;
          widgetInput.dispatchEvent(new Event('input', { bubbles: true }));
          widgetInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Dispatch custom turnstile callback event on window
        window.dispatchEvent(new CustomEvent('cf-turnstile-response', { detail: t }));

        return true;
      }

      // Method 2: Try calling Turnstile callbacks directly
      const w = window as any;
      // Common callback names used by Cloudflare Managed Challenge
      if (typeof w.cb === 'function') {
        w.cb(t);
        return true;
      }
      if (typeof w.verifyCallback === 'function') {
        w.verifyCallback(t);
        return true;
      }
      // Try onload callback (e.g. kwkA1 from api.js?onload=kwkA1)
      for (const key of Object.keys(w)) {
        if (typeof w[key] === 'function' && key.length <= 10 && /^[a-zA-Z0-9]+$/.test(key)) {
          try {
            w[key](t);
            return true;
          } catch {
            // wrong function
          }
        }
      }

      return false;
    }, token);

    if (injected) {
      await page.waitForTimeout(2000);

      // Try to submit via button click
      try {
        await page.evaluate(() => {
          const btn = document.querySelector<HTMLElement>(
            '#challenge-stage button[type="submit"], .challenge-button'
          );
          btn?.click();
        });
      } catch {
        // ignore
      }

      return true;
    }

    return false;
  } catch {
    return false;
  }
}
