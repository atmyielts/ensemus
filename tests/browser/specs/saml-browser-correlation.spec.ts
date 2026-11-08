// Actual signed, browser-carried SAML. First-use identities are created by the native callback,
// then invited/confirmed through shipped forms; no prelinked Account or assurance is seeded.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { BASE, bringIn, type Person } from '../../helpers/forms';
import { ssoStackFixture } from '../../helpers/sso-stack-fixture';
import { expireGeneratedSamlCorrelation } from '../../helpers/saml-correlation';
import { SAML_BROWSER_COOKIE } from '../../../packages/auth/src/saml-browser-binding';

type Fixture = Awaited<ReturnType<typeof ssoStackFixture>>;
const esc = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
async function provider(page: Page, f: Fixture, email: string) {
  await page.context().route('https://generated-idp.example.invalid/**', async (route) => {
    const signed = await f.idp.response(route.request().url(), f.spMetadata, email);
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Generated company sign-in</title><main><h1>Confirm generated company sign-in</h1><form method="post" action="${esc(`${BASE}/api/auth/sso/saml2/sp/acs/${f.connection.provider_id}`)}"><input type="hidden" name="SAMLResponse" value="${esc(signed.SAMLResponse)}"><input type="hidden" name="RelayState" value="${esc(signed.RelayState)}"><button>Continue to Ensemus</button></form></main></html>`,
    });
  });
}
async function start(page: Page, email: string) {
  await page.goto('/sign-in/sso');
  await page.getByLabel('Work email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Continue with company sign-in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirm generated company sign-in', exact: true }),
  ).toBeVisible();
  const cookie = (await page.context().cookies(BASE)).find(
    (value) => value.name === SAML_BROWSER_COOKIE,
  );
  if (!cookie) throw new Error('NATIVE_SAML_BROWSER_COOKIE_REQUIRED');
  expect({
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    path: cookie.path,
  }).toEqual({ secure: true, httpOnly: true, sameSite: 'None', path: '/' });
  return { url: page.url(), cookie };
}
async function refused(page: Page) {
  await page.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('error')).toBe('SSO_REFUSED');
  const session = await page.request.get('/api/auth/get-session');
  expect(await session.json()).toBeNull();
}

for (const javaScriptEnabled of [true, false])
  test(`a browser-bound native first sign-in and returning exact account both work (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
    open,
  }) => {
    const f = await ssoStackFixture(),
      email = `native-first-${randomUUID()}@${f.domain}`,
      page = await open(null, { javaScriptEnabled });
    await provider(page, f, email);
    await start(page, email);
    await page.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Ask to join your company', exact: true }),
    ).toBeVisible();
    const nativeCookies = await page.context().cookies(BASE),
      person: Person = {
        name: 'Generated native SAML member',
        email,
        jar: { cookie: nativeCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') },
      };
    await bringIn(f.owner, f.organization, person);
    await start(page, email);
    await page.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${f.organization}$`));
    expect(
      (await page.request.get(`/api/v1/organizations/${f.organization}/exports`)).status(),
    ).toBe(403);
    expect(
      (await page.context().cookies(BASE)).some((cookie) => cookie.name === SAML_BROWSER_COOKIE),
    ).toBe(false);
  });

test('a valid assertion and relay from another browser cannot log the victim in', async ({
  open,
}) => {
  const f = await ssoStackFixture(),
    email = `cross-browser-${randomUUID()}@${f.domain}`,
    attacker = await open(null, { javaScriptEnabled: false }),
    victim = await open(null, { javaScriptEnabled: false });
  await provider(attacker, f, email);
  await provider(victim, f, email);
  const attempt = await start(attacker, email);
  await victim.goto(attempt.url);
  await refused(victim);
});

test('a wrong browser attempt refuses without erasing that browser’s own valid attempt', async ({
  open,
}) => {
  const f = await ssoStackFixture(),
    firstEmail = `first-${randomUUID()}@${f.domain}`,
    secondEmail = `second-${randomUUID()}@${f.domain}`,
    first = await open(null),
    second = await open(null);
  await provider(first, f, firstEmail);
  await provider(second, f, secondEmail);
  const a = await start(first, firstEmail),
    b = await start(second, secondEmail);
  await second.goto(a.url);
  await refused(second);
  const retained = (await second.context().cookies(BASE)).find(
    (cookie) => cookie.name === SAML_BROWSER_COOKIE,
  );
  expect(retained?.value === b.cookie.value).toBe(true);
  await second.goto(b.url);
  await second.getByRole('button', { name: 'Continue to Ensemus', exact: true }).click();
  await expect(
    second.getByRole('heading', { name: 'Ask to join your company', exact: true }),
  ).toBeVisible();
});

test('an actually expired correlation row refuses a still-valid signed native callback', async ({
  open,
}) => {
  const f = await ssoStackFixture(),
    email = `expired-${randomUUID()}@${f.domain}`,
    page = await open(null, { javaScriptEnabled: false });
  await provider(page, f, email);
  const attempt = await start(page, email),
    payload = JSON.parse(
      Buffer.from(attempt.cookie.value.split('.')[0]!, 'base64url').toString('utf8'),
    ) as { id: string };
  await expireGeneratedSamlCorrelation(payload.id, attempt.url, f.idp.issuer);
  await refused(page);
});
