// DOC-01, UX-11: the Help pages in a real browser. axe at WCAG 2.2 AA in both themes and at both widths,
// the keyboard alone, and JavaScript off, because someone who cannot sign in may have nothing else. The
// tests of a written page skip, and say so, while the compiled list is empty.
import type { Page } from '@playwright/test';
import { GUIDE_PAGES } from '../../../apps/web/src/generated/guides';
import { expect, test } from '../support/fixtures';
import { axeFindings, saveLook, sidewaysOverflow, THEMES, WIDTHS } from '../support/look';

// The same default as compose.yaml.
const MODE = (process.env.ENSEMUS_MODE ?? 'sovereign') as 'cloud' | 'byom' | 'sovereign';
const HERE = GUIDE_PAGES.filter((page) => page.modes.includes(MODE));
const first = HERE[0];
const NO_PAGES = 'No guide is compiled in yet, so there is no page to open.';

/** Every theme and width of the page as it stands, and everything found, so one failure shows them all. */
async function scanEverywhere(page: Page, name: string) {
  const problems: Record<string, unknown> = {};
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
      const label = `${theme}-${width}`;
      const findings = await axeFindings(page);
      if (findings.length) problems[label] = findings;
      const overflow = await sidewaysOverflow(page);
      if (overflow > 0) problems[`${label} overflow`] = `${overflow}px sideways`;
      await saveLook(page, name, label);
    }
  }
  return problems;
}

/** The name of what has focus, once it can be seen to have it. */
const focusedLink = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return null;
    const style = getComputedStyle(element);
    return {
      name: element.textContent?.trim() ?? '',
      visible:
        element.matches(':focus-visible') &&
        style.outlineStyle !== 'none' &&
        Number.parseFloat(style.outlineWidth) >= 2,
    };
  });

/** Presses Tab until a link of this name has focus. Reaching it this way is the test. */
async function tabTo(page: Page, name: string, limit = 20) {
  for (let presses = 0; presses < limit; presses += 1) {
    await page.keyboard.press('Tab');
    const stop = await focusedLink(page);
    if (stop?.name === name) {
      expect(stop.visible, `${name} shows it has focus`).toBe(true);
      return;
    }
  }
  throw new Error(`${name} could not be reached with the keyboard in ${limit} presses`);
}

test.describe('axe', () => {
  test('the index has no violations in either theme, at either width', async ({ open }) => {
    const page = await open(null);
    const response = await page.goto('/help');
    // A clean scan says nothing unless it is of this page. A 404 and the sign-in page pass axe as well.
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
    expect(await scanEverywhere(page, 'help-index')).toEqual({});
  });

  test('a guide has no violations in either theme, at either width', async ({ open }) => {
    test.skip(!first, NO_PAGES);
    const page = await open(null);
    const response = await page.goto(`/help/${first?.slug}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: first?.title })).toBeVisible();
    expect(await scanEverywhere(page, 'help-page')).toEqual({});
  });

  test('every guide has no violations, in the plainest setting', async ({ open }) => {
    test.skip(!first, NO_PAGES);
    test.setTimeout(300_000);
    const page = await open(null);
    const problems: Record<string, unknown> = {};
    for (const { slug } of HERE) {
      const response = await page.goto(`/help/${slug}`);
      expect(response?.status(), slug).toBe(200);
      const findings = await axeFindings(page);
      if (findings.length) problems[slug] = findings;
      const overflow = await sidewaysOverflow(page);
      if (overflow > 0) problems[`${slug} overflow`] = `${overflow}px sideways`;
    }
    expect(problems).toEqual({});
  });

  test('the 404 for a page that does not exist has no violations', async ({ open }) => {
    const page = await open(null);
    const response = await page.goto('/help/never-written');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    expect(await axeFindings(page)).toEqual([]);
  });
});

test.describe('the keyboard', () => {
  test('reaches Help from the sign-in page, and arrives', async ({ open }) => {
    const page = await open(null);
    await page.goto('/sign-in');
    await tabTo(page, 'Help');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
  });

  test('reaches Help from the navigation of an organization', async ({ open, world }) => {
    const page = await open(world.alice);
    await page.goto(`/o/${world.organization}`);
    await tabTo(page, 'Help');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
  });

  test('moves from the index to a guide and back', async ({ open }) => {
    test.skip(!first, NO_PAGES);
    if (!first) return;
    const page = await open(null);
    await page.goto('/help');
    await tabTo(page, first.title, 200);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: first.title })).toBeVisible();
    await tabTo(page, 'All help pages');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/help$/);
  });
});

test.describe('with JavaScript off', () => {
  const off = { javaScriptEnabled: false };

  test('the index reads the same', async ({ open }) => {
    const page = await open(null, off);
    const response = await page.goto('/help');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
    if (HERE.length === 0) await expect(page.getByText('has no help pages yet')).toBeVisible();
  });

  test('a link is followed, and a guide reads the same', async ({ open }) => {
    test.skip(!first, NO_PAGES);
    if (!first) return;
    const page = await open(null, off);
    await page.goto('/help');
    await page.getByRole('link', { name: first.title, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: first.title })).toBeVisible();
    if (first.status === 'written_untested') {
      await expect(page.getByText('Not yet tested end to end.')).toBeVisible();
    }
    await page.getByRole('link', { name: 'All help pages' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
  });

  test('a page that does not exist still answers 404', async ({ open }) => {
    const page = await open(null, off);
    const response = await page.goto('/help/never-written');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
