'use server';
import {
  AppError,
  canonicalId,
  idSchema,
  addTrustedSigner,
  revokeTrustedSigner,
  auditRefusal,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import { addTrustedSignerSchema } from '@ensemus/contracts/skills';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { stepUpPath } from '@/lib/step-up';
import { requireTenant } from '@/server/tenant';
import { getRuntime } from '@/server/runtime';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import type { SignerFormState } from './form-state';
const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, name: string) => canonicalId(text(form, name));
const back = (id: string) => `/o/${id}/settings/skills/signers`;
function organization(form: FormData) {
  const parsed = idSchema.safeParse(idOf(form, 'organizationId'));
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}
async function refusal(
  database: AppDatabase,
  context: TenantContext,
  error: unknown,
): Promise<string> {
  if (isAuditedRefusal(error))
    await auditRefusal(database, context, { code: refusalCode(error), surface: 'web' }).catch(
      (failure: unknown) =>
        getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
    );
  redirectForSsoRefusal(error);
  if (error instanceof AppError) {
    if (error.code === 'RESTORE_PENDING') redirect('/restoring');
    if (error.code === 'MFA_REQUIRED')
      redirect(stepUpPath(context.organizationId, back(context.organizationId)));
    return error.code;
  }
  getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
  return 'UNEXPECTED';
}
export async function addSignerAction(
  _previous: SignerFormState,
  form: FormData,
): Promise<SignerFormState> {
  const id = organization(form),
    { database, context } = await requireTenant(id);
  const body = addTrustedSignerSchema.safeParse({
    display_name: text(form, 'displayName'),
    public_key_base64: text(form, 'publicKey'),
  });
  if (!body.success) return { code: 'SKILL_SIGNER_KEY_INVALID' };
  try {
    const publicKey = Buffer.from(body.data.public_key_base64, 'base64');
    if (publicKey.toString('base64') !== body.data.public_key_base64)
      throw new AppError('SKILL_SIGNER_KEY_INVALID');
    const row = await addTrustedSigner(database, context, getSkillFeatureGate(), {
      displayName: body.data.display_name,
      publicKey,
    });
    revalidatePath(back(id));
    return { added: { displayName: row.displayName, keyId: row.keyId } };
  } catch (error) {
    return { code: await refusal(database, context, error) };
  }
}
export async function revokeSignerAction(form: FormData): Promise<void> {
  const id = organization(form),
    { database, context } = await requireTenant(id);
  let code: string | null = null;
  try {
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    await revokeTrustedSigner(database, context, {
      signerId: idOf(form, 'signerId'),
      expectedVersion: Number(text(form, 'version')),
    });
    revalidatePath(back(id));
  } catch (error) {
    code = await refusal(database, context, error);
  }
  redirect(code ? `${back(id)}?error=${encodeURIComponent(code)}` : back(id));
}
