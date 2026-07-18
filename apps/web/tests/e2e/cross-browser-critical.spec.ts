import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
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

async function expectPortablePage(page: Page) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);

  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
}

test('public landing and product entry remain portable', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Sell anywhere. Settle with certainty.' }),
  ).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await expectPortablePage(page);

  await page.goto('/c/daylight-room/sunday-table');
  await expect(page.getByRole('heading', { name: 'Sunday Table' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Decrease quantity' })).toBeDisabled();
  await page.getByRole('button', { name: 'Increase quantity' }).click();
  await expect(page.locator('.buy-card__total .ot-money')).toContainText('$36.00');
  await expectPortablePage(page);
});

test('authentication shell preserves validation and focus', async ({ page }) => {
  await page.goto('/checkout/chk_cross_browser');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Continue to checkout' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue with email' }).click();

  const email = page.getByRole('textbox', { name: /Email address/ });
  await email.fill('not-an-email');
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toBeFocused();
  await expect(page.locator('#auth-email-error')).toContainText('Enter a complete email address.');
  await expectPortablePage(page);
});
