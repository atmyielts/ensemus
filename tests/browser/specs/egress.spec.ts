import { axeFindings, sidewaysOverflow } from '../support/look';
import { expect, test } from '../support/fixtures';

test('an administrator can inspect sharing decisions and compare a proposal without egress', async ({
  open,
  world,
  outsideRequests,
}) => {
  const page = await open(world.alice, { width: 375, colorScheme: 'dark' });
  await page.goto(`/o/${world.organization}/settings/egress`);
  await expect(
    page.getByRole('heading', { name: 'Model data sharing', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Download these decisions as JSON', exact: true }),
  ).toBeVisible();
  await page.getByText('Compare a proposed provider', { exact: true }).click();
  await page.getByLabel('Provider hostname', { exact: true }).fill('models.example.invalid');
  await page.getByRole('button', { name: 'Compare proposal', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'What this proposal would allow', exact: true }),
  ).toBeVisible();
  expect(outsideRequests).toEqual([]);
  expect(await axeFindings(page)).toEqual([]);
  expect(await sidewaysOverflow(page)).toBe(0);
});
test('an ordinary member cannot read sharing decisions', async ({ open, world }) => {
  const page = await open(world.bob);
  await page.goto(`/o/${world.organization}/settings/egress`);
  await expect(page.getByRole('heading', { name: 'Recorded decisions', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('link', { name: 'Download these decisions as JSON', exact: true }),
  ).toHaveCount(0);
});
