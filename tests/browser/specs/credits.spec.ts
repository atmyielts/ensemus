import { expect, test } from '../support/fixtures';

test('credit page gives a clear empty state without an automatic purchase path', async ({
  open,
  world,
}) => {
  const page = await open(world.quiet, { javaScriptEnabled: false });
  await page.goto(`/o/${world.quietOrganization}/account/credits`);
  await expect(page.getByRole('heading', { name: 'Credits', exact: true })).toBeVisible();
  await expect(page.getByText('No top-ups have been requested.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create top-up invoice' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Billing', exact: true })).toBeVisible();
});
test('a member cannot read credit administration', async ({ open, world }) => {
  const page = await open(world.bob);
  const response = await page.goto(`/o/${world.organization}/account/credits`);
  expect(response?.status()).toBe(404);
});
