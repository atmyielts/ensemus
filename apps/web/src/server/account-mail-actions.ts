'use server';

// Account recovery and verification forms (0571). Every one goes through Better Auth's router, so its
// limits apply, and none says whether an address has an account. A token travels in the form and the
// path, never in a query string, and no page here echoes one back.
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { errorCode } from '@ensemus/telemetry';
import { getRuntime } from './runtime';
import { requireTenant } from './tenant';

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** A token is only ever a URL-safe string of a sensible length. Anything else is not one of ours. */
const TOKEN = /^[A-Za-z0-9._~-]{16,2048}$/;
const tokenOf = (form: FormData) => {
  const token = field(form, 'token');
  return TOKEN.test(token) ? token : null;
};

async function forwardCookies(setCookie: string | null) {
  if (!setCookie) return;
  const jar = await cookies();
  for (const [name, value] of parseSetCookieHeader(setCookie)) {
    jar.set(name, value.value, toCookieOptions(value));
  }
}

/** Always says the same thing, whether or not the address has an account. */
export async function forgotPasswordAction(form: FormData) {
  const { account, config, log } = getRuntime();
  if (!config.mailEnabled) redirect('/forgot-password');
  const email = field(form, 'email').trim().slice(0, 254);
  let outcome = 'done';
  try {
    outcome = await account.requestPasswordReset(email, await headers());
  } catch (error) {
    // The same answer as success: a failure here must not tell anyone that an account exists.
    log.error('auth.reset_request_failed', { errorCode: errorCode(error) });
  }
  redirect(outcome === 'rate_limited' ? '/forgot-password?error=rate' : '/forgot-password?sent=1');
}

export async function resetPasswordAction(form: FormData) {
  const { account } = getRuntime();
  const token = tokenOf(form);
  if (!token) redirect('/reset-password?state=invalid');
  const back = `/reset-password/${encodeURIComponent(token)}`;
  const password = field(form, 'password');
  if (password !== field(form, 'confirm')) redirect(`${back}?error=match`);
  const outcome = await account.resetPassword(token, password, await headers());
  if (outcome === 'done') redirect('/reset-password?state=done');
  if (outcome === 'weak') redirect(`${back}?error=weak`);
  if (outcome === 'rate_limited') redirect(`${back}?error=rate`);
  redirect('/reset-password?state=invalid');
}

/** Follows a verification link by a button, so a mail scanner opening the link changes nothing. */
export async function verifyEmailAction(form: FormData) {
  const { account } = getRuntime();
  const token = tokenOf(form);
  if (!token) redirect('/verify-email?state=invalid');
  const purpose = field(form, 'purpose');
  const { outcome, setCookie } = await account.verifyEmail(token, await headers());
  if (outcome === 'done') {
    await forwardCookies(setCookie);
    redirect(
      `/verify-email?state=${purpose === 'approve_change' ? 'approved' : purpose === 'finish_change' ? 'changed' : 'verified'}`,
    );
  }
  if (outcome === 'rate_limited') redirect(`/verify-email/${encodeURIComponent(token)}?error=rate`);
  redirect(`/verify-email?state=${outcome === 'expired' ? 'expired' : 'invalid'}`);
}

export async function resendVerificationAction(organizationId: string) {
  const { actor } = await requireTenant(organizationId);
  const { account, config } = getRuntime();
  const page = `/o/${organizationId}/security/email`;
  if (!config.mailEnabled || actor.emailVerified) redirect(page);
  const outcome = await account.resendVerification(actor.email, await headers());
  redirect(outcome === 'rate_limited' ? `${page}?error=rate` : `${page}?notice=sent`);
}

/** Needs the current password. Every other session ends, and the person is told by email. */
export async function changePasswordAction(organizationId: string, form: FormData) {
  const { actor } = await requireTenant(organizationId);
  const { account } = getRuntime();
  const page = `/o/${organizationId}/security/password`;
  const next = field(form, 'password');
  if (next !== field(form, 'confirm')) redirect(`${page}?error=match`);
  const { outcome, setCookie } = await account.changePassword(
    {
      userId: actor.userId,
      email: actor.email,
      name: actor.name,
      current: field(form, 'current'),
      next,
    },
    await headers(),
  );
  if (outcome === 'done') {
    await forwardCookies(setCookie);
    redirect(`${page}?notice=changed`);
  }
  redirect(
    `${page}?error=${outcome === 'invalid' ? 'current' : outcome === 'weak' ? 'weak' : outcome === 'rate_limited' ? 'rate' : 'failed'}`,
  );
}

/**
 * Needs the current password. Nothing changes yet: a verified address is asked to approve first, then
 * the new one proves itself. The answer is the same whether or not the new address is already in use.
 */
export async function changeEmailAction(organizationId: string, form: FormData) {
  const { actor } = await requireTenant(organizationId);
  const { account, config } = getRuntime();
  const page = `/o/${organizationId}/security/email`;
  if (!config.mailEnabled) redirect(page);
  const newEmail = field(form, 'email').trim().toLowerCase().slice(0, 254);
  if (!/^[^\s@]+@[^\s@]+$/.test(newEmail)) redirect(`${page}?error=address`);
  if (newEmail === actor.email.toLowerCase()) redirect(`${page}?error=same`);
  const outcome = await account.changeEmail(
    { userId: actor.userId, newEmail, password: field(form, 'password') },
    await headers(),
  );
  if (outcome === 'done') redirect(`${page}?notice=${actor.emailVerified ? 'approve' : 'verify'}`);
  redirect(
    `${page}?error=${outcome === 'invalid' ? 'password' : outcome === 'rate_limited' ? 'rate' : 'failed'}`,
  );
}
