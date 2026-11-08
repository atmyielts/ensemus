'use server';

import { getAccountSecurityPolicy } from '@ensemus/application/saas/security';
import type { MfaResponse } from '@ensemus/auth/mfa';
import { stepUpSchema } from '@ensemus/contracts/identity-admin';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { SecretState } from '@/components/security/security-types';
import { accountEnrollmentPath, accountStepUpPath, safeAccountStepUpReturn } from '@/lib/step-up';
import { getRuntime } from './runtime';
import { requireAccountTenant } from './tenant';

const field = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
const factorError = (result: MfaResponse) =>
  result.outcome === 'rate_limited'
    ? 'rate'
    : result.outcome === 'not_enrolled'
      ? 'enroll'
      : result.outcome === 'primary_required'
        ? 'primary'
        : result.outcome === 'setup_conflict'
          ? 'setup'
          : result.outcome === 'already_enrolled'
            ? 'already'
            : 'code';
async function forwardCookies(result: MfaResponse) {
  const jar = await cookies();
  for (const [name, value] of parseSetCookieHeader(result.setCookie ?? ''))
    jar.set(name, value.value, toCookieOptions(value));
}

/** Fixed account entry point; a submitted field can never select core/account authority. */
export async function confirmAccountIdentityAction(organizationId: string, form: FormData) {
  const { actor } = await requireAccountTenant(organizationId),
    next = safeAccountStepUpReturn(organizationId, field(form, 'next'));
  const input = stepUpSchema.safeParse({
    code: field(form, 'code').trim(),
    kind: field(form, 'kind') || 'totp',
  });
  let error = 'code';
  if (input.success)
    try {
      const result = await getRuntime().mfa.verifyStepUp(
        input.data,
        { sessionId: actor.sessionId, userId: actor.userId },
        await headers(),
      );
      if (result === 'verified') redirect(next);
      error = result === 'rate_limited' ? 'rate' : result === 'not_enrolled' ? 'enroll' : 'code';
    } catch (failure) {
      if (failure instanceof Error && 'digest' in failure) throw failure;
      error = 'unavailable';
    }
  redirect(`${accountStepUpPath(organizationId, next)}&error=${error}`);
}

/** Same real enrollment/primary-proof checks as core. Secret state exists only in this POST response. */
export async function enableAccountSecondFactorAction(
  organizationId: string,
  _next: string,
  _state: SecretState,
  form: FormData,
): Promise<SecretState> {
  const { actor, database, context } = await requireAccountTenant(organizationId);
  try {
    const policy = await getAccountSecurityPolicy(database, context),
      result = await getRuntime().mfa.enable(
        { password: field(form, 'password'), maxAgeSeconds: policy.mfaMaxAgeSeconds },
        { userId: actor.userId, sessionId: actor.sessionId },
        await headers(),
      );
    if (result.outcome !== 'verified' || !result.totpURI || !result.backupCodes)
      return { status: 'error', error: factorError(result) };
    const secret = new URL(result.totpURI).searchParams.get('secret');
    if (!secret) return { status: 'error', error: 'unavailable' };
    await forwardCookies(result);
    return { status: 'ready', totpURI: result.totpURI, secret, backupCodes: result.backupCodes };
  } catch {
    return { status: 'error', error: 'unavailable' };
  }
}

export async function finishAccountEnrollmentAction(
  organizationId: string,
  returnTo: string,
  form: FormData,
) {
  const { actor, database, context } = await requireAccountTenant(organizationId),
    next = safeAccountStepUpReturn(organizationId, returnTo);
  let error = 'code';
  if (/^[0-9]{6}$/.test(field(form, 'code').trim()))
    try {
      const policy = await getAccountSecurityPolicy(database, context),
        result = await getRuntime().mfa.confirmEnrollment(
          { code: field(form, 'code').trim(), maxAgeSeconds: policy.mfaMaxAgeSeconds },
          { sessionId: actor.sessionId, userId: actor.userId },
          await headers(),
        );
      if (result.outcome === 'verified') {
        await forwardCookies(result);
        redirect(next);
      }
      error = factorError(result);
    } catch (failure) {
      if (failure instanceof Error && 'digest' in failure) throw failure;
      error = 'unavailable';
    }
  redirect(`${accountEnrollmentPath(organizationId, next)}&error=${error}`);
}
