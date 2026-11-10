import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';
test('a customer can open, reply and close a support ticket without JavaScript', async ({
  open,
  world,
}) => {
  const page = await open(world.alice, { javaScriptEnabled: false }),
    subject = `Test support ${randomUUID()}`;
  await page.goto(`/o/${world.organization}/account/support`);
  await expect(page.getByRole('heading', { name: 'Support', exact: true })).toBeVisible();
  await expect(page.getByText('It has no default access', { exact: false })).toBeVisible();
  await page.getByLabel('Subject', { exact: true }).fill(subject);
  await page.getByLabel('Message', { exact: true }).fill('<script>test support text</script>');
  await page.getByRole('button', { name: 'Open support ticket', exact: true }).click();
  await expect(page.getByRole('heading', { name: subject, exact: true })).toBeVisible();
  await expect(page.getByText('<script>test support text</script>', { exact: true })).toBeVisible();
  await page.getByLabel('Your reply', { exact: true }).fill('A second test message');
  await page.getByRole('button', { name: 'Add reply', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reply added.' })).toBeVisible();
  await page.getByText('Close this ticket', { exact: true }).click();
  await page.getByLabel('This conversation is finished.', { exact: false }).check();
  await page.getByRole('button', { name: 'Close ticket', exact: true }).click();
  await expect(page.getByText('This ticket is closed.', { exact: false })).toBeVisible();
});
test('a member does not see owner-only access requests', async ({ open, world }) => {
  const page = await open(world.bob);
  await page.goto(`/o/${world.organization}/account/support`);
  await expect(page.getByRole('link', { name: 'Review support access requests' })).toHaveCount(0);
  expect((await page.goto(`/o/${world.organization}/account/break-glass`))?.status()).toBe(404);
});
