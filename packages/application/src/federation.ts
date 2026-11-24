import {
  deploymentProfile,
  federationGrants,
  federationOrgSettings,
  interactiveSessionOf,
  memberships,
  organizations,
  withGrantInvitationTx,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  buildGrantTerms,
  FEDERATION_CLASSIFICATIONS,
  FEDERATION_MAX_GRANT_DAYS,
  FEDERATION_MAX_INVITATION_DAYS,
  FEDERATION_PURPOSES,
  grantTermsHash,
  hashFederationToken,
  newFederationToken,
  organizationFingerprint,
  type FederationClassification,
  type FederationEndReason,
  type FederationGrantStatus,
  type FederationPurpose,
  type GrantTerms,
} from '@ensemus/domain/federation';
import {
  AGGREGATE_FEDERATION_GRANT,
  AGGREGATE_FEDERATION_SETTINGS,
  AUDIT_FEDERATION_DISABLED,
  AUDIT_FEDERATION_ENABLED,
  FEDERATION_GRANT_ACCEPTED,
  FEDERATION_GRANT_ACTIVATED,
  FEDERATION_GRANT_ENDED,
  FEDERATION_GRANT_PROPOSED,
  FEDERATION_SETTINGS_CHANGED,
  federationGrantTargetRef,
} from '@ensemus/domain/federation-events';
import { can, type Capability } from '@ensemus/domain/policy';
import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { AppError, pgCode, type ErrorCode } from './errors';
import { emit } from './events';
import type { CrossOrgEntitlement } from './federation-ports';
import { idSchema } from './ids';
import { assertInteractivePrivilege } from './product/privileged';
import { auditAction } from './work';

export type FederationSettingsView = {
  /** Whether this deployment offers it at all. When false, nothing else here can do anything. */
  available: boolean;
  enabled: boolean;
  /** 0 until someone has changed it, because a tenant starts with no row. */
  version: number;
  changedAt: Date | null;
};

export type FederationGrantView = {
  id: string;
  /** Which side this tenant is on. */
  role: 'sharing' | 'receiving';
  status: FederationGrantStatus;
  purpose: FederationPurpose;
  maxClassification: FederationClassification;
  terms: GrantTerms;
  termsHash: string;
  expiresAt: Date;
  invitationExpiresAt: Date;
  counterpartyName: string | null;
  counterpartyFingerprint: string | null;
  /** Each of these says who on this side consented, by name. Nothing about the other side's people. */
  proposedAt: Date;
  acceptedAt: Date | null;
  confirmedAt: Date | null;
  endedAt: Date | null;
  endReason: FederationEndReason | null;
  /** True when this side ended it. */
  endedByUs: boolean;
  version: number;
};

export type FederationInvitationPreview = {
  termsHash: string;
  terms: GrantTerms;
  sharingDisplayName: string;
  sharingFingerprint: string;
  invitationExpiresAt: Date;
};

export type ProposeGrantInput = {
  purpose: FederationPurpose;
  maxClassification: FederationClassification;
  expiresInDays: number;
  invitationExpiresInDays: number;
  note: string | null;
};

type Grant = typeof federationGrants.$inferSelect;
const openStates = ['proposed', 'accepted', 'active'];
const sqlErrors: Partial<Record<string, ErrorCode>> = {
  EN405: 'MFA_REQUIRED',
  EN410: 'SSO_REQUIRED',
  EN711: 'NOT_FOUND',
  EN713: 'FEDERATION_GRANT_NOT_OPEN',
  EN714: 'FEDERATION_DISABLED',
  EN715: 'FORBIDDEN',
  EN716: 'FEDERATION_GRANT_NOT_OPEN',
  EN717: 'FEDERATION_NOT_AVAILABLE',
  EN718: 'VERSION_CONFLICT',
  EN719: 'FEDERATION_OPEN_GRANTS',
  EN720: 'FEDERATION_TERMS_CHANGED',
  EN721: 'FORBIDDEN',
  '40001': 'VERSION_CONFLICT',
  '40P01': 'VERSION_CONFLICT',
};

