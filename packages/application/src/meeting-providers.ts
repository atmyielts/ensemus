import { approveProviderSchema, type ApproveProviderBody } from '@ensemus/contracts/meetings';
import {
  connections,
  meetingProviderApprovals,
  modelProfiles,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  canAdministerMeetings,
  modelProfileRef,
  type MeetingPurpose,
  type ProviderApprovalKind,
} from '@ensemus/domain/meeting';
import {
  MEETING_PROVIDER_APPROVED,
  MEETING_PROVIDER_REVOKED,
} from '@ensemus/domain/expansion-events';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { AppError } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { withMeetingPerson } from './meeting-manual';
import type { ProviderApprovalView } from './meetings';
import { assertInteractivePrivilege } from './product/privileged';
import { auditAction } from './work';

type ApprovalInput =
  | {
      kind: 'model';
      modelProfileId: string;
      purposes: readonly ('summarize' | 'extract_items')[];
      maxClassification: ProviderApprovalView['maxClassification'];
      termsRef: string;
      expiresAt: Date;
    }
  | {
      kind: 'source';
      connectionId: string;
      maxClassification: ProviderApprovalView['maxClassification'];
      termsRef: string;
      expiresAt: Date;
    };

function approvalView(row: typeof meetingProviderApprovals.$inferSelect): ProviderApprovalView {
  return {
    id: row.id,
    kind: row.kind as ProviderApprovalKind,
    targetRef: row.targetRef,
    purposes: row.purposes as MeetingPurpose[],
    maxClassification: row.maxClassification as ProviderApprovalView['maxClassification'],
    termsRef: row.termsRef,
    approvedByMembershipId: row.approvedByMembershipId,
    approvedAt: row.approvedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

function requireAdministrator(role: string) {
  if (!canAdministerMeetings(role)) throw new AppError('FORBIDDEN');
}

function approvalId(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

function approvalInput(input: ApprovalInput): ApproveProviderBody {
  const common = {
    max_classification: input.maxClassification,
    terms_ref: input.termsRef,
    expires_at: Number.isFinite(input.expiresAt.getTime()) ? input.expiresAt.toISOString() : null,
  };
  const parsed = approveProviderSchema.safeParse(
    input.kind === 'model'
      ? {
          ...common,
          kind: input.kind,
          model_profile_id: input.modelProfileId,
          purposes: input.purposes,
        }
      : { ...common, kind: input.kind, connection_id: input.connectionId },
  );
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

function approvalIs(context: TenantContext, id: string) {
  return and(
    eq(meetingProviderApprovals.organizationId, context.organizationId),
    eq(meetingProviderApprovals.id, id),
  );
}

export function listMeetingProviderTargets(database: AppDatabase, context: TenantContext) {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    requireAdministrator(viewer.role);
    const models = await tx
      .select({ id: modelProfiles.id, name: modelProfiles.alias, status: modelProfiles.status })
      .from(modelProfiles)
      .where(eq(modelProfiles.organizationId, context.organizationId))
      .orderBy(asc(modelProfiles.alias));
    const sources = await tx
      .select({ id: connections.id, name: connections.displayName, status: connections.state })
      .from(connections)
      .where(
        and(
          eq(connections.organizationId, context.organizationId),
          eq(connections.connectorType, 'meeting_notes_http'),
          isNull(connections.ownerMembershipId),
        ),
      )
      .orderBy(asc(connections.displayName));
    return { models, sources };
  });
}

export function listMeetingProviderApprovals(database: AppDatabase, context: TenantContext) {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    requireAdministrator(viewer.role);
    const rows = await tx
      .select()
      .from(meetingProviderApprovals)
      .where(eq(meetingProviderApprovals.organizationId, context.organizationId))
      .orderBy(desc(meetingProviderApprovals.approvedAt), desc(meetingProviderApprovals.id));
    return rows.map(approvalView);
  });
}

