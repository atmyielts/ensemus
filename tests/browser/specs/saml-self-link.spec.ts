// Authored built-runtime journeys. All identity/credential/factor/link effects use actual HTTP;
// the only operator mutation is the existing exact reviewed generated-provider setup.
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { BASE, PASSWORD } from '../../helpers/forms';
import { ssoStackFixture } from '../../helpers/sso-stack-fixture';
import { totpFromUri } from '../../helpers/totp';
import { axeFindings } from '../support/look';
type Fixture = Awaited<ReturnType<typeof ssoStackFixture>>;
const esc = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
async function provider(page: Page, f: Fixture, email = f.member.email) {
  await page.context().route('https://generated-idp.example.invalid/**', async (route) => {
    const signed = await f.idp.response(route.request().url(), f.spMetadata, email);
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Generated company identity</title><main><h1>Confirm generated company identity</h1><form method="post" action="${esc(`${BASE}/api/auth/sso/saml2/sp/acs/${f.connection.provider_id}`)}"><input type="hidden" name="SAMLResponse" value="${esc(signed.SAMLResponse)}"><input type="hidden" name="RelayState" value="${esc(signed.RelayState)}"><button>Continue to Ensemus</button></form></main></html>`,
    });
  });
}
async function start(page: Page) {
  await page.goto('/sign-in/sso');
  await page.getByLabel('Password for this Ensemus account', { exact: true }).fill(PASSWORD);
  await page
    .getByLabel('I want to connect company sign-in to this Ensemus account.', { exact: true })
    .check();
  await page.getByRole('button', { name: 'Connect company sign-in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirm generated company identity', exact: true }),
  ).toBeVisible();
  return page.url();
}
for (const javaScriptEnabled of [true, false])
  test(`an existing password member explicitly connects with their profile preserved (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
    open,
  }) => {
    const f = await ssoStackFixture(),
      page = await open(f.member, { javaScriptEnabled });
    await provider(page, f);
    const before = await (await page.request.get('/api/auth/get-session')).json();
    expect(before.user.emailVerified).toBe(false);
    await page.goto('/sign-in/sso');
    if (javaScriptEnabled) expect(await axeFindings(page)).toEqual([]);
    await start(page);
    await page.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${f.organization}$`));
    const after = await (await page.request.get('/api/auth/get-session')).json();
    expect(after.user).toMatchObject({
      id: before.user.id,
      email: f.member.email,
      name: f.member.name,
      emailVerified: false,
    });
    // Signed role=owner from the generated IdP never elevates this ordinary member.
    expect(
      (await page.request.get(`/api/v1/organizations/${f.organization}/exports`)).status(),
    ).toBe(403);
    // Already-linked exact subject is usable again, with an independent new browser proof.
    await start(page);
    await page.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${f.organization}$`));
  });
test('ordinary Continue does not silently link an existing unverified local account', async ({
  open,
}) => {
  const f = await ssoStackFixture(),
    page = await open(f.member, { javaScriptEnabled: false });
  await provider(page, f);
  const before = await (await page.request.get('/api/auth/get-session')).json();
  await page.goto('/sign-in/sso');
  await page.getByLabel('Work email', { exact: true }).fill(f.member.email);
  await page.getByRole('button', { name: 'Continue with company sign-in', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('error')).toBe('account_not_linked');
  const after = await (await page.request.get('/api/auth/get-session')).json();
  expect(after?.user.id).toBe(before.user.id);
});
test('a stolen self-link redirect cannot log another browser into the selected account', async ({
  open,
}) => {
  const f = await ssoStackFixture(),
    source = await open(f.member, { javaScriptEnabled: false }),
    victim = await open(null, { javaScriptEnabled: false });
  await provider(source, f);
  await provider(victim, f);
  const url = await start(source);
  await victim.goto(url);
  await victim.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
  await expect.poll(() => new URL(victim.url()).searchParams.get('error')).toBe('SSO_REFUSED');
  expect(await (await victim.request.get('/api/auth/get-session')).json()).toBeNull();
  // The native request/assertion may be single-use across browsers; refusal is conservative. Start
  // anew in the legitimate browser rather than claiming recall or reusing its stolen assertion.
  await start(source);
  await source.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
  await expect(source).toHaveURL(new RegExp(`/o/${f.organization}$`));
});
test('an actual local second factor is still challenged after explicit company connection', async ({
  open,
}) => {
  const f = await ssoStackFixture(),
    page = await open(f.member, { javaScriptEnabled: false });
  await page.goto(`/o/${f.organization}/security/two-factor`);
  await page.getByLabel('Password, if you use one', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Set up authenticator app', exact: true }).click();
  const uri = await page
    .getByRole('link', { name: 'Open in an authenticator app on this device', exact: true })
    .getAttribute('href');
  if (!uri) throw new Error('NATIVE_FACTOR_URI_REQUIRED');
  await page
    .getByLabel('Verification code', { exact: true })
    .fill(totpFromUri(uri, Date.now() - 30000));
  await page.getByRole('button', { name: 'Confirm and turn on', exact: true }).click();
  await provider(page, f);
  await start(page);
  await page.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirm your sign-in', exact: true }),
  ).toBeVisible();
  // The app's native challenge handoff withholds the new SSO admission until a real app code passes.
  await page.getByLabel('Verification code', { exact: true }).fill(totpFromUri(uri));
  await page.getByRole('button', { name: 'Confirm sign-in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${f.organization}$`));
});
