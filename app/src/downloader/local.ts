import { CrawlerBrowser } from '../crawler/browser.js';
import { findById } from '../storage/db.js';
import path from 'node:path';
import fs from 'node:fs';

export async function downloadToLocal(resourceId: string, outputDir: string): Promise<{ success: boolean; path?: string; error?: string }> {
  const resource = findById(resourceId);
  if (!resource) return { success: false, error: 'Resource not found' };

  const link = resource.links[0];
  if (!link?.url) return { success: false, error: 'No download link' };

  if (!link.url.includes('pan.baidu.com')) {
    return { success: false, error: 'Only Baidu Pan links supported for auto-download' };
  }

  const browser = new CrawlerBrowser({ headless: true });
  try {
    await browser.launch();
    const page = browser.getPage();

    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });

    await browser.navigate(link.url);
    await browser.wait(3000);

    const extractInput = await page.$('input[placeholder*="提取码"], input[name="pwd"], input#accessCode');
    if (extractInput && link.extractCode) {
      await extractInput.fill(link.extractCode);
      await browser.wait(500);
      const submitBtn = await page.$('button:has-text("提取"), .nd-main-layout-panel-footer button, a.n-button');
      if (submitBtn) await submitBtn.click();
      await browser.wait(3000);
    }

    const downloadBtn = await page.$('a:has-text("下载"), button:has-text("下载"), .nd-main-layout-panel-footer a');
    if (downloadBtn) {
      await downloadBtn.click();
    } else {
      await browser.close();
      return { success: false, error: 'Download button not found' };
    }

    const download = await downloadPromise;
    const dir = path.resolve(outputDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const savePath = path.join(dir, download.suggestedFilename());
    await download.saveAs(savePath);
    await browser.close();
    return { success: true, path: savePath };
  } catch (err) {
    await browser.close();
    return { success: false, error: String(err) };
  }
}