async function boundary<T>(run: () => Promise<T>, invitation = false): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = pgCode(error);
    if (invitation && (code === 'EN713' || code === 'EN711' || code === 'EN716'))
      throw new AppError('FEDERATION_INVITATION_INVALID');
    const typed = code && sqlErrors[code];
    if (typed) throw new AppError(typed);
    throw error;
  }
}

async function requireCapability(tx: Tx, context: TenantContext, capability: Capability) {
  const refusal = capability === 'federation.view' ? 'NOT_FOUND' : 'FORBIDDEN';
  if (context.actorType !== 'user' || !interactiveSessionOf(context)) throw new AppError(refusal);
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, context.organizationId),
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    );
  if (!member || !can(member.role, capability)) throw new AppError(refusal);
  if (capability === 'federation.manage')
    await assertInteractivePrivilege(tx, context, 'organization.manage');
}

async function availableIn(tx: Tx) {
  const [profile] = await tx
    .select({ enabled: deploymentProfile.crossOrgEnabled })
    .from(deploymentProfile);
  return profile?.enabled === true;
}

async function settingsIn(tx: Tx, organizationId: string, lock = false) {
  const query = tx
    .select()
    .from(federationOrgSettings)
    .where(eq(federationOrgSettings.organizationId, organizationId));
  const [row] = await (lock ? query.for('no key update') : query);
  return row;
}

async function requireConsent(tx: Tx, context: TenantContext) {
  await requireCapability(tx, context, 'federation.manage');
  if (!(await availableIn(tx))) throw new AppError('FEDERATION_NOT_AVAILABLE');
  // Lock the switch before the grant, in the same order as disabling.
  if (!(await settingsIn(tx, context.organizationId, true))?.enabled)
    throw new AppError('FEDERATION_DISABLED');
}

type Settings = typeof federationOrgSettings.$inferSelect;
function settingsView(available: boolean, row: Settings | undefined): FederationSettingsView {
  return {
    available,
    enabled: row?.enabled ?? false,
    version: row?.version ?? 0,
    changedAt: row?.changedAt ?? null,
  };
}

export function getFederationSettings(database: AppDatabase, context: TenantContext) {
  return withTenantTx(database, context, async (tx) => {
    await requireCapability(tx, context, 'federation.view');
    return settingsView(await availableIn(tx), await settingsIn(tx, context.organizationId));
  });
}

