import { expect, test } from '../support/fixtures';
test('invoice empty state and account navigation work without JavaScript', async ({
  open,
  world,
}) => {
  const page = await open(world.quiet, { javaScriptEnabled: false });
  await page.goto(`/o/${world.quietOrganization}/account/invoices`);
  await expect(page.getByRole('heading', { name: 'Invoices', exact: true })).toBeVisible();
  await expect(page.getByText('No invoices have been created.')).toBeVisible();
  await page.getByRole('link', { name: 'Billing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
});
test('invoice administration is missing to a member', async ({ open, world }) => {
  const page = await open(world.bob);
  const response = await page.goto(`/o/${world.organization}/account/invoices`);
  expect(response?.status()).toBe(404);
});
