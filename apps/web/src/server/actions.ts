'use server';

import { idSchema } from '@ensemus/application';
import type { CredentialForm } from '@ensemus/auth';
import { organizationNameSchema } from '@ensemus/contracts';
import { createOrganization } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
import { requireActor } from './actor';
import { getRuntime } from './runtime';

// Every action is a public endpoint: each one validates input and resolves the actor itself. None
// captures values in a closure, so nothing sensitive is ever serialized to the browser.

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/**
 * Submits the form through the same limit as /api/auth, passes on any session it made, and says which
 * error the page should show. A failure says nothing more than a refusal would.
 */
async function submitForm(form: CredentialForm, event: string): Promise<string | null> {
  const { log, submitCredentials } = getRuntime();
  try {
    const { outcome, status, setCookie } = await submitCredentials(form, await headers());
    if (outcome === 'accepted' || outcome === 'two_factor') {
      const jar = await cookies();
      for (const [name, value] of parseSetCookieHeader(setCookie ?? '')) {
        jar.set(name, value.value, toCookieOptions(value));
      }
      return outcome === 'two_factor' ? 'two_factor' : null;
    }
    log.info(event, { errorCode: `HTTP_${status}` });
    return outcome === 'rate_limited' ? 'rate' : 'invalid';
  } catch (error) {
    log.info(event, { errorCode: errorCode(error) });
    return 'invalid';
  }
}

export async function signInAction(form: FormData) {
  const next = safeReturnPath(field(form, 'next'));
  const error = await submitForm(
    {
      path: '/sign-in/email',
      body: { email: field(form, 'email'), password: field(form, 'password') },
    },
    'auth.sign_in_failed',
  );
  if (error === 'two_factor') redirect(withReturnPath('/sign-in/two-factor', next));
  redirect(error ? withReturnPath(`/sign-in?error=${error}`, next) : (next ?? '/'));
}

export async function signUpAction(form: FormData) {
  const { config } = getRuntime();
  const next = safeReturnPath(field(form, 'next'));
  if (!config.allowSignup) redirect(withReturnPath('/sign-in', next));
  const error = await submitForm(
    {
      path: '/sign-up/email',
      body: {
        name: field(form, 'name'),
        email: field(form, 'email'),
        password: field(form, 'password'),
      },
    },
    'auth.sign_up_failed',
  );
  redirect(error ? withReturnPath(`/sign-up?error=${error}`, next) : (next ?? '/'));
}

/**
 * Makes one account from a setup code the operator issued, whether or not sign-up is open (ID-01). The
 * code goes in the form and never in a URL, where it would stay in history and in proxy logs.
 */
export async function completeSetupAction(form: FormData) {
  const { redeemSetupToken } = getRuntime();
  const next = safeReturnPath(field(form, 'next'));
  const outcome = await redeemSetupToken(
    {
      token: field(form, 'code').trim(),
      name: field(form, 'name'),
      email: field(form, 'email'),
      password: field(form, 'password'),
    },
    await headers(),
  );
  redirect(
    outcome === 'created'
      ? (next ?? '/')
      : withReturnPath(
          outcome === 'invalid_token' ? '/setup?error=code' : '/setup?error=details',
          next,
        ),
  );
}

/** The invitation page signs out here to switch account, and keeps its place by sending `next`. */
export async function signOutAction(form?: FormData) {
  await getRuntime().auth.api.signOut({ headers: await headers() });
  redirect(withReturnPath('/sign-in', safeReturnPath(form?.get('next'))));
}

export async function createOrganizationAction(form: FormData) {
  const actor = await requireActor();
  const { app, config, log } = getRuntime();
  const name = organizationNameSchema.safeParse(field(form, 'name'));
  if (!name.success) redirect('/?error=name');
  // Only ever hashed into an ID. Something that is not a key just gets no protection from repeats.
  const requestKey = idSchema.safeParse(field(form, 'requestKey'));
  let target = '/?error=UNEXPECTED';
  try {
    const { organizationId } = await createOrganization(app, {
      userId: actor.userId,
      name: name.data,
      commercialMode: config.mode,
      ...(requestKey.success ? { requestKey: requestKey.data } : {}),
    });
    log.info('organization.created', { organizationId, userId: actor.userId });
    target = `/o/${organizationId}`;
  } catch (error) {
    log.error('organization.create_failed', { errorCode: errorCode(error) });
  }
  redirect(target);
}
