import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

const errors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const captured: string[] = [];
  errors.set(page, captured);
  page.on('console', (message) => {
    if (message.type() === 'error') captured.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => captured.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page) ?? [], 'browser console, hydration, and page errors').toEqual([]);
});

async function expectAxeClean(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
}

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(
    dimensions.documentWidth,
    `horizontal overflow: ${JSON.stringify(dimensions)}`,
  ).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

test('secondary customer and merchant routes remain accessible', async ({ page }) => {
  const routes = [
    '/status',
    '/account/orders',
    '/auth/callback?outcome=expired',
    '/receipt/ord_demo_9AA2V1?status=partial',
    '/split/invalid',
    '/merchant/products/new',
    '/merchant/balance',
    '/merchant/settings',
  ];

  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator('h1')).toHaveCount(1);
    await expectNoPageOverflow(page);
    await expectAxeClean(page);
  }
});

test('360px customer checkout keeps navigation and practical touch targets usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/c/daylight-room/sunday-table');

  await expect(page.getByRole('link', { name: 'My passes' })).toBeVisible();
  const targetNames = [
    'OpenTab home',
    'My passes',
    'For merchants',
    'Decrease quantity',
    'Increase quantity',
  ];
  for (const name of targetNames) {
    const box = await page
      .getByRole(name.includes('quantity') ? 'button' : 'link', { name })
      .boundingBox();
    expect(box, `${name} target is visible`).not.toBeNull();
    expect(box?.width ?? 0, `${name} target width`).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0, `${name} target height`).toBeGreaterThanOrEqual(44);
  }

  await expectNoPageOverflow(page);
  await expectAxeClean(page);
});

test('product review traps focus, restores it, and focuses the first invalid field', async ({
  page,
}) => {
  await page.goto('/merchant/products/new');
  const reviewButton = page.getByRole('button', { name: 'Review product' });

  await reviewButton.click();
  await expect(page.getByRole('checkbox')).toBeFocused();
  await page.getByRole('checkbox').check();
  await reviewButton.click();

  const dialog = page.getByRole('dialog', { name: 'Register Golden Hour Supper?' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(reviewButton).toBeFocused();
});

test('anonymous product route stays inside the initial JavaScript budget', async ({ page }) => {
  await page.goto('/c/daylight-room/sunday-table');
  await page.waitForLoadState('networkidle');

  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter(
        (entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming,
      )
      .filter((entry) => entry.name.includes('.js'))
      .map((entry) => ({ encodedBodySize: entry.encodedBodySize, name: entry.name })),
  );
  const transferredJavaScript = resources.reduce(
    (total, resource) => total + resource.encodedBodySize,
    0,
  );
  expect(transferredJavaScript).toBeLessThanOrEqual(180 * 1024);

  const vendorSdkSignatures = await page.evaluate(
    async (names) => {
      const sources = await Promise.all(
        names.map(async (name) => await (await fetch(name)).text()),
      );
      return sources.filter((source) =>
        /auth\.magic\.link|universal-rpc-proxy\.particle|loginWithMagicLink|createUniversalAccount|useEIP7702/.test(
          source,
        ),
      ).length;
    },
    resources.map((resource) => resource.name),
  );
  expect(vendorSdkSignatures).toBe(0);
});

test('reduced motion and text spacing keep critical checkout content operable', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/checkout/chk_quality_motion?state=submitted_status_unknown');
  await expect(page.getByRole('heading', { name: 'We’re confirming your payment' })).toBeVisible();
  const motion = await page.evaluate(() => ({
    animation: getComputedStyle(document.querySelector('.ot-timeline__node') as Element)
      .animationName,
    scroll: getComputedStyle(document.documentElement).scrollBehavior,
  }));
  expect(motion).toEqual({ animation: 'none', scroll: 'auto' });

  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto('/c/daylight-room/sunday-table');
  await page.addStyleTag({
    content:
      '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-block-end: 2em !important; }',
  });
  await expectNoPageOverflow(page);
});
