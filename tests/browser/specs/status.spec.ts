import { expect, test } from '../support/fixtures';
test('status and disclosure remain accessible without an account or JavaScript', async ({
  open,
}) => {
  const page = await open(null, { javaScriptEnabled: false });
  expect((await page.goto('/status'))?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Service status', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Security and reporting', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Security and reporting', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Safe harbor terms require legal review', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('has not yet published an external security contact', { exact: false }),
  ).toBeVisible();
});
