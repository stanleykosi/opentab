import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '@playwright/test';

const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], 'browser console, hydration, and page errors').toEqual([]);
});

async function expectPageQuality(page: Page) {
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
  }));
  expect(overflow.width, `horizontal overflow: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(
    overflow.viewport + 1,
  );

  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ animations: 'disabled', path });
  await testInfo.attach(name, { contentType: 'image/png', path });
}

test('landing and product entry are responsive, keyboard reachable, and accessible', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Sell anywhere. Settle with certainty.' }),
  ).toBeVisible();
  await expect(page.getByText('Deterministic demo', { exact: true })).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'OpenTab home' })).toBeFocused();

  const health = await page.request.get('/api/health');
  expect(health.ok()).toBeTruthy();
  await expectPageQuality(page);
  await attachScreenshot(page, testInfo, 'landing');

  await expect(page.getByRole('link', { name: 'Open the demo tab' })).toHaveAttribute(
    'href',
    '/c/daylight-room/sunday-table',
  );
  await page.goto('/c/daylight-room/sunday-table');
  await expect(page.getByRole('heading', { name: 'Sunday Table' })).toBeVisible();
  await expect(page.locator('.buy-card__total .ot-money')).toContainText('$18.00');
  await expectPageQuality(page);
});

test('checkout shows the exact approval and blocks a duplicate after ambiguous submission', async ({
  page,
}, testInfo) => {
  await page.goto('/checkout/chk_e2e_preview?state=preview_ready&quantity=2');
  await expect(page.getByRole('heading', { name: 'Payment details' })).toBeVisible();
  await expect(page.getByText('Maximum total')).toBeVisible();
  await expect(page.locator('.payment-ledger__total')).toContainText('$36.14');
  await expect(page.locator('.payment-ledger__total')).not.toContainText('$18.14');
  await expect(page.getByRole('button', { name: /Confirm and pay/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Confirm and pay.*\$36\.00/ })).toBeVisible();
  await expectPageQuality(page);
  await attachScreenshot(page, testInfo, 'checkout-preview');

  await page.goto('/checkout/chk_e2e_unknown?state=submitted_status_unknown');
  await expect(page.getByRole('heading', { name: 'We’re confirming your payment' })).toBeVisible();
  await expect(page.getByText('Don’t pay again', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check status' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Confirm and pay/ })).toHaveCount(0);
  await expectPageQuality(page);
});

test('canonical receipt semantics distinguish paid from confirming', async ({ page }, testInfo) => {
  await page.goto('/receipt/ord_demo_7R2K9D?status=paid');
  await expect(page.getByText(/Paid and confirmed/)).toBeVisible();
  await expect(page.getByText('Valid', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Split this purchase' })).toBeVisible();
  await expectPageQuality(page);
  await attachScreenshot(page, testInfo, 'receipt-pass');

  await page.goto('/receipt/ord_demo_3F8LM2?status=confirming');
  await expect(page.getByRole('heading', { name: 'We’re confirming your payment' })).toBeVisible();
  await expect(page.getByText('Don’t submit another payment.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Split this purchase' })).toHaveCount(0);
  await expectPageQuality(page);
});

test('split creation and reimbursement preserve exact totals and private-link recovery', async ({
  page,
}, testInfo) => {
  await page.goto('/receipt/ord_demo_7R2K9D/split');
  await expect(page.getByRole('heading', { name: 'Who is paying you back?' })).toBeVisible();
  await expect(page.locator('.allocation-total')).toContainText('$18.00');
  await page.getByRole('button', { name: 'Create private links' }).click();
  await expect(page.getByRole('heading', { name: 'Your private links are ready' })).toBeVisible();
  await expect(page.getByRole('button', { name: "Copy Alex's link" })).toBeVisible();
  await expectPageQuality(page);
  await attachScreenshot(page, testInfo, 'split-links');

  await page.goto('/split/share-jo-demo');
  await expect(
    page.getByRole('heading', { name: /Sam asked you to cover part of Sunday Table/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Review exact reimbursement' }).click();
  await expect(page.locator('.payment-ledger__total')).toContainText('$6.09');
  await expect(page.getByRole('button', { name: /Confirm reimbursement of/ })).toHaveCount(1);
  await expectPageQuality(page);
});

test('merchant dashboard has equivalent table data and export', async ({ page }, testInfo) => {
  await page.goto('/merchant');
  await expect(page.getByRole('heading', { name: 'Merchant overview' })).toBeVisible();
  const exportLink = page.getByRole('link', { name: 'Export CSV' });
  await expect(exportLink).toHaveAttribute('download', 'opentab-orders.csv');
  await page.getByText('View sales as a table').click();
  await expect(page.getByRole('table', { name: 'Settled sales by day' })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1280) <= 640) {
    await expect(page.getByRole('link', { name: /Sunday Table S\. Ade · 7R2K-9D/ })).toBeVisible();
  } else {
    await expect(
      page.getByRole('table', { name: 'Recent confirmed and pending orders' }),
    ).toBeVisible();
  }
  await expectPageQuality(page);
  await attachScreenshot(page, testInfo, 'merchant-dashboard');
});

test('Judge Mode labels deterministic provenance and canonical evidence honestly', async ({
  page,
}, testInfo) => {
  await page.goto('/judge/evd_demo_7R2K9D');
  await expect(page.getByText(/DETERMINISTIC DEMO/).first()).toBeVisible();
  await expect(page.getByText('This is not live payment proof', { exact: true })).toBeVisible();
  await expect(
    page.locator('.ot-status').filter({ hasText: 'Canonical OrderPaid binding verified' }),
  ).toBeVisible();
  await expect(
    page
      .locator('.ot-evidence-row')
      .filter({ hasText: 'Confirmations observed' })
      .getByText('8', { exact: true }),
  ).toBeVisible();
  await expectPageQuality(page);
  await attachScreenshot(page, testInfo, 'judge-proof');
});
