// Built-HTTP setup for SSO journeys. The only direct DB operation is the real, hash-pinned operator
// review command; people, memberships, MFA, connection settings and sign-in use shipped HTTP forms.
import { randomUUID } from 'node:crypto';
import { inspectSsoProvider, verifySsoDomain } from '@ensemus/database/sso-operator';
import {
  BASE,
  PASSWORD,
  aClientAddress,
  assembled,
  formsIn,
  post,
  createOrganization,
  submit,
  bringIn,
  remember,
  type Person,
} from './forms';
import { generatedSamlIdp } from './saml-idp';
import { startGeneratedBrowserSamlProvider } from './browser-saml-provider';
import { totpFromUri } from './totp';
import { urls } from './stack';
export async function generatedHttpPerson(domain: string, label: string): Promise<Person> {
  const person: Person = {
    jar: { cookie: '' },
    name: label,
    email: `person-${randomUUID()}@${domain}`,
  };
  const response = await submit('/sign-up', person.jar, /name="password"/, {
    name: person.name,
    email: person.email,
    password: PASSWORD,
  });
  if (response.status !== 303 || !person.jar.cookie.includes('session_token'))
    throw new Error('GENERATED_SSO_ACCOUNT_NOT_CREATED');
  return person;
}
export async function ssoStackFixture(options: { browserProvider?: boolean } = {}) {
  const browserProvider = options.browserProvider
    ? await startGeneratedBrowserSamlProvider()
    : undefined;
  const domain = `generated-${randomUUID()}.example.invalid`,
    owner = await generatedHttpPerson(domain, 'Generated SSO owner'),
    organization = await createOrganization(owner, 'Generated SSO company'),
    idp = await generatedSamlIdp(browserProvider ? { endpoint: browserProvider.endpoint } : {});
  const factorPath = `/o/${organization}/security/two-factor`,
    setup = await submit(factorPath, owner.jar, /Set up authenticator app/, { password: PASSWORD }),
    html = assembled(await setup.text());
  const uri = /href="(otpauth:\/\/[^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
  if (!uri || setup.status !== 200) throw new Error('GENERATED_SSO_OWNER_FACTOR_NOT_PREPARED');
  // Enrollment state exists only in this POST response. A fresh GET deliberately has no setup
  // material or confirmation action; submitting by fetching the page again loses the native state.
  const confirmations = formsIn(html).filter((form) => /Confirm and turn on/.test(form.html));
  if (confirmations.length !== 1) throw new Error('GENERATED_SSO_OWNER_CONFIRMATION_FORM_MISSING');
  const confirmed = await post(factorPath, owner.jar, confirmations[0]!, {
    code: totpFromUri(uri),
  });
  const target = new URL(confirmed.headers.get('location') ?? '/missing', BASE);
  if (
    confirmed.status !== 303 ||
    target.origin !== new URL(BASE).origin ||
    target.pathname !== `/o/${organization}/security` ||
    target.searchParams.get('notice') !== 'enrolled'
  )
    throw new Error('GENERATED_SSO_OWNER_FACTOR_NOT_CONFIRMED');
  const path = `/o/${organization}/security/sso`,
    created = await submit(path, owner.jar, /Save connection for review/, {
      displayName: 'Generated company identity provider',
      domain,
      metadata: idp.metadata,
    });
  if (created.status !== 303) throw new Error('GENERATED_SSO_CONNECTION_NOT_CREATED');
  const api = `/api/v1/organizations/${organization}/sso-connections`;
  const listing = await fetch(`${BASE}${api}`, {
    headers: { cookie: owner.jar.cookie },
    redirect: 'manual',
  });
  if (listing.status !== 200) throw new Error('GENERATED_SSO_CONNECTION_NOT_VISIBLE');
  const body = (await listing.json()) as {
    items: { id: string; provider_id: string; version: number }[];
  };
  const connection = body.items[0];
  if (!connection || body.items.length !== 1) throw new Error('GENERATED_SSO_CONNECTION_AMBIGUOUS');
  const reviewed = await inspectSsoProvider(urls.migrator(), connection.provider_id);
  if (
    !reviewed ||
    (await verifySsoDomain(urls.migrator(), {
      providerId: connection.provider_id,
      expectedSha256: reviewed.expectedSha256,
    })) !== 'verified'
  )
    throw new Error('GENERATED_SSO_OPERATOR_REVIEW_NOT_RECORDED');
  const activated = await fetch(`${BASE}${api}/${connection.id}`, {
    method: 'PATCH',
    headers: {
      cookie: owner.jar.cookie,
      origin: BASE,
      'content-type': 'application/json',
      'if-match': `"${connection.version}"`,
    },
    body: JSON.stringify({ state: 'active' }),
  });
  if (activated.status !== 200) throw new Error('GENERATED_SSO_CONNECTION_NOT_ACTIVATED');
  const member = await generatedHttpPerson(domain, 'Generated SSO member');
  await bringIn(owner, organization, member);
  const metadata = await fetch(
    `${BASE}/api/auth/sso/saml2/sp/metadata?providerId=${connection.provider_id}`,
  );
  if (metadata.status !== 200) throw new Error('GENERATED_SSO_SP_METADATA_MISSING');
  const spMetadata = await metadata.text();
  return {
    domain,
    owner,
    member,
    organization,
    idp,
    browserProvider,
    path,
    api,
    connection,
    spMetadata,
    async requireSso() {
      const response = await fetch(`${BASE}/api/v1/organizations/${organization}/security-policy`, {
        method: 'PATCH',
        headers: {
          cookie: owner.jar.cookie,
          origin: BASE,
          'content-type': 'application/json',
          'if-match': '"1"',
        },
        body: JSON.stringify({
          mfa_for_administration: false,
          mfa_max_age_seconds: 900,
          sso_enforcement: 'required',
        }),
      });
      if (response.status !== 200) throw new Error('GENERATED_SSO_POLICY_NOT_SET');
    },
    /**
     * The member's own explicit connection (0421). Their password account's address is unverified,
     * and ordinary company sign-in never links it implicitly (`account_not_linked`); the person
     * connects it with consent and local proof through the same native endpoint the /sign-in/sso
     * "Connect company sign-in" form uses, then answers that request with a signed assertion.
     */
    async connectMember() {
      const jar = { cookie: member.jar.cookie },
        client = aClientAddress();
      const started = await fetch(`${BASE}/api/auth/sso/link-self`, {
        method: 'POST',
        headers: {
          cookie: jar.cookie,
          origin: BASE,
          'content-type': 'application/json',
          'x-ensemus-test-client': client,
        },
        body: JSON.stringify({
          password: PASSWORD,
          callbackURL: `${BASE}/sso/complete`,
          consent: 'connect',
        }),
        redirect: 'manual',
      });
      remember(jar, started);
      if (started.status !== 200) throw new Error('GENERATED_SSO_SELF_LINK_NOT_STARTED');
      const { url } = (await started.json()) as { url: string },
        signed = await idp.response(url, spMetadata, member.email);
      const answered = await fetch(`${BASE}/api/auth/sso/saml2/sp/acs/${connection.provider_id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: jar.cookie,
          origin: 'https://generated-idp.example.invalid',
          'x-ensemus-test-client': client,
        },
        body: new URLSearchParams({
          SAMLResponse: signed.SAMLResponse,
          RelayState: signed.RelayState,
        }),
        redirect: 'manual',
      });
      if (answered.status !== 302 || (answered.headers.get('location') ?? '').includes('error='))
        throw new Error('GENERATED_SSO_SELF_LINK_NOT_COMPLETED');
    },
    async signIn(email = member.email) {
      const jar = { cookie: '' };
      // Company sign-in starts are limited per client address (3 in 10 s), and every test really
      // arrives from one; each flow is its own browser, as forms.ts gives every other request.
      const response = await fetch(`${BASE}/api/auth/sign-in/sso`, {
        method: 'POST',
        headers: {
          origin: BASE,
          'content-type': 'application/json',
          'x-ensemus-test-client': aClientAddress(),
        },
        body: JSON.stringify({
          providerId: connection.provider_id,
          providerType: 'saml',
          email,
          callbackURL: `${BASE}/sso/complete`,
        }),
        redirect: 'manual',
      });
      remember(jar, response);
      if (response.status !== 200) throw new Error('GENERATED_SSO_REQUEST_NOT_CREATED');
      const input = (await response.json()) as { url: string };
      return { jar, url: input.url };
    },
  };
}