const validVersion = (value: number, min = 1) => Number.isSafeInteger(value) && value >= min;
export function setFederationEnabled(
  database: AppDatabase,
  context: TenantContext,
  input: { enabled: boolean; expectedVersion: number },
  entitlement: CrossOrgEntitlement,
): Promise<FederationSettingsView> {
  return boundary(async () => {
    if (typeof input.enabled !== 'boolean' || !validVersion(input.expectedVersion, 0))
      throw new AppError('INVALID_INPUT');
    if (input.enabled) {
      // The entitlement adapter can use its own connection. Check before holding a write lock.
      await withTenantTx(database, context, async (tx) => {
        await requireCapability(tx, context, 'federation.manage');
        if (!(await availableIn(tx))) throw new AppError('FEDERATION_NOT_AVAILABLE');
      });
      if (!(await entitlement.allows(context))) throw new AppError('ENTITLEMENT_DENIED');
    }
    return withTenantTx(database, context, async (tx) => {
      await requireCapability(tx, context, 'federation.manage');
      const organizationId = context.organizationId;
      const available = await availableIn(tx);
      if (input.enabled && !available) throw new AppError('FEDERATION_NOT_AVAILABLE');
      const before = await settingsIn(tx, organizationId, true);
      const version = before?.version ?? 0;
      if (version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      if (input.enabled === (before?.enabled ?? false)) return settingsView(available, before);
      if (!input.enabled) await endAllGrantsInTx(tx, context);
      const change = {
        enabled: input.enabled,
        version: version + 1,
        changedAt: new Date(),
        changedByMembershipId: context.membershipId,
      };
      const [row] = await (before
        ? tx
            .update(federationOrgSettings)
            .set(change)
            .where(eq(federationOrgSettings.organizationId, organizationId))
            .returning()
        : tx
            .insert(federationOrgSettings)
            .values({ ...change, organizationId })
            .onConflictDoNothing()
            .returning());
      if (!row) throw new AppError('VERSION_CONFLICT');
      await emit(tx, context, {
        aggregateType: AGGREGATE_FEDERATION_SETTINGS,
        aggregateId: organizationId,
        aggregateVersion: row.version,
        classification: 'internal',
        eventType: FEDERATION_SETTINGS_CHANGED,
        payload: { enabled: row.enabled },
      });
      await auditAction(
        tx,
        context,
        row.enabled ? AUDIT_FEDERATION_ENABLED : AUDIT_FEDERATION_DISABLED,
        'federation:settings',
      );
      return settingsView(available, row);
    });
  });
}

const party = (org: string) =>
  or(
    eq(federationGrants.sharingOrganizationId, org),
    eq(federationGrants.receivingOrganizationId, org),
  );
function grantId(value: string) {
  const id = idSchema.safeParse(value);
  if (!id.success) throw new AppError('INVALID_INPUT');
  return id.data;
}

function view(row: Grant, organizationId: string): FederationGrantView {
  const sharing = row.sharingOrganizationId === organizationId;
  const other = sharing ? row.receivingOrganizationId : row.sharingOrganizationId;
  return {
    id: row.id,
    role: sharing ? 'sharing' : 'receiving',
    status: row.status as FederationGrantStatus,
    purpose: row.purpose as FederationPurpose,
    maxClassification: row.maxClassification as FederationClassification,
    terms: row.terms as GrantTerms,
    termsHash: row.termsHash,
    expiresAt: row.expiresAt,
    invitationExpiresAt: row.invitationExpiresAt,
    counterpartyName: sharing ? row.receivingDisplayName : row.sharingDisplayName,
    counterpartyFingerprint: other ? organizationFingerprint(other) : null,
    proposedAt: row.createdAt,
    acceptedAt: row.acceptedAt,
    confirmedAt: row.confirmedAt,
    endedAt: row.endedAt,
    endReason: row.endReason as FederationEndReason | null,
    endedByUs: row.endedByOrganizationId === organizationId,
    version: row.version,
  };
}

async function organizationName(tx: Tx, organizationId: string) {
  const [row] = await tx
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!row) throw new AppError('NOT_FOUND');
  return row.name;
}

async function recordGrant(
  tx: Tx,
  context: TenantContext,
  grant: Grant,
  event: string,
  reason?: FederationEndReason,
) {
  await emit(tx, context, {
    aggregateType: AGGREGATE_FEDERATION_GRANT,
    aggregateId: grant.id,
    aggregateVersion: grant.version,
    classification: 'internal',
    eventType: event,
    payload: reason === undefined ? {} : { reason },
  });
  await auditAction(tx, context, event, federationGrantTargetRef(grant.id));
}

export function proposeGrant(
  database: AppDatabase,
  context: TenantContext,
  input: ProposeGrantInput,
) {
  return boundary(() =>
    withTenantTx(database, context, async (tx) => {
      await requireConsent(tx, context);
      if (
        !FEDERATION_PURPOSES.includes(input.purpose) ||
        !FEDERATION_CLASSIFICATIONS.includes(input.maxClassification) ||
        !validVersion(input.expiresInDays) ||
        input.expiresInDays > FEDERATION_MAX_GRANT_DAYS ||
        !validVersion(input.invitationExpiresInDays) ||
        input.invitationExpiresInDays > FEDERATION_MAX_INVITATION_DAYS ||
        input.invitationExpiresInDays > input.expiresInDays ||
        (input.note !== null &&
          (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2000))
      )
        throw new AppError('INVALID_INPUT');
      const sharingOrganizationId = context.organizationId;
      const sharingDisplayName = await organizationName(tx, sharingOrganizationId);
      const now = Date.now();
      const day = 86_400_000;
      const expiresAt = new Date(now + input.expiresInDays * day);
      const terms = buildGrantTerms({
        purpose: input.purpose,
        maxClassification: input.maxClassification,
        sharingOrganizationId,
        sharingDisplayName,
        expiresAt,
        note: input.note?.trim() ?? null,
      });
      const token = newFederationToken();
      const [row] = await tx
        .insert(federationGrants)
        .values({
          sharingOrganizationId,
          sharingDisplayName,
          proposedByMembershipId: context.membershipId,
          purpose: terms.purpose,
          maxClassification: terms.max_classification,
          terms,
          termsHash: grantTermsHash(terms),
          tokenHash: hashFederationToken(token),
          expiresAt,
          invitationExpiresAt: new Date(now + input.invitationExpiresInDays * day),
        })
        .returning();
      if (!row) throw new Error('Federation grant insert returned no row');
      await recordGrant(tx, context, row, FEDERATION_GRANT_PROPOSED);
      return { grant: view(row, sharingOrganizationId), token };
    }),
  );
}

