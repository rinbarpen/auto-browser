import { BrowserManager } from 'agent-browser/browser';
import { solveTurnstileChallenge, injectTurnstileToken } from './capsolver.js';

type BrowserPage = ReturnType<BrowserManager['getPage']>;

export interface PageSnapshot {
  tree: string;
  refs: Record<string, { role: string; name?: string }>;
}

export interface BrowserWrapperOptions {
  headless?: boolean;
  profile?: string;
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
  args?: string[];
  executablePath?: string;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isLikelyCloudflareChallengeUrl(url: string): boolean {
  return url.includes('/cdn-cgi/') || url.includes('challenges.cloudflare.com');
}

export class CrawlerBrowser {
  private browser: BrowserManager;
  private options: BrowserWrapperOptions;
  private antiDetectInit: boolean = false;
  private cspRouteEnabled: boolean = false;

  constructor(options: BrowserWrapperOptions = {}) {
    this.browser = new BrowserManager();
    this.options = { headless: true, ...options };
  }

  async launch(): Promise<void> {
    const launchArgs = this.options.args ?? [];
    const allArgs: string[] = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=ContentSecurityPolicy,IsolateOrigins,SitePerProcess',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      ...launchArgs,
    ];
    await this.browser.launch({
      id: '1',
      action: 'launch',
      headless: this.options.headless ?? true,
      profile: this.options.profile,
      proxy: this.options.proxy,
      executablePath: this.options.executablePath,
      args: allArgs,
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    this.antiDetectInit = false;

    // Load persisted cookies if configured
    const cookiePath = process.env.HXCY_COOKIES;
    if (cookiePath) {
      try {
        const fs = await import('node:fs');
        if (fs.existsSync(cookiePath)) {
          const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
          const page = this.browser.getPage();
          await page.context().addCookies(cookies);
          console.log(`[Cookies] Loaded ${cookies.length} cookies from ${cookiePath}`);
        }
      } catch (e) {
        console.warn('[Cookies] Failed to load cookies:', e instanceof Error ? e.message : String(e));
      }
    }
  }

  private async ensureAntiDetect(): Promise<void> {
    if (this.antiDetectInit) return;
    try {
      const page = this.browser.getPage();
      const ctx = page.context();

      // Strip CSP from document responses only (not API/XHR requests)
      // so Cloudflare challenge resources load without interference.
      if (!this.cspRouteEnabled) {
        await page.route('**/*', async (route) => {
          const request = route.request();
          // Do NOT intercept Cloudflare challenge API POSTs — those break on re-fetch.
          if (
            request.url().includes('challenges.cloudflare.com/cdn-cgi/challenge-platform') ||
            request.method() !== 'GET'
          ) {
            await route.continue();
            return;
          }
          let response;
          try {
            response = await route.fetch();
          } catch {
            // route.fetch can fail through proxy (TLS reset), fall back to continuing
            await route.continue();
            return;
          }
          const responseHeaders = response.headers();
          // Only strip CSP from HTML document responses
          const contentType = responseHeaders['content-type'] || '';
          if (!contentType.includes('text/html')) {
            await route.fulfill({ status: response.status(), headers: responseHeaders, body: await response.body() });
            return;
          }
          const filteredHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(responseHeaders)) {
            const lk = key.toLowerCase();
            if (
              lk !== 'content-security-policy' &&
              lk !== 'content-security-policy-report-only' &&
              lk !== 'x-frame-options' &&
              lk !== 'cross-origin-embedder-policy' &&
              lk !== 'cross-origin-opener-policy'
            ) {
              filteredHeaders[key] = value;
            }
          }
          await route.fulfill({
            status: response.status(),
            headers: filteredHeaders,
            body: await response.body(),
          });
        });
        this.cspRouteEnabled = true;
      }

      await ctx.addInitScript(() => {
        // Override multiple automation detection vectors
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

        // Shape chrome.runtime like a real browser (not automation)
        const origChrome = (window as any).chrome;
        if (origChrome && origChrome.runtime) {
          // Keep runtime but remove the automation id
          if (origChrome.runtime.id) {
            // Real Chrome always has a runtime.id — removing it is suspicious.
            // Keep it but clear any automation-identifying properties.
          }
        }

        // Add missing plugins (realistic names)
        if (navigator.plugins.length === 0) {
          Object.defineProperty(navigator, 'plugins', {
            get: () => [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
              { name: 'Native Client', filename: 'internal-nacl-plugin' },
            ] as any,
          });
        }

        // Hardware concurrency — real machines are rarely 1
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

        // Device memory (GB)
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

        // Override permissions
        const origQuery = navigator.permissions.query.bind(navigator.permissions);
        (navigator.permissions as any).query = (params: any) => {
          if (params.name === 'notifications') {
            return Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus);
          }
          return origQuery(params);
        };

        // Override languages to match Chinese environment
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });

        // Spoof WebGL vendor/renderer to look like a real GPU
        try {
          const getExt = HTMLCanvasElement.prototype.getContext;
          const origGetParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function (param: number) {
            const UNMASKED_VENDOR = 0x9245;
            const UNMASKED_RENDERER = 0x9246;
            if (param === UNMASKED_VENDOR) return 'Intel Inc.';
            if (param === UNMASKED_RENDERER) return 'Intel(R) HD Graphics 530';
            return origGetParameter.call(this, param);
          };
        } catch { /* ignore */ }
      });

