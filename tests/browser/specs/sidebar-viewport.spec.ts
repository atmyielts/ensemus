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
  for (const colorScheme of javaScriptEnabled ? (['light', 'dark'] as const) : (['light'] as const))
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
        if (javaScriptEnabled) {
          if (colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
          else await expect(page.locator('html')).not.toHaveClass(/dark/);
        }
        await expect(
          main.getByRole('link', { name: path === base ? 'Home' : 'Work', exact: true }),
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
        const frame = await inner.evaluate((element) => ({
          client: element.clientHeight,
          scroll: element.scrollHeight,
          children: Array.from(element.children, (child) => ({
            className: child.className,
            top: child.getBoundingClientRect().top,
            height: child.getBoundingClientRect().height,
            scroll: child.scrollHeight,
            overflow: getComputedStyle(child).overflowY,
          })),
        }));
        expect(frame.scroll - frame.client, JSON.stringify(frame)).toBeLessThanOrEqual(1);
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
        const last = main.getByRole('link').last();
        await expect(last).toHaveText('Help');
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
      await page.setViewportSize({ width: 390, height: 720 });
      await page.goto(base);
      const menu = page.locator('details.mobile-navigation'),
        summary = menu.locator(':scope > summary'),
        signOut = menu.getByRole('button', { name: 'Sign out', exact: true });
      await expect(page.locator('.sidebar')).toBeHidden();
      await expect(signOut).toBeHidden();
      await insideViewport(page, summary);
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(menu).toHaveAttribute('open', '');
      await expect(
        page.getByRole('navigation', { name: 'Mobile main', exact: true }),
      ).toBeVisible();
      await insideViewport(page, signOut);
      const menuScroll = menu.locator('.mobile-navigation-scroll');
      const footerBeforeScroll = await signOut.boundingBox();
      await menu.getByRole('link', { name: 'Help', exact: true }).focus();
      expect(await menuScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await signOut.boundingBox()).toEqual(footerBeforeScroll);
      await insideViewport(page, signOut);
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
      if (javaScriptEnabled) {
        await signOut.focus();
        await page.keyboard.press('Escape');
      } else {
        await summary.focus();
        await page.keyboard.press('Enter');
      }
      await expect(menu).not.toHaveAttribute('open', '');
      await expect(signOut).toBeHidden();
      await expect(summary).toBeFocused();
    });

test('the tablet sidebar opens up the work table and keeps the preference after reload', async ({
  open,
  world,
}) => {
  const page = await open(world.alice, { width: 768, height: 820 });
  const work = `/o/${world.organization}/work`;
  await page.goto(work);
  const sidebar = page.getByRole('complementary', { name: 'Workspace sidebar' });
  const hide = page.getByRole('button', { name: 'Collapse sidebar' });
  const show = page.getByRole('button', { name: 'Expand sidebar' });
  const tableHead = page.getByRole('table').locator('thead');
  await expect(sidebar).toBeVisible();
  await expect(tableHead).toHaveCSS('position', 'absolute');
  await hide.focus();
  await page.keyboard.press('Enter');
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS('width', '48px');
  await expect(sidebar.getByRole('link', { name: 'Work', exact: true })).toBeVisible();
  await expect(show).toBeFocused();
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(tableHead).toHaveCSS('position', 'static');
  const main = page.getByRole('main');
  expect(
    await main.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.reload();
  await expect(show).toBeVisible();
  await expect(sidebar).toHaveCSS('width', '48px');
  await expect(tableHead).toHaveCSS('position', 'static');
  await show.click();
  await expect(sidebar).toBeVisible();
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  await expect(tableHead).toHaveCSS('position', 'absolute');
});

test('the desktop navigation still works without scripts after a collapsed preference', async ({
  open,
  world,
}) => {
  const page = await open(world.alice, { width: 1024, javaScriptEnabled: false });
  const base = `/o/${world.organization}`;
  await page.goto(base);
  await page
    .context()
    .addCookies([{ name: 'sidebar_state', value: 'false', url: new URL(page.url()).origin }]);
  await page.goto(base);
  await expect(page.getByRole('button', { name: /^(Collapse|Expand) sidebar$/ })).toHaveCount(0);
  await page
    .getByRole('navigation', { name: 'Main', exact: true })
    .getByRole('link', { name: 'Work', exact: true })
    .click();
  await expect(page).toHaveURL(`${base}/work`);
});
