import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';

test('retention rules and legal holds work without JavaScript', async ({ open, world }) => {
  const page = await open(world.alice, { javaScriptEnabled: false });
  await page.goto(`/o/${world.organization}/account/retention`);
  await expect(page.getByRole('heading', { name: 'Data retention', exact: true })).toBeVisible();
  await page.getByLabel('Sign-off reference').fill(randomUUID());
  await page.getByRole('button', { name: 'Save retention rule' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Retention rule saved.' })).toBeVisible();
  await page.goto(`/o/${world.organization}/account/legal-holds`);
  await page.getByLabel('Matter reference').fill(randomUUID());
  await page.getByLabel('Records to preserve').selectOption('organization:');
  await page.getByRole('button', { name: 'Place legal hold' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Legal hold placed.' })).toBeVisible();
  await page.getByText('Release this hold', { exact: true }).click();
  await page.getByLabel('Release reason code').fill('TEST_MATTER_CLOSED');
  await page.getByLabel('I confirm that this hold can be released.', { exact: false }).check();
  await page.getByRole('button', { name: 'Release hold', exact: true }).click();
  await expect(page.getByText('Released', { exact: true })).toBeVisible();
});
test('members cannot discover retention or legal-hold administration', async ({ open, world }) => {
  const page = await open(world.bob);
  for (const path of ['retention', 'legal-holds'])
    expect((await page.goto(`/o/${world.organization}/account/${path}`))?.status()).toBe(404);
});
