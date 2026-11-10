import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow, saveLook, openPanels } from '../support/look';
import { BASE } from '../../helpers/forms';
import { ssoStackFixture } from '../../helpers/sso-stack-fixture';
test('signs in with a generated SAML provider through actual forms with JavaScript disabled', async ({
  open,
}) => {
  // Browser routing never sees the target of a redirect, so a provider fulfilled by page.route was
  // never reached: the sign-in start redirects to it. The provider is the test-owned loopback HTTPS
  // listener instead, the only destination the browser fence admits besides the proxy, by its exact
  // origin and path. No hosted provider, credential or other network destination is involved.
  const f = await ssoStackFixture({ browserProvider: true });
  if (!f.browserProvider) throw new Error('GENERATED_BROWSER_PROVIDER_REQUIRED');
  // A password account is never linked to company sign-in implicitly (0421). The member connects it
  // once, with consent and local proof, through the native endpoint, and then signs in the usual way.
  await f.connectMember();
  await f.requireSso();
  const page = await open(f.member, { javaScriptEnabled: false });
  await page.context().addCookies([
    f.browserProvider.configure({
      acsURL: `${BASE}/api/auth/sso/saml2/sp/acs/${f.connection.provider_id}`,
      response: (url) => f.idp.response(url, f.spMetadata, f.member.email),
    }),
  ]);
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
