// Real-browser/no-JavaScript acceptance remains owed until the parent authorizes the M7 stack gate.
import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow } from '../support/look';
import { PASSWORD, createOrganization, signUp } from '../../helpers/forms';
import { totpCode } from '../../helpers/totp';

test('enrolls and confirms an authenticator with JavaScript disabled, without exposing setup material on a fresh visit', async ({
  open,
}) => {
  const person = await signUp('Generated no-script MFA person'),
    organization = await createOrganization(person, 'Generated no-script MFA company');
  const page = await open(person, { javaScriptEnabled: false });
  await page.goto(`/o/${organization}/security/two-factor`);
  await page.getByLabel('Password, if you use one', { exact: true }).fill(PASSWORD);
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/security/two-factor'),
  );
  await page.getByRole('button', { name: 'Set up authenticator app', exact: true }).click();
  expect((await submitted).headers()['cache-control']).toContain('no-store');
  await expect(
    page.getByRole('heading', { name: 'Add Ensemus to your authenticator app' }),
  ).toBeVisible();
  const uri = await page
    .getByRole('link', { name: 'Open in an authenticator app on this device' })
    .getAttribute('href');
  const key = new URL(uri!).searchParams.get('secret')!;
  const recovery = await page.locator('li code').allTextContents();
  expect(recovery).toHaveLength(10);
  await page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Confirm and turn on', exact: true }) })
    .getByLabel('Verification code', { exact: true })
    .fill(totpCode(key, Date.now() - 30000));
  await page.getByRole('button', { name: 'Confirm and turn on' }).click();
  // The page's own notice. Each form's submit button keeps an empty status of its own beside it.
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: /\S/ })).toHaveText(
    'Two-step sign-in is on.',
  );
  await page.goto(`/o/${organization}/security/two-factor`);
  for (const code of recovery) await expect(page.getByText(code, { exact: true })).toHaveCount(0);
  await expect(page.getByText(key, { exact: true })).toHaveCount(0);
  expect(await sidewaysOverflow(page)).toBe(0);
  expect(await axeFindings(page)).toEqual([]);
});
test('security settings and confirmation are keyboard-reachable, usable in dark/mobile, and hide another company', async ({
  open,
  world,
}) => {
  const page = await open(world.bob, { width: 390, colorScheme: 'dark' });
  await page.goto(`/o/${world.organization}/security`);
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save security settings' })).toHaveCount(0);
  const setup = page.getByRole('link', { name: 'Set up authenticator app', exact: true });
  await setup.focus();
  expect(await setup.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    'none',
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Authenticator app' })).toBeVisible();
  await expect(page.getByLabel('Password, if you use one', { exact: true })).toBeVisible();
  expect(await sidewaysOverflow(page)).toBe(0);
  expect(await axeFindings(page)).toEqual([]);
  const outsider = await open(world.quiet);
  expect((await outsider.goto(`/o/${world.organization}/security`))?.status()).toBe(404);
});
test('confirmation uses plain labels and refuses open returns without JavaScript', async ({
  open,
  world,
}) => {
  const page = await open(world.bob, { javaScriptEnabled: false });
  await page.goto(`/o/${world.organization}/security/confirm?next=%2F%2Fevil.example.invalid`);
  await expect(page.getByRole('heading', { level: 1, name: 'Confirm it is you' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Cancel', exact: true })).toHaveAttribute(
    'href',
    `/o/${world.organization}`,
  );
  await expect(
    page.getByRole('link', { name: 'Set up authenticator app', exact: true }),
  ).toBeVisible();
  expect(await axeFindings(page)).toEqual([]);
});
