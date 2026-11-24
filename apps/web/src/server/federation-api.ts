import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  acceptGrantInvitation,
  AppError,
  FEATURE_CROSS_ORG,
  getGrant,
  idSchema,
  noPlanGate,
  proposeGrant,
  requestHash,
  runIdempotent,
  type CrossingView,
  type InboundItemView,
  type OutboundItemView,
  type FederationGrantView,
  type FederationInvitationPreview,
  type FederationSettingsView,
  type ProposeGrantInput,
} from '@ensemus/application';
import { createEntitlementChecker } from '@ensemus/application/saas/entitlements';
import { loadSaasConfig, loadTenancyConfig } from '@ensemus/config';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { canonicalJson } from '@ensemus/domain/approval';
import type { GrantTerms } from '@ensemus/domain/federation';
import { type z } from 'zod';
import { type ApiScope, apiRoute, organizationParams, toErrorResponse } from './api';
import { studioOnce } from './studio-api';

export const grantParams = organizationParams.extend({ grantId: idSchema });
export const federationItemParams = organizationParams.extend({ federationItemId: idSchema });
export const federationHeaders = { 'Cache-Control': 'private, no-store' };

export function federationRoute<S extends z.ZodType<{ organizationId: string }>>(
  schema: S,
  handler: (scope: ApiScope<z.output<S>>) => Promise<Response>,
) {
  const route = apiRoute(schema, handler);
  return (...args: Parameters<typeof route>) => {
    if (loadTenancyConfig().crossOrgEnabled) return route(...args);
    const id = randomUUID();
    const response = toErrorResponse(new AppError('NOT_FOUND'), id);
    response.headers.set('X-Request-Id', id);
    response.headers.set('Cache-Control', federationHeaders['Cache-Control']);
    return response;
  };
}

export function federationEntitlement(database: AppDatabase) {
  if (!loadSaasConfig().billingEnabled) return noPlanGate;
  const checker = createEntitlementChecker(database, true);
  return {
    async allows(context: TenantContext) {
      return (await checker.check(context, FEATURE_CROSS_ORG)).ok;
    },
  };
}

export const settingsDto = (row: FederationSettingsView) => ({
  available: row.available,
  enabled: row.enabled,
  version: row.version,
  changed_at: row.changedAt?.toISOString() ?? null,
});

export const termsDto = (terms: GrantTerms) => ({
  terms_version: terms.terms_version,
  purpose: terms.purpose,
  max_classification: terms.max_classification,
  forward_kinds: terms.forward_kinds,
  return_kinds: terms.return_kinds,
  sharing_organization_id: terms.sharing_organization_id,
  sharing_display_name: terms.sharing_display_name,
  expires_at: terms.expires_at,
  note: terms.note,
});

export const grantDto = (row: FederationGrantView) => ({
  id: row.id,
  role: row.role,
  status: row.status,
  purpose: row.purpose,
  max_classification: row.maxClassification,
  terms: termsDto(row.terms),
  terms_hash: row.termsHash,
  expires_at: row.expiresAt.toISOString(),
  invitation_expires_at: row.invitationExpiresAt.toISOString(),
  counterparty_name: row.counterpartyName,
  counterparty_fingerprint: row.counterpartyFingerprint,
  proposed_at: row.proposedAt.toISOString(),
  accepted_at: row.acceptedAt?.toISOString() ?? null,
  confirmed_at: row.confirmedAt?.toISOString() ?? null,
  ended_at: row.endedAt?.toISOString() ?? null,
  end_reason: row.endReason,
  ended_by_us: row.endedByUs,
  version: row.version,
});

export const invitationDto = (row: FederationInvitationPreview) => ({
  terms_hash: row.termsHash,
  terms: termsDto(row.terms),
  sharing_display_name: row.sharingDisplayName,
  sharing_fingerprint: row.sharingFingerprint,
  invitation_expires_at: row.invitationExpiresAt.toISOString(),
});

export const outboundItemDto = (row: OutboundItemView) => ({
  id: row.id,
  grant_id: row.grantId,
  kind: row.kind,
  title: row.title,
  body: row.body,
  classification: row.classification,
  state: row.state,
  refuse_code: row.refuseCode,
  has_file: row.hasFile,
  created_at: row.createdAt.toISOString(),
  delivered_at: row.deliveredAt?.toISOString() ?? null,
  withdrawn_at: row.withdrawnAt?.toISOString() ?? null,
  version: row.version,
});

export const inboundItemDto = (row: InboundItemView) => ({
  id: row.id,
  grant_id: row.grantId,
  kind: row.kind,
  title: row.title,
  body: row.body,
  classification: row.classification,
  sender_name: row.senderName,
  sender_fingerprint: row.senderFingerprint,
  has_file: row.hasFile,
  file_size_bytes: row.fileSizeBytes,
  file_mime_type: row.fileMimeType,
  disposition: row.disposition,
  linked_work_unit_id: row.linkedWorkUnitId,
  received_at: row.receivedAt.toISOString(),
  version: row.version,
});

export const crossingDto = (row: CrossingView) => ({
  id: row.id,
  grant_id: row.grantId,
  item_id: row.itemId,
  direction: row.direction,
  kind: row.kind,
  outcome: row.outcome,
  code: row.code,
  content_sha256: row.contentSha256,
  crossed_at: row.crossedAt.toISOString(),
});

export function federationJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: federationHeaders });
}

export async function proposeGrantOnce(
  database: AppDatabase,
  context: TenantContext,
  key: string,
  input: ProposeGrantInput,
) {
  let created: Awaited<ReturnType<typeof proposeGrant>> | undefined;
  const result = await runIdempotent(
    database,
    context,
    { key, requestHash: requestHash(['federation.propose', canonicalJson(input)]) },
    async (db) => (created = await proposeGrant(db, context, input)),
    ({ grant }) => ({ status: 201, body: { id: grant.id } }),
  );
  if (result.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
  if (result.kind === 'replayed' || !created)
    throw new AppError('FEDERATION_INVITATION_ALREADY_ISSUED');
  return created;
}

export async function acceptGrantOnce(
  database: AppDatabase,
  context: TenantContext,
  key: string,
  input: { token: string; termsHash: string },
) {
  const accept = () =>
    studioOnce(database, context, key, 'federation.accept', input, (db) =>
      acceptGrantInvitation(db, context, input),
    );
  let id: string;
  try {
    id = await accept();
  } catch (error) {
    // A matching request can consume the invitation before this attempt locks the grant.
    if (!(error instanceof AppError) || error.code !== 'FEDERATION_INVITATION_INVALID') throw error;
    id = await accept();
  }
  return getGrant(database, context, id);
}
