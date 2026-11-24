// Controls: a check that cannot fail proves nothing, so each tool is shown catching a real problem.
import { expect, test } from '../support/fixtures';
import { axeFindings } from '../support/look';

test('the origin guard records and stops a request that leaves the proxy', async ({
  open,
  outsideRequests,
}) => {
  const page = await open(null);
  await page.goto('/sign-in');
  const reached = await page.evaluate(() =>
    fetch('https://outside.example.invalid/beacon').then(
      () => true,
      () => false,
    ),
  );
  expect(reached).toBe(false);
  expect(outsideRequests).toEqual(['https://outside.example.invalid/beacon']);
  // Found, so this control passed. The fixture would otherwise fail every test that does this.
  outsideRequests.length = 0;
});

test('axe reports a real violation when one is planted', async ({ open }) => {
  const page = await open(null);
  const path = '/__test/axe-missing-label';
  // This control audits a deliberate violation. An app route may replace inserted elements during hydration.
  await page.route(`**${path}`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><title>Accessibility control</title><main><input id="planted"></main></html>',
    }),
  );
  await page.goto(path);
  await expect(page.locator('#planted')).toBeVisible();
  const findings = await axeFindings(page);
  expect(findings.find((finding) => finding.rule === 'label')?.where).toContain('#planted');
});

test('the script-error guard also watches a new tab', async ({ open, scriptErrors }) => {
  const page = await open(null),
    other = await page.context().newPage();
  await other.goto('/sign-in');
  await other.evaluate(() => {
    setTimeout(() => {
      throw new Error('GENERATED_NEW_TAB_ERROR');
    }, 0);
  });
  await expect.poll(() => scriptErrors).toEqual(['GENERATED_NEW_TAB_ERROR']);
  // This deliberate control was detected; ordinary journeys must leave the same list empty.
  scriptErrors.length = 0;
});

test('the signed-in session carries over from the seeded person', async ({ open, world }) => {
  const page = await open(world.bob);
  await page.goto(`/o/${world.organization}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My work');
  const account = page.getByRole('link', {
    name: `${world.bob.name} ${world.bob.email}`,
    exact: true,
  });
  await expect(account).toBeVisible();
  await expect(account).toHaveAttribute('href', `/o/${world.organization}/security`);
});

test('a missing page inside an organization keeps the navigation, and answers 404', async ({
  open,
  world,
}) => {
  const page = await open(world.alice);
  const response = await page.goto(
    `/o/${world.organization}/work/00000000-0000-4000-8000-000000000000`,
  );
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
});

test('work someone may not see looks exactly like work that does not exist', async ({
  open,
  world,
}) => {
  const page = await open(world.bob);
  const hidden = await page.goto(`/o/${world.organization}/work/${world.work.confidential}`);
  expect(hidden?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByText('Review salaries for next year')).toHaveCount(0);
  const whenHidden = await page.getByRole('main').innerText();

  const missing = await page.goto(
    `/o/${world.organization}/work/00000000-0000-4000-8000-000000000000`,
  );
  expect(missing?.status()).toBe(404);
  expect(await page.getByRole('main').innerText()).toBe(whenHidden);
});

test('someone from another organization gets a not-found page, not its contents', async ({
  open,
  world,
}) => {
  const page = await open(world.quiet);
  const response = await page.goto(`/o/${world.organization}/work/${world.work.running}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByText('Redesign the pricing page')).toHaveCount(0);
  await expect(page.getByText('Northwind Studio')).toHaveCount(0);
});
