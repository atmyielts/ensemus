// Owned by the sso slice (ID-04). See docs/06-delivery/m7-slices.md and ADR-031 D9.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendAudit,
  invitations,
  memberships,
  users,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  securityPolicies,
  sessionAssurances,
  ssoConnections,
  ssoMemberLinks,
  ssoProviders,
  scimTokens,
  withScimTokenTx,
  withSsoProviderTx,
} from '@ensemus/database/product';
import { canProduct } from '@ensemus/domain/product-policy';
import {
  SSO_CONNECTION_CHANGED,
  MEMBER_DEPROVISIONED,
  AGGREGATE_SSO_CONNECTION,
  AGGREGATE_MEMBERSHIP,
} from '@ensemus/domain/product-events';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import { auditAction, closeReviewsForLostAccess } from '../work';
import { assertRecentMfa, type SessionProof } from './privileged';

async function manager(tx: Tx, context: TenantContext) {
  if (context.actorType !== 'user') throw new AppError('NOT_FOUND');
  await serializeMembers(tx, context.organizationId);
  const [person] = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('share');
  if (!person || !canProduct(person.role, 'sso.manage')) throw new AppError('NOT_FOUND');
  return { ...context, role: person.role };
}
function connectionView(row: typeof ssoConnections.$inferSelect): SsoConnectionView {
  return {
    id: row.id,
    providerId: row.providerId,
    displayName: row.displayName,
    domain: row.domain,
    domainState: row.domainState as SsoConnectionView['domainState'],
    state: row.state as SsoConnectionView['state'],
    autoJoin: row.autoJoin,
    version: row.version,
  };
}
function domain(value: string) {
  if (
    typeof value !== 'string' ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    !value.includes('.') ||
    !value.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    throw new AppError('INVALID_INPUT');
  return value;
}
function name(value: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 160 ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new AppError('INVALID_INPUT');
  return value.trim();
}
export type VerifiedSsoIdentity = {
  providerId: string;
  issuer: string;
  email: string;
  externalSubject: string;
};
function identityKey(input: VerifiedSsoIdentity): string | null {
  if (
    typeof input.providerId !== 'string' ||
    input.providerId.length > 200 ||
    typeof input.issuer !== 'string' ||
    !input.issuer ||
    input.issuer.length > 2048 ||
    typeof input.externalSubject !== 'string' ||
    !input.externalSubject ||
    input.externalSubject.length > 2048 ||
    [...(input.issuer + input.externalSubject)].some((character) => character.charCodeAt(0) < 32)
  )
    return null;
  return createHash('sha256')
    .update(JSON.stringify([input.providerId, input.issuer, input.externalSubject]))
    .digest('hex');
}
function emailInDomain(email: string, expected: string) {
  return (
    typeof email === 'string' &&
    email.length <= 320 &&
    /^[^\s@]+@[^\s@]+$/.test(email) &&
    email.slice(email.lastIndexOf('@') + 1).toLowerCase() === expected
  );
}
async function serializeMembers(tx: Tx, organizationId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`member_changes:${organizationId}`},0))`,
  );
}
async function changed(
  tx: Tx,
  context: TenantContext,
  row: typeof ssoConnections.$inferSelect,
  reason: string,
) {
  await emit(tx, context, {
    eventType: SSO_CONNECTION_CHANGED,
    aggregateType: AGGREGATE_SSO_CONNECTION,
    aggregateId: row.id,
    aggregateVersion: row.version,
    classification: 'internal',
    payload: { connection_id: row.id, state: row.state, auto_join: row.autoJoin },
  });
  await auditAction(tx, context, 'sso.connection_changed', `sso_connection:${row.id}`, reason);
}

export type SsoConnectionView = {
  id: string;
  providerId: string;
  displayName: string;
  domain: string;
  domainState: 'unverified' | 'verified';
  state: 'draft' | 'active' | 'disabled';
  autoJoin: boolean;
  version: number;
};

/**
 * Whether this session came in the way the tenant asks (ADR-031 D9). Runs on every request to a tenant, so it
 * is one indexed read when nothing is required, which is nearly always. An owner, and any tenant with no active
 * connection, stay out of this, so a broken or removed provider cannot lock a tenant out of itself.
 */
export async function assertTenantSignIn(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof,
): Promise<void> {
  if (context.actorType !== 'user') return;
  await withTenantTx(database, context, async (tx) => {
    // A cached role or a late auth-role receipt cannot revive a person SCIM removed. Only the
    // current active person gets the owner's recovery exception; every member needs a live link.
    const [person] = await tx
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
    if (!person) throw new AppError('SSO_REQUIRED');
    if (person.role === 'owner') return;
    const [policy] = await tx
      .select({ ssoEnforcement: securityPolicies.ssoEnforcement })
      .from(securityPolicies)
      .where(eq(securityPolicies.organizationId, context.organizationId));
    if (policy?.ssoEnforcement !== 'required') return;
    const active = await tx
      .select({ providerId: ssoConnections.providerId })
      .from(ssoConnections)
      .where(
        and(
          eq(ssoConnections.organizationId, context.organizationId),
          eq(ssoConnections.state, 'active'),
        ),
      );
    if (active.length === 0) return;
    const [assurance] = await tx
      .select({ providerId: sessionAssurances.ssoProviderId })
      .from(sessionAssurances)
      .innerJoin(
        ssoConnections,
        and(
          eq(ssoConnections.organizationId, context.organizationId),
          eq(ssoConnections.providerId, sessionAssurances.ssoProviderId),
          eq(ssoConnections.state, 'active'),
          eq(ssoConnections.domainState, 'verified'),
        ),
      )
      .innerJoin(
        ssoMemberLinks,
        and(
          eq(ssoMemberLinks.organizationId, ssoConnections.organizationId),
          eq(ssoMemberLinks.connectionId, ssoConnections.id),
          eq(ssoMemberLinks.membershipId, context.membershipId),
          eq(ssoMemberLinks.state, 'active'),
        ),
      )
      .innerJoin(
        ssoProviders,
        and(
          eq(ssoProviders.providerId, ssoConnections.providerId),
          eq(ssoProviders.domainVerified, true),
        ),
      )
      .where(
        and(
          eq(sessionAssurances.sessionId, proof.sessionId),
          eq(sessionAssurances.userId, context.userId),
          eq(sessionAssurances.kind, 'sso_saml'),
        ),
      );
    if (!assurance || !active.some((row) => row.providerId === assurance.providerId)) {
      throw new AppError('SSO_REQUIRED');
    }
  });
}

/** Needs `sso.manage`. */
export async function listSsoConnections(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly SsoConnectionView[]> {
  return withTenantTx(database, context, async (tx) => {
    await manager(tx, context);
    return (
      await tx
        .select()
        .from(ssoConnections)
        .orderBy(asc(ssoConnections.createdAt), asc(ssoConnections.id))
        .limit(100)
    ).map(connectionView);
  });
}

/**
 * Needs `sso.manage` and recent MFA. Writes the tenant's row as a draft and gives the provider's ID for the
 * caller to store the metadata under, through `@ensemus/auth`'s `sso.storeProvider`. The domain starts
 * unverified, and only the operator's command can change that.
 */
export async function createSsoConnection(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof | null,
  input: { displayName: string; domain: string },
): Promise<SsoConnectionView> {
  const displayName = name(input.displayName),
    host = domain(input.domain);
  return withTenantTx(database, context, async (tx) => {
    const fresh = await manager(tx, context);
    await assertRecentMfa(tx, fresh, 'sso.manage', proof);
    const [row] = await tx
      .insert(ssoConnections)
      .values({
        organizationId: context.organizationId,
        providerId: `saml-${randomUUID()}`,
        displayName,
        domain: host,
        createdByMembershipId: fresh.membershipId,
      })
      .returning();
    if (!row) throw new AppError('VERSION_CONFLICT');
    await changed(tx, fresh, row, 'SSO_DRAFT_CREATED');
    return connectionView(row);
  });
}

/** Needs `sso.manage` and recent MFA. `active` is refused until the operator has verified the domain. */
export async function updateSsoConnection(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof | null,
  input: {
    connectionId: string;
    expectedVersion: number;
    displayName?: string;
    state?: 'active' | 'disabled';
    autoJoin?: boolean;
  },
  deps?: { providerReady: (providerId: string) => Promise<boolean> },
): Promise<SsoConnectionView> {
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    (input.state !== undefined && !['active', 'disabled'].includes(input.state)) ||
    (input.autoJoin !== undefined && typeof input.autoJoin !== 'boolean')
  )
    throw new AppError('INVALID_INPUT');
  const displayName = input.displayName === undefined ? undefined : name(input.displayName);
  return withTenantTx(database, context, async (tx) => {
    const fresh = await manager(tx, context);
    await assertRecentMfa(tx, fresh, 'sso.manage', proof);
    const [current] = await tx
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.id, input.connectionId))
      .for('update');
    if (!current) throw new AppError('NOT_FOUND');
    if (current.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (
      input.state === 'active' &&
      (current.domainState !== 'verified' || !(await deps?.providerReady(current.providerId)))
    )
      throw new AppError('SSO_DOMAIN_NOT_VERIFIED');
    const [row] = await tx
      .update(ssoConnections)
      .set({
        ...(displayName === undefined ? {} : { displayName }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.autoJoin === undefined ? {} : { autoJoin: input.autoJoin }),
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(ssoConnections.id, current.id), eq(ssoConnections.version, current.version)))
      .returning();
    if (!row) throw new AppError('VERSION_CONFLICT');
    await changed(tx, fresh, row, 'SSO_SETTINGS_CHANGED');
    return connectionView(row);
  });
}

/** Disable first, then the caller parses/stores pasted metadata outside this transaction. Changed
 * authentication configuration clears auth-provider trust and needs the real operator domain review. */
export async function prepareSsoMetadata(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof | null,
  input: { connectionId: string; expectedVersion: number },
): Promise<SsoConnectionView> {
  return updateSsoConnection(database, context, proof, { ...input, state: 'disabled' });
}
export async function listScimTokens(
  database: AppDatabase,
  context: TenantContext,
): Promise<
  readonly {
    id: string;
    connectionId: string;
    state: string;
    createdAt: Date;
    lastUsedAt: Date | null;
  }[]
> {
  return withTenantTx(database, context, async (tx) => {
    await manager(tx, context);
    return tx
      .select({
        id: scimTokens.id,
        connectionId: scimTokens.connectionId,
        state: scimTokens.state,
        createdAt: scimTokens.createdAt,
        lastUsedAt: scimTokens.lastUsedAt,
      })
      .from(scimTokens)
      .orderBy(asc(scimTokens.createdAt), asc(scimTokens.id))
      .limit(500);
  });
}

/** Needs `sso.manage` and recent MFA. The token is returned once, and only its hash is kept. */
export async function issueScimToken(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof | null,
  input: { connectionId: string },
): Promise<{ tokenId: string; token: string }> {
  return withTenantTx(database, context, async (tx) => {
    const fresh = await manager(tx, context);
    await assertRecentMfa(tx, fresh, 'scim_token.issue', proof);
    const [connection] = await tx
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.id, input.connectionId))
      .for('share');
    if (!connection) throw new AppError('NOT_FOUND');
    if (connection.state !== 'active' || connection.domainState !== 'verified')
      throw new AppError('SSO_DOMAIN_NOT_VERIFIED');
    const token = `ens_scim_${randomBytes(32).toString('base64url')}`;
    const [row] = await tx
      .insert(scimTokens)
      .values({
        organizationId: context.organizationId,
        connectionId: connection.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        createdByMembershipId: fresh.membershipId,
      })
      .returning({ id: scimTokens.id });
    if (!row) throw new AppError('VERSION_CONFLICT');
    await auditAction(tx, fresh, 'sso.scim_token_issued', `scim_token:${row.id}`, 'TOKEN_ISSUED');
    return { tokenId: row.id, token };
  });
}

export async function revokeScimToken(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof | null,
  input: { tokenId: string },
): Promise<void> {
  return withTenantTx(database, context, async (tx) => {
    const fresh = await manager(tx, context);
    await assertRecentMfa(tx, fresh, 'sso.manage', proof);
    const [row] = await tx
      .select()
      .from(scimTokens)
      .where(eq(scimTokens.id, input.tokenId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.state === 'revoked') return;
    await tx
      .update(scimTokens)
      .set({ state: 'revoked', revokedAt: new Date() })
      .where(eq(scimTokens.id, row.id));
    await auditAction(tx, fresh, 'sso.scim_token_revoked', `scim_token:${row.id}`, 'TOKEN_REVOKED');
  });
}

/** Called only with the cryptographically verified provider identity, before native account/session
 * finalization. The application never resolves a tenant from the browser's organization parameter. */
export async function authorizeSsoIdentity(
  database: AppDatabase,
  input: VerifiedSsoIdentity,
): Promise<boolean> {
  const key = identityKey(input);
  if (!key) return false;
  return (
    (await withSsoProviderTx(database, input.providerId, async (tx, { connection }) => {
      if (!emailInDomain(input.email, connection.domain)) return false;
      const [link] = await tx
        .select({ state: ssoMemberLinks.state, status: memberships.status })
        .from(ssoMemberLinks)
        .innerJoin(
          memberships,
          and(
            eq(memberships.organizationId, ssoMemberLinks.organizationId),
            eq(memberships.id, ssoMemberLinks.membershipId),
          ),
        )
        .where(
          and(
            eq(ssoMemberLinks.connectionId, connection.id),
            eq(ssoMemberLinks.externalSubject, key),
          ),
        );
      return !link || (link.state === 'active' && link.status === 'active');
    })) ?? false
  );
}

/** Fresh authorization for SAML-backed MFA bootstrap, not a new authentication timestamp. */
export async function isSsoPrimaryCurrent(
  database: AppDatabase,
  input: VerifiedSsoIdentity & { userId: string },
): Promise<boolean> {
  const key = identityKey(input);
  if (!key) return false;
  return (
    (await withSsoProviderTx(database, input.providerId, async (tx, { connection }) => {
      if (!emailInDomain(input.email, connection.domain)) return false;
      const [link] = await tx
        .select({ id: memberships.id })
        .from(ssoMemberLinks)
        .innerJoin(
          memberships,
          and(
            eq(memberships.organizationId, ssoMemberLinks.organizationId),
            eq(memberships.id, ssoMemberLinks.membershipId),
          ),
        )
        .where(
          and(
            eq(ssoMemberLinks.connectionId, connection.id),
            eq(ssoMemberLinks.externalSubject, key),
            eq(ssoMemberLinks.state, 'active'),
            eq(memberships.userId, input.userId),
            eq(memberships.status, 'active'),
          ),
        );
      return !!link;
    })) ?? false
  );
}

export type SsoSignInResult =
  /** They are in this organization. */
  | { outcome: 'member'; organizationId: string }
  /** Verified, and with no place here. Nothing was created. */
  | { outcome: 'no_membership' }
  /** The email is outside the verified domain, or the connection is not active. */
  | { outcome: 'refused' };

/**
 * After Better Auth accepted an assertion. Through `withSsoProviderTx`: links the membership and, only when
 * the connection's `autoJoin` is on, adds a `member`. Never a higher role. A deprovisioned link stays out,
 * and a disabled membership is not revived by signing in again.
 */
export async function completeSsoSignIn(
  database: AppDatabase,
  input: VerifiedSsoIdentity & { userId: string },
): Promise<SsoSignInResult> {
  const key = identityKey(input);
  if (!key) return { outcome: 'refused' };
  return (
    (await withSsoProviderTx(
      database,
      input.providerId,
      async (tx, { connection, context }): Promise<SsoSignInResult> => {
        if (!emailInDomain(input.email, connection.domain)) return { outcome: 'refused' };
        // Same order as human member administration and SCIM. Recheck the connection after acquiring it.
        await serializeMembers(tx, context.organizationId);
        const [current] = await tx
          .select()
          .from(ssoConnections)
          .where(eq(ssoConnections.id, connection.id))
          .for('share');
        if (!current || current.state !== 'active' || current.domainState !== 'verified')
          return { outcome: 'refused' };
        const [subject] = await tx
          .select()
          .from(ssoMemberLinks)
          .where(
            and(
              eq(ssoMemberLinks.connectionId, connection.id),
              eq(ssoMemberLinks.externalSubject, key),
            ),
          );
        let [member] = await tx
          .select()
          .from(memberships)
          .where(eq(memberships.userId, input.userId))
          .for('no key update');
        if (subject && (subject.state !== 'active' || subject.membershipId !== member?.id))
          return { outcome: 'refused' };
        if (member && member.status !== 'active') return { outcome: 'refused' };
        if (!member) {
          if (!current.autoJoin) return { outcome: 'no_membership' };
          [member] = await tx
            .insert(memberships)
            .values({
              organizationId: context.organizationId,
              userId: input.userId,
              role: 'member',
              status: 'active',
            })
            .returning();
        }
        if (!member) return { outcome: 'refused' };
        const [existing] = await tx
          .select()
          .from(ssoMemberLinks)
          .where(eq(ssoMemberLinks.membershipId, member.id))
          .for('update');
        if (
          existing &&
          (existing.connectionId !== connection.id ||
            existing.externalSubject !== key ||
            existing.state !== 'active')
        )
          return { outcome: 'refused' };
        if (existing)
          await tx
            .update(ssoMemberLinks)
            .set({ lastLoginAt: new Date(), updatedAt: new Date() })
            .where(eq(ssoMemberLinks.membershipId, member.id));
        else
          await tx.insert(ssoMemberLinks).values({
            organizationId: context.organizationId,
            membershipId: member.id,
            connectionId: connection.id,
            externalSubject: key,
            lastLoginAt: new Date(),
          });
        await auditAction(
          tx,
          context,
          'sso.member_signed_in',
          `membership:${member.id}`,
          'SAML_ACCEPTED',
        );
        return { outcome: 'member', organizationId: context.organizationId };
      },
    )) ?? { outcome: 'refused' }
  );
}

/** A SCIM user, in the RFC 7643 fields a provider needs for deprovisioning. Nothing else. */
export type ScimUser = {
  id: string;
  userName: string;
  externalId: string;
  active: boolean;
};

async function currentScimScope(tx: Tx, tokenId: string, connectionId: string): Promise<boolean> {
  // Serialize this token's last-used write and revocation without upgrading shared token locks.
  const [token] = await tx
    .select({ id: scimTokens.id })
    .from(scimTokens)
    .where(and(eq(scimTokens.id, tokenId), eq(scimTokens.state, 'active')))
    .for('update');
  const [connection] = await tx
    .select({ id: ssoConnections.id })
    .from(ssoConnections)
    .where(
      and(
        eq(ssoConnections.id, connectionId),
        eq(ssoConnections.state, 'active'),
        eq(ssoConnections.domainState, 'verified'),
      ),
    )
    .for('share');
  return !!token && !!connection;
}

/** Through `withScimTokenTx`. Only people linked to this connection. Null is a 401 at the route. */
export async function scimListUsers(
  database: AppDatabase,
  tokenHash: string,
  input: { filterUserName?: string; startIndex: number; count: number },
): Promise<{ total: number; users: readonly ScimUser[] } | null> {
  if (
    !Number.isSafeInteger(input.startIndex) ||
    input.startIndex < 1 ||
    !Number.isSafeInteger(input.count) ||
    input.count < 0 ||
    input.count > 100 ||
    (input.filterUserName !== undefined &&
      (input.filterUserName.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(input.filterUserName)))
  )
    throw new AppError('INVALID_INPUT');
  return withScimTokenTx(database, tokenHash, async (tx, { token, connection }) => {
    if (!(await currentScimScope(tx, token.id, connection.id))) return null;
    const predicate = and(
      eq(ssoMemberLinks.connectionId, connection.id),
      input.filterUserName === undefined
        ? undefined
        : sql`lower(${users.email})=${input.filterUserName.toLowerCase()}`,
    );
    const [count] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(ssoMemberLinks)
      .innerJoin(memberships, eq(memberships.id, ssoMemberLinks.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(predicate);
    const rows =
      input.count === 0
        ? []
        : await tx
            .select({
              id: memberships.id,
              userName: users.email,
              externalId: ssoMemberLinks.externalSubject,
              status: memberships.status,
              state: ssoMemberLinks.state,
            })
            .from(ssoMemberLinks)
            .innerJoin(memberships, eq(memberships.id, ssoMemberLinks.membershipId))
            .innerJoin(users, eq(users.id, memberships.userId))
            .where(predicate)
            .orderBy(asc(memberships.id))
            .offset(input.startIndex - 1)
            .limit(input.count);
    await tx.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, token.id));
    return {
      total: count?.total ?? 0,
      users: rows.map((row) => ({
        id: row.id,
        userName: row.userName,
        externalId: row.externalId,
        active: row.status === 'active' && row.state === 'active',
      })),
    };
  });
}

export async function scimGetUser(
  database: AppDatabase,
  tokenHash: string,
  membershipId: string,
): Promise<ScimUser | 'not_found' | null> {
  return withScimTokenTx(database, tokenHash, async (tx, { token, connection }) => {
    if (!(await currentScimScope(tx, token.id, connection.id))) return null;
    const [row] = await tx
      .select({
        id: memberships.id,
        userName: users.email,
        externalId: ssoMemberLinks.externalSubject,
        status: memberships.status,
        state: ssoMemberLinks.state,
      })
      .from(ssoMemberLinks)
      .innerJoin(memberships, eq(memberships.id, ssoMemberLinks.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(ssoMemberLinks.connectionId, connection.id),
          eq(ssoMemberLinks.membershipId, membershipId),
        ),
      );
    await tx.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, token.id));
    return row
      ? {
          id: row.id,
          userName: row.userName,
          externalId: row.externalId,
          active: row.status === 'active' && row.state === 'active',
        }
      : 'not_found';
  });
}

async function changeScimUser(
  database: AppDatabase,
  tokenHash: string,
  membershipId: string,
  active: boolean,
): Promise<'done' | 'not_found' | 'last_owner' | 'refused' | 'unauthorized'> {
  return (
    (await withScimTokenTx(database, tokenHash, async (tx, { token, connection, context }) => {
      await serializeMembers(tx, context.organizationId);
      // Admission and effect share locks with revocation. An earlier helper snapshot is not authority.
      if (!(await currentScimScope(tx, token.id, connection.id))) return 'unauthorized' as const;
      const [member] = await tx
        .select()
        .from(memberships)
        .where(eq(memberships.id, membershipId))
        .for('no key update');
      const [link] = await tx
        .select()
        .from(ssoMemberLinks)
        .where(
          and(
            eq(ssoMemberLinks.membershipId, membershipId),
            eq(ssoMemberLinks.connectionId, connection.id),
          ),
        )
        .for('update');
      if (!member || !link) return 'not_found' as const;
      if (active) {
        if (link.state === 'active')
          return member.status === 'active' ? ('done' as const) : ('refused' as const);
        if (member.status !== 'disabled' || link.deprovisionedAt === null)
          return 'refused' as const;
        await tx.update(memberships).set({ status: 'active' }).where(eq(memberships.id, member.id));
        await tx
          .update(ssoMemberLinks)
          .set({ state: 'active', deprovisionedAt: null, updatedAt: new Date() })
          .where(eq(ssoMemberLinks.membershipId, member.id));
        await auditAction(
          tx,
          context,
          'sso.member_reactivated',
          `membership:${member.id}`,
          'SCIM_REACTIVATED',
        );
      } else {
        if (link.state === 'deprovisioned') return 'done' as const;
        // Do not claim that SCIM disabled an already administrator-disabled membership. That would
        // incorrectly let a subsequent SCIM active=true revive someone the administrator removed.
        if (member.status !== 'active') return 'done' as const;
        if (member.role === 'owner') {
          const [other] = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(
              and(
                eq(memberships.role, 'owner'),
                eq(memberships.status, 'active'),
                ne(memberships.id, member.id),
              ),
            )
            .limit(1);
          if (!other) {
            await appendAudit(tx, {
              organizationId: context.organizationId,
              actorType: 'service',
              action: 'sso.deprovision_refused',
              targetRef: `membership:${member.id}`,
              decision: 'deny',
              safeReason: 'LAST_OWNER',
            });
            return 'last_owner' as const;
          }
        }
        await tx
          .update(memberships)
          .set({ status: 'disabled' })
          .where(eq(memberships.id, member.id));
        await tx
          .update(ssoMemberLinks)
          .set({ state: 'deprovisioned', deprovisionedAt: new Date(), updatedAt: new Date() })
          .where(eq(ssoMemberLinks.membershipId, member.id));
        const revoked = await tx
          .update(invitations)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(invitations.invitedByMembershipId, member.id),
              isNull(invitations.acceptedAt),
              isNull(invitations.revokedAt),
            ),
          )
          .returning({ id: invitations.id });
        for (const invitation of revoked) {
          await auditAction(
            tx,
            context,
            'invitation.revoked',
            `invitation:${invitation.id}`,
            'INVITER_DISABLED',
          );
          await emit(tx, context, {
            eventType: 'invitation.revoked',
            aggregateType: 'invitation',
            aggregateId: invitation.id,
            aggregateVersion: 1,
            classification: 'internal',
            payload: { invitation_id: invitation.id },
          });
        }
        await closeReviewsForLostAccess(tx, context, { approverMembershipId: member.id });
        await auditAction(
          tx,
          context,
          'sso.member_deprovisioned',
          `membership:${member.id}`,
          'SCIM_DEPROVISIONED',
        );
        await emit(tx, context, {
          eventType: MEMBER_DEPROVISIONED,
          aggregateType: AGGREGATE_MEMBERSHIP,
          aggregateId: member.id,
          aggregateVersion: 1,
          classification: 'internal',
          payload: { membership_id: member.id, connection_id: connection.id },
        });
      }
      await tx
        .update(scimTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(scimTokens.id, token.id));
      return 'done' as const;
    })) ?? 'unauthorized'
  );
}

/** Disables the membership, marks the link, audits, and emits MEMBER_DEPROVISIONED. Idempotent. */
export async function scimDeprovisionUser(
  database: AppDatabase,
  tokenHash: string,
  input: { membershipId: string },
): Promise<'done' | 'not_found' | 'last_owner' | 'unauthorized'> {
  const result = await changeScimUser(database, tokenHash, input.membershipId, false);
  return result === 'refused' ? 'not_found' : result;
}

/** Reactivates only a link SCIM itself deprovisioned. A membership an admin disabled stays disabled. */
export async function scimReactivateUser(
  database: AppDatabase,
  tokenHash: string,
  input: { membershipId: string },
): Promise<'done' | 'not_found' | 'refused' | 'unauthorized'> {
  const result = await changeScimUser(database, tokenHash, input.membershipId, true);
  return result === 'last_owner' ? 'refused' : result;
}