      try {
        // Tell Cloudflare we're a real browser with proper client hints
        await ctx.setExtraHTTPHeaders({
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Sec-CH-UA': '"Google Chrome";v="120", "Not?A_Brand";v="8"',
          'Sec-CH-UA-Mobile': '?0',
          'Sec-CH-UA-Platform': '"Linux"',
          'Sec-CH-UA-Arch': '"x86"',
          'Sec-CH-UA-Bitness': '"64"',
          'Sec-CH-UA-Full-Version': '"120.0.0.0"',
          'Sec-CH-UA-Full-Version-List': '"Google Chrome";v="120", "Not?A_Brand";v="8"',
          'Sec-CH-UA-Model': '""',
          'Sec-CH-UA-Platform-Version': '"6.8.0"',
        });
      } catch {
        // ignore
      }
      this.antiDetectInit = true;
    } catch {
      // ignore
    }
  }

  async navigate(url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'load'): Promise<void> {
    const page = this.browser.getPage();
    await this.ensureAntiDetect();
    try {
      await page.goto(url, { waitUntil, timeout: 60_000 });
    } catch {
      // Navigation might timeout due to Cloudflare, try once more with longer timeout
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      } catch {
        // ignore, page may have partially loaded
      }
    }
    await this.handleCloudflareIfPresent(page, { maxWaitMs: this.options.headless ? 180_000 : 600_000 });
  }

  async getSnapshot(options?: { interactive?: boolean; compact?: boolean; maxDepth?: number }): Promise<PageSnapshot> {
    return this.browser.getSnapshot(options);
  }

  async getPageContent(): Promise<string> {
    const page = this.browser.getPage();
    return page.content();
  }

  async getHtml(selector?: string): Promise<string> {
    const page = this.browser.getPage();
    if (selector) {
      const el = await page.$(selector);
      return el ? (await el.innerHTML()) ?? '' : '';
    }
    const body = await page.$('body');
    return body ? (await body.innerHTML()) ?? '' : '';
  }

  async click(selector: string): Promise<void> {
    const locator = this.browser.getLocator(selector);
    await locator.click();
  }

  async fill(selector: string, value: string): Promise<void> {
    const locator = this.browser.getLocator(selector);
    await locator.fill(value);
  }

  async wait(ms: number): Promise<void> {
    const page = this.browser.getPage();
    await page.waitForTimeout(ms);
  }

  async waitForSelector(selector: string, timeout = 10000): Promise<void> {
    const page = this.browser.getPage();
    await page.waitForSelector(selector, { timeout });
  }

  async waitForUrl(pattern: string | RegExp, timeout = 30000): Promise<void> {
    const page = this.browser.getPage();
    await page.waitForURL(pattern, { timeout });
  }

  getUrl(): string {
    return this.browser.getPage().url();
  }

  async screenshot(path?: string): Promise<Buffer | string> {
    const page = this.browser.getPage();
    if (path) {
      await page.screenshot({ path });
      return path;
    }
    return page.screenshot();
  }

  async screenshotElement(selector: string): Promise<Buffer> {
    const locator = this.browser.getLocator(selector);
    return locator.screenshot();
  }

  getPage(): BrowserPage {
    return this.browser.getPage();
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  isLaunched(): boolean {
    return this.browser.isLaunched();
  }

  private async handleCloudflareIfPresent(
    page: BrowserPage,
    options: { maxWaitMs: number }
  ): Promise<void> {
    const startedAt = Date.now();

    const looksLikeChallenge = async (): Promise<boolean> => {
      const currentUrl = page.url();
      if (isLikelyCloudflareChallengeUrl(currentUrl)) return true;

      try {
        const title = await page.title();
        if (/just a moment/i.test(title)) return true;
      } catch {
        // ignore
      }

      try {
        const text = await page.textContent('body');
        if (!text) return false;
        if (
          /checking your browser/i.test(text) ||
          /verify you are human/i.test(text) ||
          /attention required/i.test(text) ||
          /正在进行安全验证/i.test(text) ||
          /请稍候/i.test(text) ||
          /enable javascript and cookies/i.test(text) ||
          /performing security verification/i.test(text) ||
          /cf_chl_opt/i.test(text) ||
          /challenge-platform/i.test(text)
        ) {
          return true;
        }
      } catch {
        // ignore
      }

      // Turnstile / challenge frames often load from challenges.cloudflare.com
      const frameUrls = page.frames().map((f) => f.url());
      if (frameUrls.some((u) => u.includes('challenges.cloudflare.com'))) return true;

      return false;
    };

    const humanize = async (): Promise<void> => {
      try {
        await page.waitForTimeout(randInt(250, 800));
        const vp = page.viewportSize();
        const w = vp?.width ?? 1280;
        const h = vp?.height ?? 720;
        await page.mouse.move(randInt(10, w - 10), randInt(10, h - 10), { steps: randInt(5, 18) });
        await page.waitForTimeout(randInt(150, 450));
        await page.mouse.wheel(0, randInt(120, 480));
      } catch {
        // ignore
      }
    };

    const trySolveInteractively = async (): Promise<boolean> => {
      // Try common "Verify" buttons on the top page.
      const candidates = [
        'text=/verify you are human/i',
        'text=/verify/i',
        'text=/continue/i',
        'button:has-text("Verify")',
        'button:has-text("Continue")',
      ];

      for (const sel of candidates) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 500 })) {
            await loc.click({ delay: randInt(30, 120) });
            await page.waitForTimeout(randInt(500, 1200));
            return true;
          }
        } catch {
          // ignore
        }
      }

      // Try Turnstile checkbox inside Cloudflare frames.
      for (const frame of page.frames()) {
        const fu = frame.url();
        if (!fu.includes('challenges.cloudflare.com')) continue;
        try {
          const checkbox = frame.locator('input[type="checkbox"]').first();
          if (await checkbox.isVisible({ timeout: 500 })) {
            await checkbox.click({ delay: randInt(30, 120) });
            await page.waitForTimeout(randInt(1200, 2500));
            return true;
          }
        } catch {
          // ignore
        }
      }

      return false;
    };

    // Fast exit if not challenge.
    if (!(await looksLikeChallenge())) return;

    let lastReload = 0;
    let capsolverAttempted = false;
    while (Date.now() - startedAt < options.maxWaitMs) {
      if (!(await looksLikeChallenge())) return;

      await humanize();
      await trySolveInteractively();

      // If interactive methods haven't worked, try Capsolver once
      if (!capsolverAttempted) {
        capsolverAttempted = true;
        try {
          // Wait for Turnstile iframe to appear before extracting sitekey
          for (let i = 0; i < 20; i++) {
            const hasChallengeFrame = page.frames().some((f) =>
              f.url().includes('challenges.cloudflare.com')
            );
            if (hasChallengeFrame) break;
            await page.waitForTimeout(1000);
          }
          const html = await page.content();
          const pageUrl = page.url();
          const frameUrls = page.frames().map((f) => f.url());
          console.log('[Cloudflare] Frames:', frameUrls.filter((u) => u.includes('challenge')));
          const solution = await solveTurnstileChallenge(html, pageUrl, frameUrls);
          if (solution?.token) {
            console.log('[Cloudflare] Injecting Capsolver Turnstile token...');
            await injectTurnstileToken(page, solution.token);
            // Wait for challenge to process
            for (let i = 0; i < 15; i++) {
              await page.waitForTimeout(2000);
              if (!(await looksLikeChallenge())) break;
            }
          }
        } catch (e) {
          console.warn('[Cloudflare] Capsolver attempt failed:', e instanceof Error ? e.message : String(e));
        }
      }

      // Wait and check for challenge resolution
      try {
        await page.waitForTimeout(randInt(800, 1800));
        await page.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      } catch {
        // ignore
      }

      // Reload every 60 seconds to retry the challenge
      if (Date.now() - lastReload > 60_000) {
        lastReload = Date.now();
        try {
          await page.reload({ timeout: 30_000, waitUntil: 'domcontentloaded' });
        } catch {
          // ignore
        }
      }
    }

    throw new Error(
      [
        'Cloudflare challenge not passed within timeout.',
        `Current URL: ${page.url()}`,
        'Tip: run with headless=false and set a persistent profile directory so cookies persist.',
      ].join('\n')
    );
  }
}
