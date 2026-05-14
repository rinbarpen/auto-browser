import type { CrawlerBrowser } from './browser.js';
import { config } from '../config.js';

const LOGIN_SELECTORS = {
  username: [
    'input[name="username"]',
    'input[name="user"]',
    'input[type="text"]',
    'input[placeholder*="用户"]',
    'input[placeholder*="账号"]',
    'input#username',
    'input#user',
  ],
  password: [
    'input[name="password"]',
    'input[name="pass"]',
    'input[type="password"]',
    'input[placeholder*="密码"]',
    'input#password',
    'input#pass',
  ],
  submit: [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("登录")',
    'button:has-text("登入")',
    'a:has-text("登录")',
    '.login-btn',
    '#login-btn',
    'form button',
    'form input[type="submit"]',
  ],
};

export async function login(browser: CrawlerBrowser): Promise<boolean> {
  const { baseUrl, username, password } = config.hxcy;
  const urlsToTry = [
    baseUrl,
    baseUrl.endsWith('/') ? `${baseUrl}login` : `${baseUrl}/login`,
    baseUrl.endsWith('/') ? `${baseUrl}wp-login.php` : `${baseUrl}/wp-login.php`,
  ];

  for (const url of urlsToTry) {
    await browser.navigate(url);
    await browser.wait(2000);

    const page = browser.getPage();

    const trySelector = async (selectors: string[]): Promise<string | null> => {
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            const isVisible = await el.isVisible();
            if (isVisible) return sel;
          }
        } catch {
          // skip
        }
      }
      return null;
    };

    const usernameSel = await trySelector(LOGIN_SELECTORS.username);
    const passwordSel = await trySelector(LOGIN_SELECTORS.password);
    const submitSel = await trySelector(LOGIN_SELECTORS.submit);

    if (usernameSel && passwordSel) {
      await browser.fill(usernameSel, username);
      await browser.wait(300);
      await browser.fill(passwordSel, password);
      await browser.wait(300);

      if (submitSel) {
        await browser.click(submitSel);
      } else {
        await page.keyboard.press('Enter');
      }

      await browser.wait(3000);
      const url = browser.getUrl();
      if (!url.includes('/login')) return true;
      continue;
    }

    const snapshot = await browser.getSnapshot({ interactive: true });
    const refs = snapshot.refs as Record<string, { role: string; name?: string }>;
    const refEntries = Object.entries(refs);

    const userRef = refEntries.find(
    ([, r]) =>
      (r.role === 'textbox' || r.role === 'searchbox') &&
      (r.name?.includes('用户') || r.name?.includes('账号') || r.name?.includes('name'))
    )?.[0];
    const passRef = refEntries.find(
    ([, r]) => r.role === 'textbox' && (r.name?.includes('密码') || r.name?.includes('password'))
    )?.[0];
    const submitRef = refEntries.find(
    ([, r]) =>
      r.role === 'button' &&
      (r.name?.includes('登录') || r.name?.includes('登入') || r.name?.includes('submit'))
    )?.[0];

    if (userRef && passRef) {
      await browser.fill(`@${userRef}`, username);
      await browser.wait(300);
      await browser.fill(`@${passRef}`, password);
      await browser.wait(300);
      if (submitRef) {
        await browser.click(`@${submitRef}`);
      } else {
        await page.keyboard.press('Enter');
      }
      await browser.wait(3000);
      const url = browser.getUrl();
      if (!url.includes('/login')) return true;
    }
  }

  return false;
}
