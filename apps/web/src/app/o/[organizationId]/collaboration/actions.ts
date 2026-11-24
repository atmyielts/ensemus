'use server';

import {
  AppError,
  confirmGrant,
  disposeInboundItem,
  publishItem,
  withdrawItem,
  endGrant,
  idSchema,
  previewGrantInvitation,
  setFederationEnabled,
} from '@ensemus/application';
import { loadTenancyConfig } from '@ensemus/config';
import {
  acceptInvitationSchema,
  confirmGrantSchema,
  endGrantSchema,
  proposeGrantSchema,
  publishItemSchema,
  redeemInvitationSchema,
  setFederationSettingsSchema,
} from '@ensemus/contracts/federation';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import {
  acceptGrantOnce,
  federationEntitlement,
  invitationDto,
  proposeGrantOnce,
} from '@/server/federation-api';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import { getRuntime, getStore } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';

async function scope(organizationId: string) {
  if (!loadTenancyConfig().crossOrgEnabled) notFound();
  const id = idSchema.safeParse(organizationId);
  if (!id.success) notFound();
  return { ...(await requireTenant(id.data)), path: '/o/' + id.data + '/collaboration' };
}

function errorFor(error: unknown): string {
  redirectForSsoRefusal(error);
  if (error instanceof AppError) return error.code;
  getRuntime().log.error('federation.action_failed', { errorCode: errorCode(error) });
  return 'UNEXPECTED';
}
const text = (form: FormData, key: string) => String(form.get(key) ?? '');
const integer = (form: FormData, key: string) => {
  const raw = text(form, key);
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
};

export type ProposalState = { error?: string; token?: string };
export async function proposeAction(_state: ProposalState, form: FormData): Promise<ProposalState> {
  const { database, context } = await scope(text(form, 'organizationId'));
  try {
    const body = proposeGrantSchema.safeParse({
      purpose: form.get('purpose'),
      max_classification: form.get('classification'),
      expires_in_days: integer(form, 'grantDays'),
      invitation_expires_in_days: integer(form, 'invitationDays'),
      note: text(form, 'note').trim() || undefined,
    });
    if (!body.success) throw new AppError('INVALID_INPUT');
    const { token } = await proposeGrantOnce(database, context, text(form, 'requestKey'), {
      purpose: body.data.purpose,
      maxClassification: body.data.max_classification,
      expiresInDays: body.data.expires_in_days,
      invitationExpiresInDays: body.data.invitation_expires_in_days,
      note: body.data.note ?? null,
    });
    return { token };
  } catch (error) {
    return { error: errorFor(error) };
  }
}

export type InvitationState = {
  error?: string;
  token?: string;
  preview?: ReturnType<typeof invitationDto>;
};
export async function previewAction(
  _state: InvitationState,
  form: FormData,
): Promise<InvitationState> {
  const { database, context } = await scope(text(form, 'organizationId'));
  try {
    const body = redeemInvitationSchema.safeParse({ token: text(form, 'invitation').trim() });
    if (!body.success) throw new AppError('FEDERATION_INVITATION_INVALID');
    const preview = await previewGrantInvitation(database, context, body.data);
    return { token: body.data.token, preview: invitationDto(preview) };
  } catch (error) {
    return { error: errorFor(error) };
  }
}

export async function updateCollaboration(org: string, form: FormData) {
  const { database, context, path } = await scope(org);
  const action = text(form, 'operation');
  let errorCode: string | undefined;
  try {
    if (action === 'enable' || action === 'disable') {
      const input = setFederationSettingsSchema.safeParse({
        enabled: action === 'enable',
        expected_version: integer(form, 'version'),
      });
      if (!input.success || (action === 'disable' && form.get('confirm') !== 'yes'))
        throw new AppError('INVALID_INPUT');
      await setFederationEnabled(
        database,
        context,
        {
          enabled: input.data.enabled,
          expectedVersion: input.data.expected_version,
        },
        federationEntitlement(database),
      );
    } else {
      if (form.get('confirm') !== 'yes') throw new AppError('INVALID_INPUT');
      if (action === 'accept') {
        const body = acceptInvitationSchema.safeParse({
          token: form.get('invitation'),
          terms_hash: form.get('termsHash'),
        });
        if (!body.success) throw new AppError('INVALID_INPUT');
        await acceptGrantOnce(database, context, text(form, 'requestKey'), {
          token: body.data.token,
          termsHash: body.data.terms_hash,
        });
      } else {
        const grant = idSchema.safeParse(form.get('grantId'));
        if (!grant.success) throw new AppError('INVALID_INPUT');
        const expected_version = integer(form, 'version');
        if (action === 'activate') {
          const input = confirmGrantSchema.safeParse({
            expected_version,
            terms_hash: form.get('termsHash'),
          });
          if (!input.success) throw new AppError('INVALID_INPUT');
          await confirmGrant(database, context, {
            grantId: grant.data,
            expectedVersion: input.data.expected_version,
            termsHash: input.data.terms_hash,
          });
        } else if (action === 'end') {
          const input = endGrantSchema.safeParse({ expected_version, reason: form.get('reason') });
          if (!input.success) throw new AppError('INVALID_INPUT');
          await endGrant(database, context, {
            grantId: grant.data,
            expectedVersion: input.data.expected_version,
            reason: input.data.reason,
          });
        } else {
          throw new AppError('INVALID_INPUT');
        }
      }
    }
    revalidatePath(path);
  } catch (error) {
    errorCode = errorFor(error);
  }
  redirect(path + (errorCode ? '?error=' + encodeURIComponent(errorCode) : '?saved=1'));
}

export async function updateSharedItem(org: string, grantId: string, form: FormData) {
  const { database, context, path } = await scope(org);
  const grant = idSchema.safeParse(grantId);
  if (!grant.success) notFound();
  const location = path + '/' + grant.data;
  const operation = text(form, 'operation');
  let error: string | undefined;
  try {
    if (operation === 'send') {
      const kind = text(form, 'kind');
      const title = text(form, 'title');
      const note = text(form, 'note').trim();
      const item = publishItemSchema.safeParse(
        kind === 'work_summary'
          ? {
              kind,
              title,
              work_unit_id: form.get('workId'),
              body: { ...(note ? { objective: note } : {}) },
            }
          : kind === 'artifact'
            ? { kind, title, artifact_id: form.get('artifactId') }
            : {
                kind,
                title,
                classification: form.get('classification'),
                body: { state: form.get('state'), ...(note ? { note } : {}) },
              },
      );
      if (!item.success) throw new AppError('INVALID_INPUT');
      await publishItem(database, getStore(), context, {
        grantId: grant.data,
        item: item.data,
        requestKey: text(form, 'requestKey'),
      });
    } else {
      const id = idSchema.safeParse(form.get('itemId'));
      const expectedVersion = integer(form, 'version');
      if (!id.success || expectedVersion === undefined) throw new AppError('INVALID_INPUT');
      if (operation === 'withdraw' && form.get('confirm') === 'yes') {
        await withdrawItem(database, context, { itemId: id.data, expectedVersion });
      } else if (operation === 'accepted' || operation === 'rejected') {
        await disposeInboundItem(database, context, {
          itemId: id.data,
          disposition: operation,
          expectedVersion,
          linkedWorkUnitId: null,
        });
      } else {
        throw new AppError('INVALID_INPUT');
      }
    }
    revalidatePath(location);
  } catch (failure) {
    error = errorFor(failure);
  }
  redirect(
    location +
      (error ? '?error=' + encodeURIComponent(error) : '?saved=' + encodeURIComponent(operation)),
  );
}
