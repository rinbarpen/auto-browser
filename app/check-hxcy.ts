import { CrawlerBrowser } from './src/crawler/browser.js';
import * as fs from 'fs';

async function main() {
  const browser = new CrawlerBrowser({ headless: true, profile: '/tmp/hxcy-profile' });
  try {
    await browser.launch();
    console.log('Navigating to hxcy.top...');
    const page = await browser.navigate('https://hxcy.top');
    await browser.wait(5000);
    const url = page.url();
    console.log(`Current URL: ${url}`);
    const title = await page.title();
    console.log(`Title: "${title}"`);
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.substring(0, 2000) : 'NO BODY');
    console.log('--- Body text ---');
    console.log(bodyText);
    console.log('--- End ---');
    await page.screenshot({ path: '/tmp/hxcy-screenshot.png', fullPage: true });
    console.log('Screenshot saved');
  } finally {
    await browser.close();
  }
}
main().catch(console.error);