export function getMeetingProviderApproval(
  database: AppDatabase,
  context: TenantContext,
  id: string,
) {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    requireAdministrator(viewer.role);
    const [row] = await tx
      .select()
      .from(meetingProviderApprovals)
      .where(approvalIs(context, approvalId(id)));
    if (!row) throw new AppError('NOT_FOUND');
    return approvalView(row);
  });
}

export function approveMeetingProvider(
  database: AppDatabase,
  context: TenantContext,
  raw: ApprovalInput,
) {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    requireAdministrator(viewer.role);
    const input = approvalInput(raw);
    await assertInteractivePrivilege(tx, context, 'meeting.manage');
    let targetRef: string;
    let purposes: MeetingPurpose[];
    if (input.kind === 'model') {
      const [profile] = await tx
        .select({ id: modelProfiles.id, status: modelProfiles.status })
        .from(modelProfiles)
        .where(
          and(
            eq(modelProfiles.organizationId, context.organizationId),
            eq(modelProfiles.id, input.model_profile_id),
          ),
        );
      if (!profile) throw new AppError('NOT_FOUND');
      if (profile.status !== 'active') throw new AppError('MODEL_PROFILE_NOT_ACTIVE');
      targetRef = modelProfileRef(profile.id);
      purposes = [...new Set(input.purposes)];
    } else {
      const [source] = await tx
        .select({
          id: connections.id,
          kind: connections.connectorType,
          state: connections.state,
          owner: connections.ownerMembershipId,
        })
        .from(connections)
        .where(
          and(
            eq(connections.organizationId, context.organizationId),
            eq(connections.id, input.connection_id),
          ),
        );
      if (!source || source.kind !== 'meeting_notes_http' || source.owner !== null)
        throw new AppError('NOT_FOUND');
      if (source.state !== 'active') throw new AppError('CONNECTION_NOT_ACTIVE');
      targetRef = 'connection:' + source.id;
      purposes = ['import_notes'];
    }
    const approvedAt = new Date();
    const expiresAt = new Date(input.expires_at);
    if (expiresAt <= approvedAt) throw new AppError('INVALID_INPUT');
    const [row] = await tx
      .insert(meetingProviderApprovals)
      .values({
        organizationId: context.organizationId,
        kind: input.kind,
        targetRef,
        purposes,
        maxClassification: input.max_classification,
        termsRef: input.terms_ref,
        approvedByMembershipId: viewer.membershipId,
        approvedAt,
        expiresAt,
      })
      .returning();
    if (!row) throw new AppError('INVALID_STATE');
    await recordChange(tx, context, row.id, MEETING_PROVIDER_APPROVED, 1);
    return approvalView(row);
  });
}

export function revokeMeetingProvider(
  database: AppDatabase,
  context: TenantContext,
  input: { providerApprovalId: string },
): Promise<void> {
  return withMeetingPerson(database, context, async (tx, viewer) => {
    requireAdministrator(viewer.role);
    const id = approvalId(input.providerApprovalId);
    await assertInteractivePrivilege(tx, context, 'meeting.manage');
    const [row] = await tx
      .select({ revokedAt: meetingProviderApprovals.revokedAt })
      .from(meetingProviderApprovals)
      .where(approvalIs(context, id))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.revokedAt) return;
    await tx
      .update(meetingProviderApprovals)
      .set({ revokedAt: new Date(), revokedByMembershipId: viewer.membershipId })
      .where(approvalIs(context, id));
    await recordChange(tx, context, id, MEETING_PROVIDER_REVOKED, 2);
  });
}

async function recordChange(
  tx: Tx,
  context: TenantContext,
  id: string,
  event: typeof MEETING_PROVIDER_APPROVED | typeof MEETING_PROVIDER_REVOKED,
  version: number,
) {
  await emit(tx, context, {
    eventType: event,
    aggregateType: 'meeting_provider_approval',
    aggregateId: id,
    aggregateVersion: version,
    classification: 'internal',
    payload: { provider_approval_id: id },
  });
  await auditAction(tx, context, event, 'meeting_provider_approval:' + id);
}
