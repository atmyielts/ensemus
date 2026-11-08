// Authored source only: actual native enrollment/proof and account effects; no assurance seeding.
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import {
  BASE,
  PASSWORD,
  assembled,
  createOrganization,
  formsIn,
  join,
  post,
  signUp,
  submit,
  type Person,
} from '../../helpers/forms';
import { setGeneratedAccountStanding } from '../../helpers/account-export';
import { totpFromUri } from '../../helpers/totp';
import { axeFindings } from '../support/look';

async function enroll(person: Person, organization: string) {
  const path = `/o/${organization}/security/two-factor`,
    setup = await submit(path, person.jar, /Set up authenticator app/, { password: PASSWORD }),
    html = assembled(await setup.text());
  expect(setup.status).toBe(200);
  const uri = /href="(otpauth:\/\/[^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
  if (!uri) throw new Error('ACCOUNT_RECOVERY_NATIVE_SETUP_REQUIRED');
  const confirmation = formsIn(html).filter((form) => /Confirm and turn on/.test(form.html));
  expect(confirmation).toHaveLength(1);
  const result = await post(path, person.jar, confirmation[0]!, {
    code: totpFromUri(uri, Date.now() - 30000),
  });
  expect(result.headers.get('location')).toBe(`/o/${organization}/security?notice=enrolled`);
  return uri;
}
async function requireAdministrativeMfa(person: Person, organization: string) {
  const response = await fetch(`${BASE}/api/v1/organizations/${organization}/security-policy`, {
    method: 'PATCH',
    headers: {
      cookie: person.jar.cookie,
      origin: new URL(BASE).origin,
      'content-type': 'application/json',
      'if-match': '"1"',
    },
    body: JSON.stringify({
      mfa_for_administration: true,
      mfa_max_age_seconds: 60,
      sso_enforcement: 'optional',
    }),
  });
  expect(response.status).toBe(200);
}
async function submitOriginalRequest(page: Page, name: string) {
  await page.getByLabel('Organization name', { exact: true }).fill(name);
  await page.getByLabel('I understand that new work will stop', { exact: false }).check();
  await page.getByRole('button', { name: 'Request offboarding', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Confirm it is you with your authenticator app, then try again.',
  );
  await expect(page.getByLabel('Organization name', { exact: true })).toHaveValue(name);
}
async function recoveryTab(page: Page) {
  const waiting = page.waitForEvent('popup');
  await page
    .getByRole('link', { name: 'Confirm your identity in another tab', exact: true })
    .click();
  const popup = await waiting;
  await expect(
    popup.getByRole('heading', { name: 'Confirm it is you', exact: true }),
  ).toBeVisible();
  return popup;
}
async function finishOriginalRequest(page: Page, name: string) {
  await expect(page.getByLabel('Organization name', { exact: true })).toHaveValue(name);
  // Confirmation is explicit again; verification in the other tab never sends this request.
  await page.getByLabel('I understand that new work will stop', { exact: false }).check();
  await page.getByRole('button', { name: 'Request offboarding', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: /Request recorded|Export offered|Contractual transition|Ending work and connections/,
    }),
  ).toBeVisible();
}

