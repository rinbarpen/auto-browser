/**
 * Debug script: navigate to hxcy.top and capture page state during Cloudflare challenge.
 * Usage: npx tsx src/debug-challenge.ts
 */
import { chromium } from 'playwright';

async function main() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:15732';
  const chromePath = process.env.HXCY_CHROME_PATH || '/usr/bin/google-chrome';

  console.log('Launching browser with proxy:', proxyUrl);
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    proxy: { server: proxyUrl },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Collect CF-related request URLs
  const cfUrls: string[] = [];
  page.on('request', (req: any) => {
    const url = req.url();
    if (url.includes('challenges.cloudflare.com') || url.includes('turnstile') || url.includes('cdn-cgi/challenge')) {
      cfUrls.push('[REQ] ' + url);
    }
  });
  page.on('response', async (res: any) => {
    const url = res.url();
    if (url.includes('challenges.cloudflare.com') || url.includes('turnstile') || url.includes('cdn-cgi/challenge')) {
      cfUrls.push('[RES] ' + url + ' ' + res.status());
    }
  });

  try {
    await page.goto('https://hxcy.top', { timeout: 30_000, waitUntil: 'domcontentloaded' });
  } catch {
    console.log('Navigation timed out (expected)');
  }

  await page.waitForTimeout(5000);

  console.log('\n=== CF Requests/Responses ===');
  for (const u of cfUrls.slice(0, 20)) console.log(u);

  console.log('\n=== Current URL ===');
  console.log(page.url());

  console.log('\n=== Page Title ===');
  console.log(await page.title());

  console.log('\n=== Frame URLs ===');
  for (const f of page.frames()) {
    console.log(' ', f.url());
  }

  console.log('\n=== Cookies ===');
  const cookies = await context.cookies();
  for (const c of cookies) {
    console.log(`  ${c.name}: ${c.value.slice(0, 50)}`);
  }

  console.log('\n=== HTML sitekey search ===');
  const html = await page.content();

  // Print lines containing relevant keywords
  const lines = html.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes('sitekey') || line.includes('cf_chl') || line.includes('turnstile')) {
      console.log('  ', line.trim().slice(0, 400));
    }
  }

  // Try broader sitekey pattern
  const broadPattern = /[sS]ite[kK]ey[=:]\s*['"]?([A-Za-z0-9_-]{20,})['"]?/;
  const m = html.match(broadPattern);
  if (m) {
    console.log('\n>>> FOUND SITEKEY:', m[1]);
  } else {
    console.log('\n>>> No sitekey found in main HTML');
  }

  await browser.close();
}

main().catch(console.error);
