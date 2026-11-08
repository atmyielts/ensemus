import { expect, test } from '../support/fixtures';
test('owner can request and cancel offboarding without JavaScript when the real halt binding is configured', async ({
  open,
  world,
}) => {
  const page = await open(world.alice, { javaScriptEnabled: false });
  await page.goto(`/o/${world.organization}/account/leave`);
  const help = await page.locator('#leave-name-help').textContent();
  const name = /^Type (.+) exactly to confirm\.$/.exec(help ?? '')?.[1];
  expect(name).toBeTruthy();
  await page.getByLabel('Organization name', { exact: true }).fill(name!);
  await page.getByLabel('I understand that new work will stop', { exact: false }).check();
  await page.getByRole('button', { name: 'Request offboarding', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /Request recorded|Export offered|Contractual transition/ }),
  ).toBeVisible();
  await page.getByText('Cancel offboarding', { exact: true }).first().click();
  await expect(page.getByLabel('Reason for cancelling', { exact: true })).toHaveValue('');
  await page
    .getByLabel('Reason for cancelling', { exact: true })
    .selectOption({ label: 'Our organization has decided to stay' });
  await page.getByLabel('I want this organization to stay.', { exact: false }).check();
  await page.getByRole('button', { name: 'Cancel offboarding', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Request offboarding', exact: true }),
  ).toBeVisible();
});
test('a member cannot discover the owner leaving controls', async ({ open, world }) => {
  const page = await open(world.bob);
  expect((await page.goto(`/o/${world.organization}/account/leave`))?.status()).toBe(404);
});
