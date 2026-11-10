import { expect, test } from '../support/fixtures';

test('account navigation and billing details work without JavaScript', async ({ open, world }) => {
  const page = await open(world.alice, { javaScriptEnabled: false });
  await page.goto(`/o/${world.organization}/account`);
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Billing and subscription' }).click();
  await page.getByLabel('Billing name', { exact: true }).fill('Test account');
  await page.getByLabel('Billing email', { exact: true }).fill('billing@example.invalid');
  await page.getByLabel('Country code').fill('XX');
  await page.getByRole('button', { name: 'Save billing details' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Billing details saved.' }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Billing email', { exact: true })).toHaveValue(
    'billing@example.invalid',
  );
});

test('members see account standing but billing administration stays missing', async ({
  open,
  world,
}) => {
  const page = await open(world.bob);
  await page.goto(`/o/${world.organization}/account`);
  await expect(page.getByRole('heading', { name: 'Your organization is active' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Billing and subscription' })).toHaveCount(0);
  const response = await page.goto(`/o/${world.organization}/account/billing`);
  expect(response?.status()).toBe(404);
});
