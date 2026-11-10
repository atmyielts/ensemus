'use server';

import { redirectForSsoRefusal } from './interactive-refusal';
import { AppError } from '@ensemus/application';
import { getSecurityPolicy, updateSecurityPolicy } from '@ensemus/application/security-policy';
import { stepUpSchema, updateSecurityPolicySchema } from '@ensemus/contracts/identity-admin';
import type { MfaResponse } from '@ensemus/auth/mfa';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeReturnPath, withReturnPath } from '@/lib/return-path';
import { safeStepUpReturn, stepUpPath } from '@/lib/step-up';
import type { SecretState } from '@/components/security/security-types';
import { getRuntime } from './runtime';
import { requireTenant } from './tenant';

const field = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
const code = (form: FormData) =>
  stepUpSchema.safeParse({ code: field(form, 'code').trim(), kind: field(form, 'kind') || 'totp' });
async function forwardCookies(result: MfaResponse) {
  const jar = await cookies();
  for (const [name, value] of parseSetCookieHeader(result.setCookie ?? ''))
    jar.set(name, value.value, toCookieOptions(value));
}
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
export async function completeTwoFactorSignInAction(form: FormData) {
  const next = safeReturnPath(field(form, 'next')),
    input = code(form);
  let error = 'code';
  if (input.success)
    try {
      const result = await getRuntime().mfa.completeSignIn(input.data, await headers());
      if (result.outcome === 'verified') {
        await forwardCookies(result);
        redirect(next ?? '/');
      }
      error = factorError(result);
    } catch (failure) {
      if (failure instanceof Error && 'digest' in failure) throw failure;
      error = 'unavailable';
    }
  redirect(withReturnPath(`/sign-in/two-factor?error=${error}`, next));
}
export async function confirmIdentityAction(organizationId: string, form: FormData) {
  const { actor } = await requireTenant(organizationId);
  const next = safeStepUpReturn(organizationId, field(form, 'next'));
  const input = code(form);
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
  redirect(`${stepUpPath(organizationId, next)}&error=${error}`);
}
/** React's action-state response is no-store in Next's action handler. Secrets never enter a URL,
 * cookie, log, event, storage or retained form value; a fresh GET has an empty enrollment state. */
export async function enableSecondFactorAction(
  organizationId: string,
  _state: SecretState,
  form: FormData,
): Promise<SecretState> {
  const { actor, context, database } = await requireTenant(organizationId);
  try {
    const policy = await getSecurityPolicy(database, context);
    const result = await getRuntime().mfa.enable(
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
export async function finishEnrollmentAction(organizationId: string, form: FormData) {
  const { actor, context, database } = await requireTenant(organizationId);
  let error = 'code';
  if (/^[0-9]{6}$/.test(field(form, 'code').trim()))
    try {
      const policy = await getSecurityPolicy(database, context);
      const result = await getRuntime().mfa.confirmEnrollment(
        { code: field(form, 'code').trim(), maxAgeSeconds: policy.mfaMaxAgeSeconds },
        { sessionId: actor.sessionId, userId: actor.userId },
        await headers(),
      );
      if (result.outcome === 'verified') {
        await forwardCookies(result);
        redirect(`/o/${organizationId}/security?notice=enrolled`);
      }
      error = factorError(result);
    } catch (failure) {
      if (failure instanceof Error && 'digest' in failure) throw failure;
      error = 'unavailable';
    }
  redirect(`/o/${organizationId}/security/two-factor?error=${error}`);
}
export async function regenerateRecoveryCodesAction(
  organizationId: string,
  _state: SecretState,
  form: FormData,
): Promise<SecretState> {
  const { actor } = await requireTenant(organizationId);
  const input = code(form);
  if (!input.success) return { status: 'error', error: 'code' };
  try {
    const result = await getRuntime().mfa.regenerateBackupCodes(
      { ...input.data, password: field(form, 'password') },
      { sessionId: actor.sessionId, userId: actor.userId },
      await headers(),
    );
    if (result.outcome !== 'verified' || !result.backupCodes)
      return { status: 'error', error: factorError(result) };
    await forwardCookies(result);
    return { status: 'ready', backupCodes: result.backupCodes };
  } catch {
    return { status: 'error', error: 'unavailable' };
  }
}
export async function disableSecondFactorAction(organizationId: string, form: FormData) {
  const { actor } = await requireTenant(organizationId);
  const input = code(form);
  let error = 'code';
  if (input.success)
    try {
      const result = await getRuntime().mfa.disable(
        { ...input.data, password: field(form, 'password') },
        { sessionId: actor.sessionId, userId: actor.userId },
        await headers(),
      );
      if (result.outcome === 'verified') {
        await forwardCookies(result);
        redirect(`/o/${organizationId}/security?notice=disabled`);
      }
      error = factorError(result);
    } catch (failure) {
      if (failure instanceof Error && 'digest' in failure) throw failure;
      error = 'unavailable';
    }
  redirect(`/o/${organizationId}/security/two-factor?error=${error}`);
}
export async function updateSecurityPolicyAction(organizationId: string, form: FormData) {
  const { actor, context, database } = await requireTenant(organizationId);
  const parsed = updateSecurityPolicySchema.safeParse({
    mfa_for_administration: form.get('mfaForAdministration') === 'on',
    mfa_max_age_seconds: Number(field(form, 'mfaMaxAgeSeconds')),
    sso_enforcement: field(form, 'ssoEnforcement'),
  });
  let error = 'INVALID_INPUT';
  if (parsed.success)
    try {
      await updateSecurityPolicy(
        database,
        context,
        { sessionId: actor.sessionId },
        {
          expectedVersion: Number(field(form, 'version')),
          mfaForAdministration: parsed.data.mfa_for_administration,
          mfaMaxAgeSeconds: parsed.data.mfa_max_age_seconds,
          ssoEnforcement: parsed.data.sso_enforcement,
        },
      );
      redirect(`/o/${organizationId}/security?notice=saved`);
    } catch (failure) {
      if (failure instanceof Error && 'digest' in failure) throw failure;
      redirectForSsoRefusal(failure);
      if (failure instanceof AppError) {
        if (failure.code === 'MFA_REQUIRED')
          redirect(stepUpPath(organizationId, `/o/${organizationId}/security`));
        error = failure.code;
      } else error = 'UNEXPECTED';
    }
  redirect(`/o/${organizationId}/security?error=${encodeURIComponent(error)}`);
}
