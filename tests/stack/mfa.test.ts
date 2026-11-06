// Actual built HTTP forms + router + auth-role proof. Authored in source-only mode; not executed here.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BASE,
  PASSWORD,
  assembled,
  createOrganization,
  formOn,
  post,
  read,
  signUp,
  submit,
  visit,
  type Jar,
} from '../helpers/forms';
import { totpFromUri } from '../helpers/totp';

const setupUri = (html: string) => {
  const uri = /href="(otpauth:\/\/[^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
  if (!uri) throw new Error('MFA_SETUP_NOT_RENDERED');
  return uri;
};
const codes = (html: string) =>
  [...html.matchAll(/<code>([0-9A-Za-z]{5}-[0-9A-Za-z]{5})<\/code>/g)].map((match) => match[1]!);
async function enrolled() {
  const person = await signUp('Generated MFA person'),
    organization = await createOrganization(person, 'Generated MFA company'),
    path = `/o/${organization}/security/two-factor`;
  const prepared = await submit(path, person.jar, /Set up authenticator app/, {
    password: PASSWORD,
  });
  expect(prepared.status).toBe(200);
  expect(prepared.headers.get('cache-control')).toContain('no-store');
  const html = assembled(await prepared.text()),
    uri = setupUri(html),
    backupCodes = codes(html);
  expect(backupCodes).toHaveLength(10);
  const confirmed = await submit(path, person.jar, /Finish setup/, {
    kind: 'totp',
    code: totpFromUri(uri, Date.now() - 30000),
  });
  expect(confirmed.status).toBe(303);
  expect(confirmed.headers.get('location')).toBe(`/o/${organization}/security?notice=enrolled`);
  return { person, organization, uri, backupCodes, path };
}
describe('MFA through actual protected HTTP forms and tenant API', () => {
  it('enrolls without scripts, shows recovery material once with no-store, and writes only current-session proof', async () => {
    const value = await enrolled();
    const page = await read(value.path, value.person.jar);
    expect(page.html).toContain('Recovery codes');
    expect(page.html).not.toContain(value.uri);
    for (const code of value.backupCodes) expect(page.html).not.toContain(code);
    const policy = await visit(
      `/api/v1/organizations/${value.organization}/security-policy`,
      value.person.jar,
    );
    expect(policy.status).toBe(200);
    expect(policy.headers.get('etag')).toBe('"1"');
    const changed = await fetch(
      `${BASE}/api/v1/organizations/${value.organization}/security-policy`,
      {
        method: 'PATCH',
        headers: {
          cookie: value.person.jar.cookie,
          origin: BASE,
          'content-type': 'application/json',
          'if-match': '"1"',
        },
        body: JSON.stringify({
          mfa_for_administration: true,
          mfa_max_age_seconds: 300,
          sso_enforcement: 'optional',
        }),
      },
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      mfa_for_administration: true,
      mfa_max_age_seconds: 300,
      version: 2,
    });
    expect((await read(`/o/${value.organization}/security`, value.person.jar)).html).toContain(
      'Security settings',
    );
  });
  it('password sign-in yields only a challenge, then a current app code grants the session', async () => {
    const value = await enrolled(),
      jar: Jar = { cookie: '' };
    const password = await submit('/sign-in', jar, /name="password"/, {
      email: value.person.email,
      password: PASSWORD,
    });
    expect(password.headers.get('location')).toBe('/sign-in/two-factor');
    const before = await visit(`/o/${value.organization}/security`, jar);
    expect(before.headers.get('location')).toBe('/sign-in');
    const confirmed = await submit('/sign-in/two-factor', jar, /Confirm sign-in/, {
      kind: 'totp',
      code: totpFromUri(value.uri),
    });
    expect(confirmed.headers.get('location')).toBe('/');
    expect((await visit(`/o/${value.organization}/security`, jar)).status).toBe(200);
  });
  it('ignores forged proof fields and confines a successful step-up return to this company', async () => {
    const value = await enrolled(),
      path = `/o/${value.organization}/security/confirm?next=https%3A%2F%2Fevil.example.invalid`;
    const form = await formOn(path, value.person.jar, /Confirm and continue/);
    expect(form.hidden.get('next')).toBe(`/o/${value.organization}`);
    const response = await post(path, value.person.jar, form, {
      kind: 'backup_code',
      code: value.backupCodes[0]!,
      sessionId: randomUUID(),
      userId: randomUUID(),
      next: '/o/00000000-0000-4000-8000-000000000001/security',
    });
    expect(response.headers.get('location')).toBe(`/o/${value.organization}`);
    expect(
      (await visit(`/api/v1/organizations/${value.organization}/security-policy`, value.person.jar))
        .status,
    ).toBe(200);
  });
  it('closes raw factor bypass paths and hides another company policy', async () => {
    const value = await enrolled();
    for (const path of [
      'disable',
      'enable',
      'generate-backup-codes',
      'get-totp-uri',
      'view-backup-codes',
      'verify-totp',
      'verify-backup-code',
    ]) {
      const response = await fetch(`${BASE}/api/auth/two-factor/${path}`, {
        method: 'POST',
        headers: {
          cookie: value.person.jar.cookie,
          origin: BASE,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ password: PASSWORD, code: totpFromUri(value.uri) }),
      });
      expect(response.status, path).toBe(404);
    }
    const other = await signUp('Generated unrelated MFA person');
    expect(
      (await visit(`/api/v1/organizations/${value.organization}/security-policy`, other.jar))
        .status,
    ).toBe(404);
    const csrf = await post(
      value.path,
      value.person.jar,
      await formOn(value.path, value.person.jar, /Turn off two-step sign-in/),
      { password: PASSWORD, kind: 'backup_code', code: value.backupCodes[0]! },
      'https://evil.example.invalid',
    );
    expect(csrf.status).toBeGreaterThanOrEqual(400);
  });
});
