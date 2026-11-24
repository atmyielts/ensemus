import { createOrganization, join, signUp } from '../../helpers/forms';
import { enrollAuthenticator } from '../../helpers/native-mfa';
import { expect, test } from '../support/fixtures';
import { axeFindings } from '../support/look';

const enabled = process.env.ENSEMUS_MARKETPLACE_ENABLED === 'true';

test('the Marketplace is hidden from the catalog when disabled', async ({ open }) => {
  test.skip(enabled, 'Requires the default disabled Marketplace');
  const owner = await signUp('Generated workspace owner');
  const organization = await createOrganization(owner, 'Generated workspace');
  const page = await open(owner);
  const root = `/o/${organization}`;
  await page.goto(`${root}/skills`);
  await expect(page.getByRole('link', { name: 'Marketplace', exact: true })).toHaveCount(0);
  await page.goto(`${root}/marketplace`);
  await expect(page.getByText('Marketplace unavailable')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Marketplace', exact: true })).toHaveCount(0);
});

test('an owner can become a publisher by keyboard and a member can browse', async ({ open }) => {
  test.skip(!enabled, 'Needs the Marketplace switch on the assembled test stack');
  const owner = await signUp('Generated Marketplace owner');
  const organization = await createOrganization(owner, 'Generated Marketplace workspace');
  const member = await join(owner, organization, 'Generated Marketplace member');
  await enrollAuthenticator(owner, organization);
  const root = `/o/${organization}`;
  const publisher = `${root}/marketplace/publishing`;
  const page = await open(owner, { javaScriptEnabled: false, width: 320 });
  await page.goto(`${root}/skills`);
  const marketplace = page.getByRole('link', { name: 'Marketplace', exact: true });
  await expect(marketplace).toBeVisible();
  await marketplace.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Skills Marketplace', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Publishing', exact: true }).press('Enter');
  const name = page.getByRole('textbox', { name: 'Publisher name', exact: true });
  await name.fill('Generated copper studio');
  await name.press('Tab');
  const submit = page.getByRole('button', { name: 'Become a publisher', exact: true });
  await expect(submit).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(publisher);
  await expect(page.getByRole('region', { name: 'Publisher profile' })).toContainText(
    'Generated copper studio',
  );
  await expect(page.getByRole('button', { name: 'Become a publisher', exact: true })).toHaveCount(
    0,
  );

  const viewer = await open(member, { width: 320, colorScheme: 'dark' });
  await viewer.goto(`${root}/marketplace`);
  const navigation = viewer.getByRole('navigation', { name: 'Marketplace', exact: true });
  await expect(navigation.getByRole('link', { name: 'Browse' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Publishing' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Installations' })).toBeVisible();
  expect(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  expect(await axeFindings(viewer)).toEqual([]);
  expect((await viewer.goto(publisher))?.status()).toBe(404);
});