for (const javaScriptEnabled of [true, false]) {
  test(`an unenrolled suspended owner enrolls in another tab without losing the original request (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
    open,
  }) => {
    const owner = await signUp('Generated account recovery owner'),
      name = 'Generated account export unenrolled recovery company',
      organization = await createOrganization(owner, name),
      coowner = await join(owner, organization, 'Generated account recovery second owner');
    const promoted = await submit(
      `/o/${organization}/people`,
      owner.jar,
      (form) => form.html.includes(`Save access for ${coowner.name}`),
      { role: 'owner' },
    );
    expect(promoted.headers.get('location')).toBe(`/o/${organization}/people`);
    await enroll(coowner, organization);
    await requireAdministrativeMfa(coowner, organization);
    await setGeneratedAccountStanding(organization, 'suspended');
    const page = await open(owner, { javaScriptEnabled, width: 390 });
    await page.goto(`/o/${organization}/account/leave`);
    await submitOriginalRequest(page, name);
    const popup = await recoveryTab(page);
    await popup.getByRole('link', { name: 'Set up authenticator app', exact: true }).click();
    await expect(popup).toHaveURL(new RegExp(`/o/${organization}/account/two-factor\\?`));
    await popup.getByLabel('Password, if you use one', { exact: true }).fill(PASSWORD);
    const response = popup.waitForResponse(
      (value) =>
        value.request().method() === 'POST' &&
        new URL(value.url()).pathname === `/o/${organization}/account/two-factor`,
    );
    await popup.getByRole('button', { name: 'Set up authenticator app', exact: true }).click();
    expect((await response).headers()['cache-control']).toContain('no-store');
    const uri = await popup
      .getByRole('link', { name: 'Open in an authenticator app on this device', exact: true })
      .getAttribute('href');
    if (!uri) throw new Error('ACCOUNT_RECOVERY_SETUP_URI_REQUIRED');
    const recovery = await popup.locator('li code').allTextContents();
    expect(recovery).toHaveLength(10);
    await popup
      .locator('form')
      .filter({ has: popup.getByRole('button', { name: 'Confirm and turn on', exact: true }) })
      .getByLabel('Verification code', { exact: true })
      .fill(totpFromUri(uri, Date.now() - 30000));
    await popup.getByRole('button', { name: 'Confirm and turn on', exact: true }).click();
    await expect(popup).toHaveURL(new RegExp(`/o/${organization}/account/leave$`));
    await expect(
      popup.getByRole('heading', { name: 'Request offboarding', exact: true }),
    ).toBeVisible();
    // Core remains closed, even after account enrollment grants actual MFA authority.
    await popup.goto(`/o/${organization}/work`);
    await expect(popup).toHaveURL(new RegExp(`/o/${organization}/account$`));
    await popup.goto(`/o/${organization}/account/two-factor`);
    await expect(
      popup.getByText('Your authenticator app is already set up.', { exact: true }),
    ).toBeVisible();
    await expect(
      popup.getByRole('link', { name: 'Open in an authenticator app on this device', exact: true }),
    ).toHaveCount(0);
    for (const code of recovery)
      await expect(popup.getByText(code, { exact: true })).toHaveCount(0);
    if (javaScriptEnabled) expect(await axeFindings(popup)).toEqual([]);
    await finishOriginalRequest(page, name);
  });

  test(`a suspended owner's genuinely expired proof can be renewed without replacing the draft (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
    open,
  }) => {
    test.setTimeout(180000);
    const owner = await signUp('Generated account expired proof owner'),
      name = 'Generated account export expired proof company',
      organization = await createOrganization(owner, name),
      uri = await enroll(owner, organization);
    await requireAdministrativeMfa(owner, organization);
    const oldBy = Date.now() + 61000;
    await setGeneratedAccountStanding(organization, 'suspended');
    const page = await open(owner, { javaScriptEnabled });
    await page.goto(`/o/${organization}/account/leave`);
    await page.getByLabel('Organization name', { exact: true }).fill(name);
    // SQL owns the clock. Wait beyond the actual 60-second configured age; never write a proof row.
    await expect
      .poll(() => Date.now(), { timeout: 70000, intervals: [1000] })
      .toBeGreaterThan(oldBy);
    await submitOriginalRequest(page, name);
    const popup = await recoveryTab(page);
    await popup.getByLabel('Verification code', { exact: true }).fill(totpFromUri(uri));
    await popup.getByRole('button', { name: 'Confirm and continue', exact: true }).click();
    await expect(popup).toHaveURL(new RegExp(`/o/${organization}/account/leave$`));
    await expect(
      popup.getByRole('heading', { name: 'Request offboarding', exact: true }),
    ).toBeVisible();
    await finishOriginalRequest(page, name);
  });
}

test('account identity recovery keeps foreign tenants missing and rejects core or external return paths', async ({
  open,
  world,
}) => {
  const stranger = await open(world.quiet, { javaScriptEnabled: false });
  for (const route of ['confirm', 'two-factor'])
    expect((await stranger.goto(`/o/${world.organization}/account/${route}`))?.status()).toBe(404);
  const member = await open(world.bob, { javaScriptEnabled: false });
  for (const next of [
    'https://evil.invalid',
    `/o/${world.organization}/work`,
    `/o/${world.organization}/data`,
  ]) {
    await member.goto(`/o/${world.organization}/account/confirm?next=${encodeURIComponent(next)}`);
    await expect(
      member.getByRole('link', { name: 'Back to your account request', exact: true }),
    ).toHaveAttribute('href', `/o/${world.organization}/account`);
    await expect(
      member.getByRole('link', { name: 'Set up authenticator app', exact: true }),
    ).toHaveAttribute(
      'href',
      `/o/${world.organization}/account/two-factor?next=${encodeURIComponent(`/o/${world.organization}/account`)}`,
    );
  }
});
