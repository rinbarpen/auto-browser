import { CrawlerBrowser } from '../crawler/browser.js';
import { findById } from '../storage/db.js';

export async function saveToBaiduPan(resourceId: string, targetPath?: string): Promise<{ success: boolean; error?: string }> {
  const resource = findById(resourceId);
  if (!resource) return { success: false, error: 'Resource not found' };

  const link = resource.links[0];
  if (!link?.url) return { success: false, error: 'No link' };

  if (!link.url.includes('pan.baidu.com')) {
    return { success: false, error: 'Only Baidu Pan links supported' };
  }

  const browser = new CrawlerBrowser({ headless: true, profile: process.env.BAIDU_PAN_PROFILE });
  try {
    await browser.launch();
    const page = browser.getPage();

    await browser.navigate(link.url);
    await browser.wait(3000);

    const extractInput = await page.$('input[placeholder*="提取码"], input[name="pwd"], input#accessCode');
    if (extractInput && link.extractCode) {
      await extractInput.fill(link.extractCode);
      await browser.wait(500);
      const submitBtn = await page.$('button:has-text("提取"), .nd-main-layout-panel-footer button');
      if (submitBtn) await submitBtn.click();
      await browser.wait(3000);
    }

    const saveBtn = await page.$('a:has-text("保存"), button:has-text("保存到网盘"), .nd-main-layout-panel-footer a');
    if (!saveBtn) {
      await browser.close();
      return { success: false, error: 'Save button not found - ensure logged into Baidu Pan' };
    }

    await saveBtn.click();
    await browser.wait(2000);

    if (targetPath) {
      const pathInput = await page.$('input[placeholder*="路径"], input[name="path"]');
      if (pathInput) await pathInput.fill(targetPath);
    }

    const confirmBtn = await page.$('button:has-text("确定"), button:has-text("保存"), .dialog-footer button');
    if (confirmBtn) await confirmBtn.click();

    await browser.wait(3000);
    await browser.close();
    return { success: true };
  } catch (err) {
    await browser.close();
    return { success: false, error: String(err) };
  }
}
