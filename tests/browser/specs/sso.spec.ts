import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow, saveLook, openPanels } from '../support/look';
import { BASE } from '../../helpers/forms';
import { ssoStackFixture } from '../../helpers/sso-stack-fixture';
const esc = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
test('signs in with a generated SAML provider through actual forms with JavaScript disabled', async ({
  open,
}) => {
  const f = await ssoStackFixture();
  await f.requireSso();
  const page = await open(f.member, { javaScriptEnabled: false });
  // Only this test-owned IdP navigation is fulfilled locally. The normal browser guard continues
  // refusing every other origin, and no IdP server, network call or hosted credential exists.
  await page.route('https://generated-idp.example.invalid/**', async (route) => {
    const signed = await f.idp.response(route.request().url(), f.spMetadata, f.member.email);
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Generated company provider</title><main><h1>Confirm generated company sign-in</h1><form method="post" action="${esc(`${BASE}/api/auth/sso/saml2/sp/acs/${f.connection.provider_id}`)}"><input type="hidden" name="SAMLResponse" value="${esc(signed.SAMLResponse)}"><input type="hidden" name="RelayState" value="${esc(signed.RelayState)}"><button>Continue to Ensemus</button></form></main></html>`,
    });
  });
  await page.goto(`/o/${f.organization}`);
  await expect(page.getByRole('heading', { name: 'Sign in through your company' })).toBeVisible();
  await page.getByLabel('Work email').fill(f.member.email);
  await page.getByRole('button', { name: 'Continue with company sign-in' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirm generated company sign-in' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Ensemus' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${f.organization}$`));
  await saveLook(page, 'm7-sso', 'no-script-saml-company');
});
test('company sign-in settings work by keyboard with shared dark/mobile spacing and accessible names', async ({
  open,
}) => {
  const f = await ssoStackFixture(),
    page = await open(f.owner, { width: 375, height: 900, colorScheme: 'dark' });
  await page.goto(f.path);
  await expect(page.getByRole('heading', { name: 'Company sign-in', exact: true })).toBeVisible();
  await openPanels(page);
  expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
  expect(await axeFindings(page)).toEqual([]);
  await page.getByLabel('Connection name', { exact: true }).first().focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Connection status')).toBeFocused();
  await saveLook(page, 'm7-sso', 'dark-mobile-settings');
});
test('member cannot open company sign-in management or forge a provider identity in the completion URL', async ({
  open,
}) => {
  const f = await ssoStackFixture(),
    page = await open(f.member);
  const response = await page.goto(f.path);
  expect(response?.status()).toBe(404);
  await page.goto(
    `/sso/complete?providerId=${f.connection.provider_id}&email=${encodeURIComponent(f.member.email)}&externalSubject=forged`,
  );
  await expect(
    page.getByRole('heading', { name: 'Company sign-in needs attention' }),
  ).toBeVisible();
});
