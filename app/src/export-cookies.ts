/**
 * Cookie export tool with auto-detection.
 *
 * Opens a headed browser on DISPLAY=:0, navigates to hxcy.top,
 * then monitors cookies every 3 seconds. When cf_clearance appears
 * (meaning the Cloudflare challenge was solved), saves cookies
 * automatically. Also takes periodic screenshots for progress tracking.
 *
 * Usage: DISPLAY=:0 npx tsx src/export-cookies.ts
 */
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function exportCookies(): Promise<void> {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:15732';
  const chromePath = process.env.HXCY_CHROME_PATH || '/usr/bin/google-chrome';

  console.log('=== Cookie Export Tool (auto-detect) ===');
  console.log('Proxy:', proxyUrl);
  console.log('Chrome:', chromePath);
  console.log('Waiting for Cloudflare challenge to be solved on display :0...');
  console.log('');

  const browser = await chromium.launch({
    headless: false,
    executablePath: chromePath,
    proxy: { server: proxyUrl },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-CN',
  });

  const page = await context.newPage();

  try {
    await page.goto('https://hxcy.top', { timeout: 30_000, waitUntil: 'domcontentloaded' });
  } catch {
    // expected — challenge will block navigation
  }

  const cookiePath = path.resolve('./data/cookies.json');
  fs.mkdirSync(path.dirname(cookiePath), { recursive: true });

  // Monitor cookies every 3 seconds
  const maxAttempts = 200; // ~10 minutes
  for (let i = 0; i < maxAttempts; i++) {
    await page.waitForTimeout(3000);

    const cookies = await context.cookies();
    const clearance = cookies.find((c) => c.name === 'cf_clearance');

    // Also check if we've navigated past the challenge
    const currentUrl = page.url();
    const title = await page.title().catch(() => '');
    const isPastChallenge =
      !title.toLowerCase().includes('just a moment') &&
      !title.includes('请稍候') &&
      !currentUrl.includes('cdn-cgi');

    if (clearance && isPastChallenge) {
      console.log('✓ Challenge solved! cf_clearance obtained.');
      console.log('  Title:', title);
      console.log('  URL:', currentUrl);

      // Save cookies
      fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2), 'utf-8');
      console.log(`  Cookies saved (${cookies.length} total)`);
      console.log(`  cf_clearance expires: ${new Date(clearance.expires * 1000).toISOString()}`);
      await browser.close();
      console.log('Done. You can now run the crawler with HXCY_COOKIES enabled.');
      return;
    }

    // Progress log every 15 seconds
    if (i > 0 && i % 5 === 0) {
      const cfCookies = cookies.filter((c) => c.name.includes('cf')).map((c) => c.name).join(', ');
      console.log(`  [${i * 3}s] title="${title}" cookies=[${cfCookies}]${clearance ? ' HAS_CLEARANCE' : ''}`);
    }
  }

  console.log('Timeout reached. Challenge may not have been solved.');
  console.log('Taking final screenshot for debugging...');
  try {
    const buf = await page.screenshot();
    const screenshotPath = path.resolve('./data/challenge-debug.png');
    fs.writeFileSync(screenshotPath, buf);
    console.log('Screenshot saved to', screenshotPath);
  } catch {
    // ignore
  }

  await browser.close();
}

exportCookies().catch(console.error);
