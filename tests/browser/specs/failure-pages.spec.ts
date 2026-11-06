// The error pages can only be reached by something really failing. A renamed table is a real failure,
// reached by the real code path, and it is put back straight after. These run alone, by configuration.
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { axeFindings, saveLook, sidewaysOverflow, THEMES, WIDTHS } from '../support/look';

async function checkEverywhere(page: Page, state: string) {
  const problems: Record<string, unknown> = {};
  for (const theme of THEMES) {
    // Reduced motion, so colors have finished changing by the time axe measures them.
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
      const label = `${theme}-${width}`;
      const findings = await axeFindings(page);
      if (findings.length) problems[label] = findings;
      const overflow = await sidewaysOverflow(page);
      if (overflow > 0) problems[`${label} overflow`] = `${overflow}px sideways`;
      await saveLook(page, state, label);
    }
  }
  expect(problems).toEqual({});
}

test('when one page fails, the navigation stays and the page offers a way on', async ({
  open,
  world,
  scriptErrors,
}) => {
  const page = await open(world.alice);
  await world.sql.query('alter table work.clients rename to clients_broken_by_test');
  try {
    await page.goto(`/o/${world.organization}/clients`);
    await expect(page.getByRole('heading', { name: 'This page could not be shown' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to Home' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Nothing you saved has been lost',
    );
    await expect(page.locator('body')).not.toContainText(/clients_broken|relation|Failed query/);
    await checkEverywhere(page, 'error-in-organization');
  } finally {
    await world.sql.query('alter table work.clients_broken_by_test rename to clients');
  }
  // Try again really asks the server again, now that the failure is over.
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Clients and projects' })).toBeVisible();
  // React reports the error it caught. That is the failure this test caused, not a new one.
  scriptErrors.length = 0;
});

test('when the whole organization cannot load, the top-level error page takes over', async ({
  open,
  world,
  scriptErrors,
}) => {
  const page = await open(world.alice);
  await world.sql.query('alter table org.memberships rename to memberships_broken_by_test');
  try {
    await page.goto(`/o/${world.organization}`);
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to your home page' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(
      /memberships_broken|relation|Failed query/,
    );
    await checkEverywhere(page, 'error-top-level');
  } finally {
    await world.sql.query('alter table org.memberships_broken_by_test rename to memberships');
  }
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Alice' })).toBeVisible();
  scriptErrors.length = 0;
});
