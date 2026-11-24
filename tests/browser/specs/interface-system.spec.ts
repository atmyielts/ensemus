// Shared design contract: real pages, permissions, keyboard/native navigation, responsive overflow
// and WCAG checks. Screenshots are evidence for human review, not a claim of visual acceptance.
import { expect, test } from '../support/fixtures';
import { axeFindings, saveLook, sidewaysOverflow } from '../support/look';
import { createOrganization, signUp } from '../../helpers/forms';

for (const theme of ['light', 'dark'] as const)
  for (const width of [320, 768, 1024, 1440]) {
    test(`shared interface ${theme} at ${width}px`, async ({ open, world }) => {
      const page = await open(world.alice, { colorScheme: theme, width, height: 1000 });
      const base = `/o/${world.organization}`;
      const destinations = [
        ['home', base],
        ['work-list', `${base}/work`],
        ['long-work-detail', `${base}/work/${world.work.long}`],
        ['approvals', `${base}/approvals`],
        ['approval', `${base}/approvals/${world.approvals.holding}`],
        ['administration', `${base}/settings`],
        ['model-connections', `${base}/settings/models`],
        ['usage-and-budgets', `${base}/settings/budgets`],
        ['studio', `${base}/studio`],
      ] as const;
      for (const [label, path] of destinations) {
        const response = await page.goto(path);
        expect(response?.status(), label).toBe(200);
        await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveCount(1);
        expect(await sidewaysOverflow(page), label).toBeLessThanOrEqual(1);
        expect(
          await page
            .locator(width < 768 ? 'main' : '.content')
            .evaluate((pane) => pane.scrollWidth - pane.clientWidth),
          label,
        ).toBeLessThanOrEqual(1);
        if (label === 'work-list') {
          const tableContainer = page.locator('[data-slot="table-container"]');
          expect(
            await tableContainer.evaluate((table) => table.scrollWidth - table.clientWidth),
            'Work table, including the long work title',
          ).toBeLessThanOrEqual(1);
        }
        expect(await axeFindings(page), label).toEqual([]);
        await saveLook(page, `interface-${theme}-${width}`, label);
      }
      if (width < 768) {
        const shortcuts = page.getByRole('navigation', { name: 'Workspace shortcuts' });
        await expect(shortcuts.getByRole('link')).toHaveCount(4);
        await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeHidden();
        await page.goto(base);
        const deadline = page.locator('.queue-row time').first();
        await expect(deadline).toBeVisible();
        await expect(deadline).toHaveAttribute('datetime', /T/);
        const [viewport, bar] = await Promise.all([
          page.getByRole('main').boundingBox(),
          shortcuts.boundingBox(),
        ]);
        expect(viewport!.y + viewport!.height).toBeLessThanOrEqual(bar!.y);
        const approvals = shortcuts.getByRole('link', { name: /Approvals/ });
        expect((await approvals.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        await approvals.click();
        await expect(approvals).toHaveAttribute('aria-current', 'page');
        await expect
          .poll(() =>
            approvals.evaluate((link) => {
              const expected = getComputedStyle(link).getPropertyValue('--accent').trim();
              const probe = document.createElement('span');
              probe.style.color = expected;
              link.appendChild(probe);
              const activeColor = getComputedStyle(probe).color;
              probe.remove();
              return getComputedStyle(link).backgroundColor === activeColor;
            }),
          )
          .toBe(true);
        const menu = page.locator('details.mobile-navigation');
        await menu.locator('summary').focus();
        await page.keyboard.press('Enter');
        await expect(menu).toHaveAttribute('open', '');
        const nav = page.getByRole('navigation', { name: 'Mobile main', exact: true });
        await nav.getByRole('link', { name: 'Administration', exact: true }).click();
        await expect(
          page.getByRole('heading', { name: 'Administration', exact: true }),
        ).toBeVisible();
        await expect(menu).not.toHaveAttribute('open', '');
        expect(await axeFindings(page)).toEqual([]);
      } else {
        await expect(page.getByRole('navigation', { name: 'Workspace shortcuts' })).toBeHidden();
      }
    });
  }

test('the grouped workspace navigation works without JavaScript on a narrow screen', async ({
  open,
  world,
}) => {
  const page = await open(world.alice, { javaScriptEnabled: false, width: 320, height: 900 });
  const base = `/o/${world.organization}`;
  await page.goto(base);
  const shortcuts = page.getByRole('navigation', { name: 'Workspace shortcuts' });
  await expect(shortcuts.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await shortcuts.getByRole('link', { name: 'Work', exact: true }).click();
  await expect(page).toHaveURL(`${base}/work`);
  const menu = page.locator('details.mobile-navigation');
  await menu.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('open', '');
  await menu.getByRole('link', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Models', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
  await saveLook(page, 'interface-no-javascript', 'models-320');
});

test('members keep the workspace and cannot open administration or Studio by deep link', async ({
  open,
  world,
}) => {
  const page = await open(world.bob, { width: 1440 });
  const base = `/o/${world.organization}`;
  await page.goto(base);
  await expect(page.getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Automation Studio', exact: true })).toHaveCount(0);
  expect((await page.goto(`${base}/settings`))?.status()).toBe(404);
  expect((await page.goto(`${base}/studio`))?.status()).toBe(404);
});

for (const [width, javaScriptEnabled] of [
  [1440, true],
  [390, true],
  [320, false],
] as const) {
  test(`workspace switching loads choices on request at ${width}px`, async ({ open, world }) => {
    const page = await open(world.both, { width, javaScriptEnabled });
    const base = `/o/${world.organization}`;
    const response = await page.goto(base + '/work');
    expect(response?.status()).toBe(200);
    const html = await response!.text();
    expect(html.includes('Ito &amp; Sons') || html.includes('Ito & Sons')).toBe(false);

    if (width < 768) {
      const menu = page.locator('details.mobile-navigation');
      await menu.locator('summary').click();
      await expect(menu).toHaveAttribute('open', '');
    }
    await page
      .getByRole(javaScriptEnabled ? 'button' : 'link', {
        name: 'Switch organization',
        exact: true,
      })
      .click();
    const destination = javaScriptEnabled
      ? page.getByRole('menuitem', { name: 'Ito & Sons', exact: true })
      : page.getByRole('link', { name: /Ito & Sons/ });
    await expect(destination).toBeVisible();
    const href = await destination.getAttribute('href');
    expect(href).toMatch(/^\/o\/[a-f\d-]+$/);
    expect(html.includes(href!)).toBe(false);
    await destination.click();
    await expect(page).toHaveURL(href!);
  });
}

test('long account and organization names preserve a usable narrow workspace', async ({ open }) => {
  const person = await signUp('Alexandra'.repeat(8));
  const organization = await createOrganization(person, 'NorthstarOperations'.repeat(6));
  const page = await open(person, { width: 320, height: 900 });
  await page.goto(`/o/${organization}`);
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
  const header = await page.getByRole('banner', { name: 'Workspace header' }).boundingBox();
  expect(header?.height).toBeLessThanOrEqual(56);
  await page.locator('details.mobile-navigation > summary').click();
  await expect(page.getByRole('navigation', { name: 'Mobile main' })).toBeVisible();
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
  await saveLook(page, 'interface-long-names', 'workspace-320');
});