function withInvitation<T>(
  database: AppDatabase,
  context: TenantContext,
  token: string,
  lock: boolean,
  callback: (tx: Tx, row: Grant) => Promise<T>,
) {
  return boundary(() => {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256)
      throw new AppError('FEDERATION_INVITATION_INVALID');
    const hash = hashFederationToken(token);
    return withGrantInvitationTx(database, context, hash, async (tx) => {
      await requireConsent(tx, context);
      const query = tx
        .select()
        .from(federationGrants)
        .where(
          and(
            eq(federationGrants.tokenHash, hash),
            ne(federationGrants.sharingOrganizationId, context.organizationId),
            eq(federationGrants.status, 'proposed'),
            sql`${federationGrants.invitationExpiresAt} > now()`,
          ),
        );
      const [row] = await (lock ? query.for('update') : query);
      if (!row) throw new AppError('FEDERATION_INVITATION_INVALID');
      return callback(tx, row);
    });
  }, true);
}
export function previewGrantInvitation(
  database: AppDatabase,
  context: TenantContext,
  input: { token: string },
): Promise<FederationInvitationPreview> {
  return withInvitation(database, context, input.token, false, async (_tx, row) => ({
    termsHash: row.termsHash,
    terms: row.terms as GrantTerms,
    sharingDisplayName: row.sharingDisplayName,
    sharingFingerprint: organizationFingerprint(row.sharingOrganizationId),
    invitationExpiresAt: row.invitationExpiresAt,
  }));
}
export function acceptGrantInvitation(
  database: AppDatabase,
  context: TenantContext,
  input: { token: string; termsHash: string },
): Promise<FederationGrantView> {
  return withInvitation(database, context, input.token, true, async (tx, before) => {
    if (before.termsHash !== input.termsHash) throw new AppError('FEDERATION_TERMS_CHANGED');
    const receivingOrganizationId = context.organizationId;
    const now = new Date();
    const [row] = await tx
      .update(federationGrants)
      .set({
        receivingOrganizationId,
        receivingDisplayName: await organizationName(tx, receivingOrganizationId),
        acceptedByMembershipId: context.membershipId,
        acceptedTermsHash: before.termsHash,
        acceptedAt: now,
        status: 'accepted',
        updatedAt: now,
        version: before.version + 1,
      })
      .where(eq(federationGrants.id, before.id))
      .returning();
    if (!row) throw new AppError('FEDERATION_INVITATION_INVALID');
    await recordGrant(tx, context, row, FEDERATION_GRANT_ACCEPTED);
    return view(row, receivingOrganizationId);
  });
}

