import { createRequire } from 'node:module';
const require = createRequire('/opt/ad-research/apps/web/package.json');
const { chromium } = require('playwright');
if (typeof process.getuid !== 'function' || process.getuid() === 0) throw new Error('NON_ROOT_REQUIRED');
const browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: true });
try {
  const page = await browser.newPage();
  await page.setContent('<title>Container browser check</title><main>ready</main>');
  if (await page.locator('main').textContent() !== 'ready') throw new Error('BROWSER_CHECK_FAILED');
  console.log(JSON.stringify({ status: 'BROWSER_SANDBOX_CHECK_PASSED', uid: process.getuid(), playwright: require('playwright/package.json').version, chromium: browser.version(), networkUsed: false }));
} finally { await browser.close(); }
