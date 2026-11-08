// Real long profile + actual Home/Work expansion. Authored layout guard; run against the built app
// before calling the sidebar rendered/keyboard/mobile acceptance complete.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { createOrganization } from '../../helpers/forms';
import { generatedHttpPerson } from '../../helpers/sso-stack-fixture';
import { axeFindings, sidewaysOverflow } from '../support/look';
async function insideViewport(page: Page, target: Locator) {
  const box = await target.boundingBox(),
    size = page.viewportSize();
  expect(box).not.toBeNull();
  expect(size).not.toBeNull();
  if (!box || !size) throw new Error('GENERATED_LAYOUT_BOX_MISSING');
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
}
for (const javaScriptEnabled of [true, false])
  for (const colorScheme of ['light', 'dark'] as const)
    test(`sidebar keeps account controls visible at720px with long profile (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'}, ${colorScheme})`, async ({
      open,
    }) => {
      const person = await generatedHttpPerson(
          'generated-long-workspace-domain.navigation-subdivision.example.invalid',
          'Generated Account Holder With A Deliberately Long Full Name For The Sidebar',
        ),
        organization = await createOrganization(
          person,
          'Generated workspace with a deliberately long company name for sidebar layout',
        ),
        page = await open(person, { javaScriptEnabled, width: 1440, height: 720, colorScheme }),
        base = `/o/${organization}`;
      for (const path of [base, `${base}/work`]) {
        await page.goto(path);
        const sidebar = page.locator('.sidebar'),
          inner = sidebar.locator('.sidebar-inner'),
          navigation = sidebar.locator('.desktop-navigation'),
          main = page.getByRole('navigation', { name: 'Main', exact: true }),
          name = sidebar.locator('.account-name'),
          email = sidebar.locator('.account-email'),
          signOut = sidebar.getByRole('button', { name: 'Sign out', exact: true });
        await expect(
          main.getByRole('link', { name: path === base ? 'Overview' : 'All work', exact: true }),
        ).toBeVisible();
        await insideViewport(page, sidebar.locator('.workspace-brand'));
        await insideViewport(page, sidebar.locator('.sidebar-end'));
        await insideViewport(page, signOut);
        await expect(name).toHaveText(person.name);
        await expect(email).toHaveText(person.email);
        await expect(email).toHaveAttribute('title', person.email);
        const metrics = await navigation.evaluate((element) => ({
          client: element.clientHeight,
          scroll: element.scrollHeight,
          overflow: getComputedStyle(element).overflowY,
        }));
        expect(metrics.client).toBeGreaterThan(100);
        expect(metrics.scroll).toBeGreaterThan(metrics.client);
        expect(metrics.overflow).toBe('auto');
        expect(
          await inner.evaluate((element) => element.scrollHeight - element.clientHeight),
        ).toBeLessThanOrEqual(1);
        const text = await email.evaluate((element) => ({
          whiteSpace: getComputedStyle(element).whiteSpace,
          overflow: getComputedStyle(element).overflow,
          textOverflow: getComputedStyle(element).textOverflow,
          width: element.clientWidth,
          scroll: element.scrollWidth,
        }));
        expect(text).toMatchObject({
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        });
        expect(text.scroll).toBeGreaterThan(text.width);
        // Native focus scrolls the navigation, while its siblings stay in place. Tab then reaches the
        // real account and Sign out controls without scrolling the whole sidebar or changing the URL.
        const last = main.getByRole('link', { name: 'Account and support', exact: true });
        await last.focus();
        await expect(last).toBeFocused();
        await insideViewport(page, last);
        const navBox = await navigation.boundingBox(),
          linkBox = await last.boundingBox();
        if (!navBox || !linkBox) throw new Error('GENERATED_NAVIGATION_BOX_MISSING');
        expect(linkBox.y).toBeGreaterThanOrEqual(navBox.y - 1);
        expect(linkBox.y + linkBox.height).toBeLessThanOrEqual(navBox.y + navBox.height + 1);
        expect(await navigation.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await insideViewport(page, sidebar.locator('.workspace-brand'));
        await insideViewport(page, signOut);
        await page.keyboard.press('Tab');
        await expect(name).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(signOut).toBeFocused();
        await insideViewport(page, signOut);
        await page.keyboard.press('Shift+Tab');
        await expect(name).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(last).toBeFocused();
        expect(new URL(page.url()).pathname).toBe(path);
        expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
      }
      if (javaScriptEnabled) expect(await axeFindings(page)).toEqual([]);
      // The mobile bar returns to content height; desktop viewport locking must not hide its menu.
      await page.setViewportSize({ width: 390, height: 720 });
      await page.goto(base);
      const sidebar = page.locator('.sidebar'),
        menu = sidebar.locator('.mobile-navigation'),
        summary = menu.locator(':scope > summary');
      await expect(sidebar.locator('.desktop-navigation')).toBeHidden();
      await insideViewport(page, sidebar.getByRole('button', { name: 'Sign out', exact: true }));
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(menu).toHaveAttribute('open', '');
      await expect(
        page.getByRole('navigation', { name: 'Mobile main', exact: true }),
      ).toBeVisible();
      await insideViewport(page, sidebar.getByRole('button', { name: 'Sign out', exact: true }));
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(menu).not.toHaveAttribute('open', '');
      await insideViewport(page, sidebar.getByRole('button', { name: 'Sign out', exact: true }));
    });