async function lockedGrant(tx: Tx, org: string, id: string, sharingOnly: boolean) {
  const [row] = await tx
    .select()
    .from(federationGrants)
    .where(
      and(
        eq(federationGrants.id, grantId(id)),
        sharingOnly ? eq(federationGrants.sharingOrganizationId, org) : party(org),
      ),
    )
    .for('update');
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

export function confirmGrant(
  database: AppDatabase,
  context: TenantContext,
  input: { grantId: string; termsHash: string; expectedVersion: number },
): Promise<FederationGrantView> {
  return boundary(() =>
    withTenantTx(database, context, async (tx) => {
      await requireConsent(tx, context);
      const before = await lockedGrant(tx, context.organizationId, input.grantId, true);
      if (before.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      if (before.status !== 'accepted') throw new AppError('FEDERATION_GRANT_NOT_OPEN');
      if (before.termsHash !== input.termsHash) throw new AppError('FEDERATION_TERMS_CHANGED');
      const now = new Date();
      const [row] = await tx
        .update(federationGrants)
        .set({
          confirmedByMembershipId: context.membershipId,
          confirmedTermsHash: before.termsHash,
          confirmedAt: now,
          status: 'active',
          updatedAt: now,
          version: before.version + 1,
        })
        .where(eq(federationGrants.id, before.id))
        .returning();
      if (!row) throw new AppError('VERSION_CONFLICT');
      await recordGrant(tx, context, row, FEDERATION_GRANT_ACTIVATED);
      return view(row, context.organizationId);
    }),
  );
}

async function finishGrant(
  tx: Tx,
  context: TenantContext,
  before: Grant,
  reason: FederationEndReason,
) {
  const now = new Date();
  const [row] = await tx
    .update(federationGrants)
    .set({
      endedByOrganizationId: context.organizationId,
      endedByMembershipId:
        context.actorType === 'user' && reason !== 'expired' ? context.membershipId : null,
      endReason: reason,
      endedAt: now,
      status: 'ended',
      updatedAt: now,
      version: before.version + 1,
    })
    .where(eq(federationGrants.id, before.id))
    .returning();
  if (!row) throw new AppError('VERSION_CONFLICT');
  await recordGrant(tx, context, row, FEDERATION_GRANT_ENDED, reason);
  return row;
}
export function endGrant(
  database: AppDatabase,
  context: TenantContext,
  input: { grantId: string; reason: 'cancelled' | 'declined' | 'revoked'; expectedVersion: number },
): Promise<FederationGrantView> {
  return boundary(() =>
    withTenantTx(database, context, async (tx) => {
      await requireCapability(tx, context, 'federation.end');
      if (!['cancelled', 'declined', 'revoked'].includes(input.reason))
        throw new AppError('INVALID_INPUT');
      const before = await lockedGrant(tx, context.organizationId, input.grantId, false);
      if (before.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      return view(await finishGrant(tx, context, before, input.reason), context.organizationId);
    }),
  );
}

async function endOpenGrants(tx: Tx, context: TenantContext, reason: 'expired' | 'disabled') {
  const expired =
    reason === 'expired'
      ? sql`(
    (${federationGrants.status} = 'proposed' AND ${federationGrants.invitationExpiresAt} <= now())
    OR ${federationGrants.expiresAt} <= now()
  )`
      : undefined;
  const rows = await tx
    .select()
    .from(federationGrants)
    .where(
      and(party(context.organizationId), inArray(federationGrants.status, openStates), expired),
    )
    .orderBy(asc(federationGrants.id))
    .for('update');
  for (const grant of rows) await finishGrant(tx, context, grant, reason);
  return rows.length;
}
export async function endAllGrantsInTx(tx: Tx, context: TenantContext): Promise<number> {
  if (context.actorType !== 'service') await requireCapability(tx, context, 'federation.manage');
  return endOpenGrants(tx, context, 'disabled');
}
export const federationWindDown = async (tx: Tx, context: TenantContext): Promise<void> => {
  await endAllGrantsInTx(tx, context);
};

export function listGrants(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly FederationGrantView[]> {
  return withTenantTx(database, context, async (tx) => {
    await requireCapability(tx, context, 'federation.view');
    const rows = await tx
      .select()
      .from(federationGrants)
      .where(party(context.organizationId))
      .orderBy(desc(federationGrants.createdAt), desc(federationGrants.id));
    return rows.map((row) => view(row, context.organizationId));
  });
}

export function getGrant(
  database: AppDatabase,
  context: TenantContext,
  id: string,
): Promise<FederationGrantView> {
  return withTenantTx(database, context, async (tx) => {
    await requireCapability(tx, context, 'federation.view');
    const [row] = await tx
      .select()
      .from(federationGrants)
      .where(and(eq(federationGrants.id, grantId(id)), party(context.organizationId)));
    if (!row) throw new AppError('NOT_FOUND');
    return view(row, context.organizationId);
  });
}

export function expireDueGrants(database: AppDatabase, context: TenantContext): Promise<number> {
  return boundary(() =>
    withTenantTx(database, context, (tx) => {
      if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
      return endOpenGrants(tx, context, 'expired');
    }),
  );
}
