// Native second-factor setup for stack tests, the way a person does it: the real security page, a
// generated authenticator secret and a real code. 0404 makes model probes, qualifications and agent
// publication always-MFA actions, so a stack journey that reaches them enrolls first, as a browser
// would. No auth-role receipt is written by hand and no session UUID is copied into a request.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { BASE, PASSWORD, assembled, formsIn, post, submit, type Person } from './forms';
import { nativePersonContext } from './product';
import { previousTotpFromUri } from './totp';

/**
 * Turns on an authenticator app for this person through `/o/{organization}/security/two-factor`. The
 * confirmation is itself the recent second-factor proof for the session in the person's jar.
 */
export async function enrollAuthenticator(person: Person, organizationId: string): Promise<void> {
  const security = `/o/${organizationId}/security/two-factor`;
  const prepared = await submit(security, person.jar, /Set up authenticator app/, {
    password: PASSWORD,
  });
  const setup = assembled(await prepared.text());
  const uri = /href="(otpauth:\/\/[^"]+)"/.exec(setup)?.[1]?.replaceAll('&amp;', '&');
  if (!uri) throw new Error('TEST_NATIVE_MFA_SETUP_MISSING');
  const confirmation = formsIn(setup).filter((form) => /Confirm and turn on/.test(form.html));
  if (confirmation.length !== 1) throw new Error('TEST_NATIVE_MFA_CONFIRMATION_MISSING');
  const confirmed = await post(security, person.jar, confirmation[0]!, {
    kind: 'totp',
    code: await previousTotpFromUri(uri),
  });
  if (
    confirmed.status !== 303 ||
    confirmed.headers.get('location') !== `/o/${organizationId}/security?notice=enrolled`
  )
    throw new Error(`TEST_NATIVE_MFA_NOT_ENROLLED_${confirmed.status}`);
}

/** The person's current browser session, as the native verifier reads it. */
export async function nativeSessionOf(person: Person) {
  const response = await fetch(`${BASE}/api/auth/get-session`, {
    headers: { cookie: person.jar.cookie },
  });
  const body = (await response.json()) as {
    user?: { id?: unknown };
    session?: { id?: unknown };
  };
  if (!response.ok || typeof body.user?.id !== 'string' || typeof body.session?.id !== 'string')
    throw new Error('TEST_NATIVE_SESSION_REFUSED');
  return { userId: body.user.id, sessionId: body.session.id };
}

/**
 * A tenant context carrying this person's actual interactive session, through the native verifier
 * handoff (never a constructed brand), for seeds that write as that person in the same session.
 */
export async function nativeStackContext(
  database: AppDatabase,
  person: Person,
  organizationId: string,
): Promise<TenantContext> {
  return nativePersonContext(database, await nativeSessionOf(person), organizationId);
}
