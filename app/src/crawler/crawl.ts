import { nanoid } from 'nanoid';
import { CrawlerBrowser } from './browser.js';
import { login } from './login.js';
import { extractResourcesFromPage } from './extractor.js';
import { isLikelyUrl } from './qr.js';
import { insertResource, closeDb } from '../storage/db.js';
import { computeContentHash, isDuplicate } from '../storage/dedup.js';
import { config } from '../config.js';
import type { Resource, ResourceLink } from '../types.js';
import type { CrawlStatus } from '../types.js';

let crawlStatus: CrawlStatus = {
  phase: 'idle',
  logs: [],
  collected: 0,
  skipped: 0,
};

function logStatus(message: string): void {
  crawlStatus.logs.push({ timestamp: new Date().toISOString(), message });
}

export function getCrawlStatus(): CrawlStatus {
  return { ...crawlStatus };
}

export async function runCrawl(options?: {
  categoryUrls?: string[];
  headless?: boolean;
  profile?: string;
}): Promise<{ collected: number; skipped: number }> {
  crawlStatus = {
    phase: 'launching',
    logs: [],
    collected: 0,
    skipped: 0,
  };
  logStatus('启动浏览器...');

  // Read proxy from environment
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  const proxy = proxyUrl ? { server: proxyUrl } : undefined;

  const chromePath = process.env.HXCY_CHROME_PATH || '/usr/bin/google-chrome';
  const browser = new CrawlerBrowser({
    headless: options?.headless ?? true,
    profile: options?.profile ?? process.env.HXCY_PROFILE,
    proxy,
    executablePath: chromePath,
    args: ['--no-sandbox'],
  });
  let collected = 0;
  let skipped = 0;

  try {
    await browser.launch();
    crawlStatus.phase = 'logging_in';
    logStatus('正在登录...');

    const loggedIn = await login(browser);
    if (!loggedIn) {
      logStatus('登录可能失败，继续执行');
      console.warn('Login may have failed - continuing anyway');
    } else {
      logStatus('登录成功');
    }

    const baseUrl = config.hxcy.baseUrl;
    crawlStatus.phase = 'navigating';
    logStatus('获取栏目列表...');
    await browser.navigate(baseUrl);
    await browser.wait(2000);
    const categoryUrls = options?.categoryUrls ?? await getCategoryUrls(browser, baseUrl);
    crawlStatus.totalUrls = categoryUrls.length;
    logStatus(`共 ${categoryUrls.length} 个栏目`);

    for (let i = 0; i < categoryUrls.length; i++) {
      const url = categoryUrls[i];
      crawlStatus.currentUrl = url;
      crawlStatus.currentUrlIndex = i + 1;
      crawlStatus.collected = collected;
      crawlStatus.skipped = skipped;
      crawlStatus.phase = 'navigating';
      logStatus(`[${i + 1}/${categoryUrls.length}] 访问: ${url}`);

      await browser.navigate(url);
      await browser.wait(2000);

      try {
        const buf = await browser.screenshot();
        crawlStatus.screenshot = buf ? Buffer.from(buf).toString('base64') : undefined;
      } catch {
        crawlStatus.screenshot = undefined;
      }

      crawlStatus.phase = 'extracting';
      logStatus('提取资源...');

      const snapshot = await browser.getSnapshot({ interactive: false, compact: true });
      const html = await browser.getHtml();

      const debugDir = process.env.HXCY_DEBUG_DIR;
      if (debugDir) {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const dir = path.join(debugDir, `page-${i + 1}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'snapshot.txt'), snapshot.tree.slice(0, 5000), 'utf-8');
        fs.writeFileSync(path.join(dir, 'html.txt'), html.slice(0, 5000), 'utf-8');
      }

      let extracted: Awaited<ReturnType<typeof extractResourcesFromPage>>;
      try {
        extracted = await extractResourcesFromPage(snapshot.tree, html);
      } catch (extractErr) {
        const msg = extractErr instanceof Error ? extractErr.message : String(extractErr);
        logStatus(`提取失败: ${msg}`);
        console.error('[DEBUG] extractResourcesFromPage error:', extractErr);
        extracted = [];
      }
      const category = extractCategoryFromUrl(url);

      for (const item of extracted) {
        for (const link of item.links) {
          const hash = computeContentHash(link);
          if (isDuplicate(hash)) {
            skipped++;
            continue;
          }

          const resource: Resource = {
            id: nanoid(),
            sourceUrl: url,
            title: item.title,
            category,
            links: [link],
            context: item.context,
            createdAt: new Date().toISOString(),
            contentHash: hash,
          };
          insertResource(resource);
          collected++;
        }

        if (item.links.length === 0 && (item.extractCode || item.unzipPassword)) {
          const placeholderLink: ResourceLink = {
            url: url,
            platform: 'other',
            extractCode: item.extractCode,
            unzipPassword: item.unzipPassword,
          };
          const hash = computeContentHash(placeholderLink);
          if (!isDuplicate(hash)) {
            const resource: Resource = {
              id: nanoid(),
              sourceUrl: url,
              title: item.title,
              category,
              links: [placeholderLink],
              context: item.context,
              createdAt: new Date().toISOString(),
              contentHash: hash,
            };
            insertResource(resource);
            collected++;
          } else {
            skipped++;
          }
        }
      }

      crawlStatus.collected = collected;
      crawlStatus.skipped = skipped;

      const qrContents = await extractQrFromPage(browser);
      for (const qrText of qrContents) {
        if (isLikelyUrl(qrText)) {
          const link: ResourceLink = { url: qrText.startsWith('http') ? qrText : `https://${qrText}`, platform: 'other' };
          const hash = computeContentHash(link);
          if (!isDuplicate(hash)) {
            const resource: Resource = {
              id: nanoid(),
              sourceUrl: url,
              title: 'QR Code Resource',
              category,
              links: [link],
              qrContent: qrText,
              context: 'From QR code',
              createdAt: new Date().toISOString(),
              contentHash: hash,
            };
            insertResource(resource);
            collected++;
          } else {
            skipped++;
          }
        }
      }

      logStatus(`本页: 新增 ${extracted.length} 项, 累计 collected=${collected} skipped=${skipped}`);
      await browser.wait(1000);
    }

    crawlStatus.phase = 'done';
    crawlStatus.collected = collected;
    crawlStatus.skipped = skipped;
    crawlStatus.currentUrl = undefined;
    crawlStatus.screenshot = undefined;
    logStatus(`采集完成: 新增 ${collected}, 跳过重复 ${skipped}`);
  } catch (err) {
    crawlStatus.phase = 'error';
    crawlStatus.error = err instanceof Error ? err.message : String(err);
    logStatus(`错误: ${crawlStatus.error}`);
    console.error('Crawl error:', err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error('Stack:', err.stack.split('\n').slice(0, 5).join('\n'));
  } finally {
    await browser.close();
    closeDb();
  }

  return { collected, skipped };
}

const EXCLUDED_PATH_PARTS = ['/login', '/logout', '/register', '/wp-login', '/wp-admin', '/feed', '/rss', '/tag/', '#'];

function isExcludedCategoryUrl(href: string, baseUrl: string): boolean {
  if (!href || !href.startsWith(baseUrl)) return true;
  try {
    const path = new URL(href).pathname;
    return EXCLUDED_PATH_PARTS.some((p) => path.includes(p));
  } catch {
    return true;
  }
}

async function getCategoryUrls(browser: CrawlerBrowser, baseUrl: string): Promise<string[]> {
  try {
    const page = browser.getPage();
    const links = (await page.$$eval(
      'a[href*="/category/"], a[href*="/cat/"], nav a, .menu a, .nav a, header a[href], .categories a, .category-list a',
      (els: HTMLAnchorElement[], base: string) =>
        els.map((a) => a.href).filter((h) => h && h.startsWith(base)),
      baseUrl
    )) as string[];
    const filtered = links.filter((h) => !isExcludedCategoryUrl(h, baseUrl));
    const unique = [...new Set(filtered)];
    if (unique.length > 0) return unique.slice(0, 20);
  } catch {
    // fallback
  }
  return [baseUrl];
}

function extractCategoryFromUrl(url: string): string {
  const m = url.match(/\/(category|cat)\/([^/]+)/);
  return m ? decodeURIComponent(m[2]) : 'default';
}

async function extractQrFromPage(browser: CrawlerBrowser): Promise<string[]> {
  try {
    const { createCanvas, loadImage } = await import('canvas');
    const { decodeQrFromImageData } = await import('./qr.js');
    const page = browser.getPage();
    const imgs = await page.$$('img[src*="qr"], img[alt*="二维码"]');
    const results: string[] = [];
    for (const img of imgs.slice(0, 5)) {
      try {
        const buf = await img.screenshot();
        if (buf && buf.length > 100) {
          const imgObj = await loadImage(buf as Buffer);
          const canvas = createCanvas(imgObj.width, imgObj.height);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(imgObj, 0, 0);
          const imageData = ctx.getImageData(0, 0, imgObj.width, imgObj.height);
          const decoded = decodeQrFromImageData(imageData);
          if (decoded) results.push(decoded);
        }
      } catch {
        // skip single img
      }
    }
    return results;
  } catch {
    return [];
  }
}
