// Teams, members, invitations, clients and projects (UX-15, UX-16, ID-02).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendAudit,
  clients,
  invitations,
  memberships,
  notifications,
  organizations,
  projects,
  teamMemberships,
  teams,
  users,
  withInvitationTx,
  withNewTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { can, type Capability } from '@ensemus/domain/policy';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, foreignReference, pgCode } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import { idFromRequest } from './request-id';
import { assertActiveMember, closeReviewsForLostAccess } from './work';
import { assertInteractivePrivilege, withPrivilegeTx as withTenantTx } from './product/privileged';

const FOREIGN_KEY_VIOLATION = '23503';
const name = z.string().trim().min(1).max(200);
const classification = z.enum(['public', 'internal', 'confidential', 'restricted']);
const identifier = idSchema;
/** From one rendered form, so that sending it twice makes one row (see idFromRequest). */
const requestKey = idSchema.optional();

function requireCapability(context: TenantContext, capability: Capability) {
  if (!can(context.role, capability)) throw new AppError('FORBIDDEN');
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

// --- Teams
export async function createTeam(
  database: AppDatabase,
  context: TenantContext,
  raw: { name: string; parentId?: string | null; requestKey?: string },
) {
  requireCapability(context, 'team.manage');
  const input = parse(
    z.strictObject({ name, parentId: idSchema.nullable().optional(), requestKey }),
    raw,
  );
  const parentId = input.parentId ?? null;
  const id = input.requestKey
    ? idFromRequest('team', context.membershipId, input.requestKey, [input.name, parentId])
    : randomUUID();
  return withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'member.manage');
    try {
      const [row] = await tx
        .insert(teams)
        .values({ organizationId: context.organizationId, id, name: input.name, parentId })
        .onConflictDoNothing()
        .returning();
      if (row) return row;
      const [existing] = await tx.select().from(teams).where(eq(teams.id, id));
      return existing;
    } catch (error) {
      throw teamWriteError(error);
    }
  });
}

/** What a refused change to a team's place means. A parent elsewhere fails its tenant-safe key. */
function teamWriteError(error: unknown) {
  const code = pgCode(error);
  if (code === 'EN002' || code === '23514') return new AppError('TEAM_CYCLE');
  if (code === FOREIGN_KEY_VIOLATION) return foreignReference();
  return error;
}

/** Moves a team under another one, or to the top with no parent. A loop is refused by the database. */
export async function setTeamParent(
  database: AppDatabase,
  context: TenantContext,
  raw: { teamId: string; parentId: string | null },
) {
  requireCapability(context, 'team.manage');
  const input = parse(z.strictObject({ teamId: identifier, parentId: identifier.nullable() }), raw);
  return withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'member.manage');
    let moved: Array<{ id: string }>;
    try {
      moved = await tx
        .update(teams)
        .set({ parentId: input.parentId })
        .where(eq(teams.id, input.teamId))
        .returning({ id: teams.id });
    } catch (error) {
      throw teamWriteError(error);
    }
    if (moved.length === 0) throw new AppError('NOT_FOUND');
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'team.moved',
      targetRef: `team:${input.teamId}`,
      decision: 'allow',
    });
  });
}

export async function addTeamMember(
  database: AppDatabase,
  context: TenantContext,
  raw: { teamId: string; membershipId: string },
) {
  requireCapability(context, 'team.manage');
  const input = parse(z.strictObject({ teamId: identifier, membershipId: identifier }), raw);
  return withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'member.manage');
    await assertActiveMember(tx, input.membershipId);
    const [team] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, input.teamId));
    if (!team) throw new AppError('NOT_FOUND');
    await tx
      .insert(teamMemberships)
      .values({ organizationId: context.organizationId, ...input })
      .onConflictDoNothing();
  });
}

export async function removeTeamMember(
  database: AppDatabase,
  context: TenantContext,
  raw: { teamId: string; membershipId: string },
) {
  requireCapability(context, 'team.manage');
  const input = parse(z.strictObject({ teamId: identifier, membershipId: identifier }), raw);
  return withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'member.manage');
    return tx
      .delete(teamMemberships)
      .where(
        and(
          eq(teamMemberships.teamId, input.teamId),
          eq(teamMemberships.membershipId, input.membershipId),
        ),
      );
  });
}

/**
 * Team structure, filtered by who is asking. Everyone sees which teams there are and how they nest, and
 * how many people each has. Who is on a team is shown to people who manage teams and to those on it.
 * Email addresses are never part of this: the directory decides who sees those.
 */
export async function listTeams(database: AppDatabase, context: TenantContext) {
  const seesEveryone = can(context.role, 'team.manage');
  return withTenantTx(database, context, async (tx) => {
    const rows = await tx.select().from(teams).orderBy(asc(teams.name));
    const members = await tx
      .select({
        teamId: teamMemberships.teamId,
        membershipId: teamMemberships.membershipId,
        name: users.name,
      })
      .from(teamMemberships)
      .innerJoin(memberships, eq(memberships.id, teamMemberships.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .orderBy(asc(users.name));
    return rows.map((team) => {
      const onTeam = members.filter((member) => member.teamId === team.id);
      const shown =
        seesEveryone || onTeam.some((member) => member.membershipId === context.membershipId);
      return {
        ...team,
        members: shown ? onTeam : [],
        memberCount: onTeam.length,
        membersHidden: !shown && onTeam.length > 0,
      };
    });
  });
}

// --- Members

/**
 * The directory, filtered by who is asking. Everyone sees names, roles and whether someone is active,
 * because they need them to pick a reviewer or see who is responsible. Email addresses are contact
 * details, so only people who manage members see them, and anyone sees their own.
 */
export async function listDirectory(database: AppDatabase, context: TenantContext) {
  const seesEmail = can(context.role, 'member.view_email');
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        membershipId: memberships.id,
        role: memberships.role,
        status: memberships.status,
        name: users.name,
        email: users.email,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .orderBy(asc(users.name)),
  );
  return rows.map(({ email, ...person }) => ({
    ...person,
    email: seesEmail || person.membershipId === context.membershipId ? email : null,
  }));
}

/**
 * Changes that can remove an owner run one at a time per organization. Locking only the target row
 * would let two owners each remove the other, each seeing the other still in place. This is taken
 * first, so nothing below can deadlock against it. The membership row itself is then locked no more
 * strongly than a change that keeps its key needs: a transition inserting a row that refers to this
 * member only asks for a key share, and blocking that while waiting on its work row would deadlock.
 */
async function serializeMemberChanges(tx: Tx, organizationId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`member_changes:${organizationId}`}, 0))`,
  );
}

/**
 * A person losing the right to invite also loses the invitations they already made. Otherwise a link
 * kept back would bring them straight back in, in whatever role it names.
 */
async function revokeInvitationsBy(
  tx: Tx,
  context: TenantContext,
  membershipId: string,
  reason: 'INVITER_DISABLED' | 'INVITER_DEMOTED',
) {
  const revoked = await tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.invitedByMembershipId, membershipId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning({ id: invitations.id });
  for (const { id } of revoked) {
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'invitation.revoked',
      targetRef: `invitation:${id}`,
      decision: 'allow',
      safeReason: reason,
    });
    await emitInvitationRevoked(tx, context, id);
  }
}

function emitInvitationRevoked(tx: Tx, context: TenantContext, invitationId: string) {
  return emit(tx, context, {
    eventType: 'invitation.revoked',
    aggregateType: 'invitation',
    aggregateId: invitationId,
    aggregateVersion: 1,
    classification: 'internal',
    payload: { invitation_id: invitationId },
  });
}

export async function setMemberRole(
  database: AppDatabase,
  context: TenantContext,
  input: { membershipId: string; role: 'owner' | 'admin' | 'member' },
) {
  requireCapability(context, 'member.manage');
  // Only an owner can create another owner, or change one.
  return withTenantTx(database, context, async (tx) => {
    await serializeMemberChanges(tx, context.organizationId);
    await assertInteractivePrivilege(tx, context, 'member.manage');
    const [target] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.id, input.membershipId))
      .for('no key update');
    if (!target) throw new AppError('NOT_FOUND');
    if ((input.role === 'owner' || target.role === 'owner') && context.role !== 'owner') {
      throw new AppError('FORBIDDEN');
    }
    if (target.role === 'owner' && input.role !== 'owner') {
      await assertAnotherOwner(tx, target.id);
    }
    await tx
      .update(memberships)
      .set({ role: input.role })
      .where(eq(memberships.id, input.membershipId));
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'member.role_changed',
      targetRef: `membership:${input.membershipId}`,
      decision: 'allow',
      safeReason: input.role.toUpperCase(),
    });
    if (!can(input.role, 'member.invite')) {
      await revokeInvitationsBy(tx, context, input.membershipId, 'INVITER_DEMOTED');
    }
    // A lower role can lose sight of confidential work, including work they were asked to review.
    await closeReviewsForLostAccess(tx, context, { approverMembershipId: input.membershipId });
  });
}

async function assertAnotherOwner(tx: Tx, id: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
        sql`${memberships.id} <> ${id}`,
      ),
    );
  if ((row?.n ?? 0) === 0) throw new AppError('LAST_OWNER');
}

/** Disabling takes effect at once: the next request fails its membership check. */
export async function disableMember(
  database: AppDatabase,
  context: TenantContext,
  input: { membershipId: string },
) {
  requireCapability(context, 'member.manage');
  return withTenantTx(database, context, async (tx) => {
    await serializeMemberChanges(tx, context.organizationId);
    await assertInteractivePrivilege(tx, context, 'member.manage');
    const [target] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.id, input.membershipId))
      .for('no key update');
    if (!target) throw new AppError('NOT_FOUND');
    if (target.role === 'owner') {
      if (context.role !== 'owner') throw new AppError('FORBIDDEN');
      await assertAnotherOwner(tx, target.id);
    }
    await tx
      .update(memberships)
      .set({ status: 'disabled' })
      .where(eq(memberships.id, input.membershipId));
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'member.disabled',
      targetRef: `membership:${input.membershipId}`,
      decision: 'allow',
    });
    await revokeInvitationsBy(tx, context, input.membershipId, 'INVITER_DISABLED');
    await closeReviewsForLostAccess(tx, context, { approverMembershipId: input.membershipId });
  });
}

// --- Invitations
const INVITATION_DAYS = 7;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Returns the token once. Only its hash is stored, so it can never be read back. */
export async function createInvitation(
  database: AppDatabase,
  context: TenantContext,
  raw: { email: string; role?: 'admin' | 'member' },
) {
  requireCapability(context, 'member.invite');
  const input = parse(
    z.strictObject({
      email: z.email().trim().toLowerCase(),
      role: z.enum(['admin', 'member']).default('member'),
    }),
    raw,
  );
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  return withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'member.manage');
    await tx.insert(invitations).values({
      organizationId: context.organizationId,
      id,
      email: input.email,
      role: input.role,
      tokenHash: hashToken(token),
      invitedByMembershipId: context.membershipId,
      expiresAt: new Date(Date.now() + INVITATION_DAYS * 24 * 60 * 60 * 1000),
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'member.invited',
      targetRef: `invitation:${id}`,
      decision: 'allow',
    });
    return { id, token };
  });
}

export async function listInvitations(database: AppDatabase, context: TenantContext) {
  requireCapability(context, 'member.invite');
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
        claimedAt: invitations.claimedAt,
      })
      .from(invitations)
      .orderBy(asc(invitations.createdAt)),
  );
}

export async function revokeInvitation(
  database: AppDatabase,
  context: TenantContext,
  input: { invitationId: string },
) {
  requireCapability(context, 'member.invite');
  return withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'member.manage');
    const revoked = await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      // Someone who already joined stays joined, so an accepted invitation has nothing left to revoke.
      .where(
        and(
          eq(invitations.id, input.invitationId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id });
    if (revoked.length === 0) return;
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'invitation.revoked',
      targetRef: `invitation:${input.invitationId}`,
      decision: 'allow',
    });
    await emitInvitationRevoked(tx, context, input.invitationId);
  });
}

export type InvitationOutcome =
  { status: 'joined'; organizationId: string } | { status: 'awaiting_confirmation' };

/**
 * Accepts an invitation. It grants only the organization and role it names, works once, and only
 * for the person it was sent to, while the person who sent it can still invite. Every failure gives
 * the same answer, so a guessed token learns nothing.
 *
 * Holding the link and an account with the invited address proves little until that address has been
 * verified. Anyone can register any unused address where signups are open, so an unverified account
 * joins nothing here: it asks, and someone who can invite has to confirm it on the people page.
 *
 * A tenant not in good standing takes nobody new (ADR-032 D5): its invitation's recipient is answered
 * TENANT_READ_ONLY or TENANT_SUSPENDED, nothing is written, and the invitation keeps working for later.
 */
export async function acceptInvitation(
  database: AppDatabase,
  input: {
    token: string;
    userId: string;
    email: string;
    emailVerified: boolean;
    /**
     * Refuses while this tenant is being restored (ADR-026). It is asked only once the invitation is
     * known to be this person's, so that nobody else can learn a restore is under way.
     */
    assertServing?: (organizationId: string, userId: string) => Promise<void>;
  },
): Promise<InvitationOutcome> {
  const tokenHash = hashToken(input.token);
  const [invitation] = await withInvitationTx(database, tokenHash, (tx) =>
    tx.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)),
  );
  const usable =
    invitation &&
    !invitation.acceptedAt &&
    !invitation.revokedAt &&
    invitation.expiresAt > new Date() &&
    invitation.email === input.email.trim().toLowerCase();
  if (!usable) throw new AppError('INVITATION_INVALID');
  await input.assertServing?.(invitation.organizationId, input.userId);

  return withNewTenantTx(database, invitation.organizationId, input.userId, async (tx) => {
    // Re-read under a lock, so two simultaneous accepts cannot both succeed.
    const [current] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.id, invitation.id))
      .for('update');
    if (!current || current.acceptedAt || current.revokedAt || current.expiresAt <= new Date()) {
      throw new AppError('INVITATION_INVALID');
    }
    // Joining writes a membership, and in restricted standing ordinary writes are refused (ADR-032 D5).
    // This transaction binds no tenant context, so withTenantTx's read-only rule never reaches it: read
    // the standing here, under a share lock a standing change waits for, and make the transaction
    // read-only the same way, so PostgreSQL refuses any write below even if the answer further down
    // were moved. A tenant that has gone is the same as one that never existed.
    const [standing] = await tx
      .select({ lifecycle: organizations.lifecycle })
      .from(organizations)
      .where(eq(organizations.id, current.organizationId))
      .for('share');
    if (!standing || standing.lifecycle === 'deleted') throw new AppError('INVITATION_INVALID');
    const restricted = standing.lifecycle !== 'active';
    if (restricted) await tx.execute(sql`set transaction read only`);
    // Preserve the exact existing bearer authority in the effect Tx, not an earlier read. The
    // database guard recognizes only this immutable, live invitation and its actual recipient.
    await tx.execute(sql`select set_config('app.invitation_token_hash',${tokenHash},true)`);
    // An invitation carries the authority of whoever made it, for as long as they have it.
    const [inviter] = await tx
      .select({ role: memberships.role, status: memberships.status })
      .from(memberships)
      .where(eq(memberships.id, current.invitedByMembershipId));
    if (inviter?.status !== 'active' || !can(inviter.role, 'member.invite')) {
      throw new AppError('INVITATION_INVALID');
    }
    const [existing] = await tx
      .select({ id: memberships.id, status: memberships.status })
      .from(memberships)
      .where(eq(memberships.userId, input.userId));
    // Disabled stays disabled. A new invitation is not a way around that.
    if (existing && existing.status !== 'active') throw new AppError('INVITATION_INVALID');
    // Only now, when the invitation would otherwise work, is its recipient told the standing. Nothing
    // has been written: the invitation stays unused, unclaimed, and usable once standing returns.
    if (restricted) {
      throw new AppError(
        standing.lifecycle === 'read_only' ? 'TENANT_READ_ONLY' : 'TENANT_SUSPENDED',
      );
    }

    if (!existing && !input.emailVerified) {
      await tx
        .update(invitations)
        .set({ claimedByUserId: input.userId, claimedAt: new Date() })
        .where(eq(invitations.id, current.id));
      await appendAudit(tx, {
        organizationId: current.organizationId,
        actorType: 'user',
        action: 'member.join_requested',
        targetRef: `invitation:${current.id}`,
        decision: 'allow',
        safeReason: 'EMAIL_NOT_VERIFIED',
      });
      await tx.insert(notifications).values({
        organizationId: current.organizationId,
        recipientMembershipId: current.invitedByMembershipId,
        kind: 'member.join_requested',
        targetRef: `invitation:${current.id}`,
      });
      return { status: 'awaiting_confirmation' };
    }

    await join(tx, {
      invitationId: current.id,
      organizationId: current.organizationId,
      role: current.role,
      userId: input.userId,
      existingMembershipId: existing?.id,
    });
    return { status: 'joined', organizationId: current.organizationId };
  });
}

/** Marks the invitation used, and records truthfully whether anyone actually joined. */
async function join(
  tx: Tx,
  input: {
    invitationId: string;
    organizationId: string;
    role: string;
    userId: string;
    existingMembershipId: string | undefined;
  },
) {
  await tx
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(eq(invitations.id, input.invitationId));
  const [created] = input.existingMembershipId
    ? []
    : await tx
        .insert(memberships)
        .values({ organizationId: input.organizationId, userId: input.userId, role: input.role })
        .onConflictDoNothing()
        .returning({ id: memberships.id });
  const actorId = created?.id ?? input.existingMembershipId;
  await appendAudit(tx, {
    organizationId: input.organizationId,
    actorType: 'user',
    ...(actorId ? { actorId } : {}),
    action: created ? 'member.joined' : 'member.join_skipped',
    targetRef: `invitation:${input.invitationId}`,
    decision: 'allow',
    ...(created ? {} : { safeReason: 'ALREADY_MEMBER' }),
  });
}

/**
 * Lets the asking account in, on the word of someone who can invite. This is the check for accounts
 * whose address nobody has proven, which on a deployment with no mail is every password account.
 */
export async function confirmInvitation(
  database: AppDatabase,
  context: TenantContext,
  input: { invitationId: string },
) {
  requireCapability(context, 'member.invite');
  const id = parse(identifier, input.invitationId);
  return withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'member.manage');
    const [current] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.id, id))
      .for('update');
    if (
      !current?.claimedByUserId ||
      current.acceptedAt ||
      current.revokedAt ||
      current.expiresAt <= new Date()
    ) {
      throw new AppError('INVITATION_INVALID');
    }
    const [existing] = await tx
      .select({ id: memberships.id, status: memberships.status })
      .from(memberships)
      .where(eq(memberships.userId, current.claimedByUserId));
    if (existing && existing.status !== 'active') throw new AppError('INVITATION_INVALID');
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'member.join_confirmed',
      targetRef: `invitation:${current.id}`,
      decision: 'allow',
    });
    await join(tx, {
      invitationId: current.id,
      organizationId: current.organizationId,
      role: current.role,
      userId: current.claimedByUserId,
      existingMembershipId: existing?.id,
    });
  });
}

// --- Clients and projects
export async function createClient(
  database: AppDatabase,
  context: TenantContext,
  raw: { displayName: string; classification?: string; requestKey?: string },
) {
  requireCapability(context, 'client.manage');
  const { requestKey: key, ...input } = parse(
    z.strictObject({
      displayName: name,
      classification: classification.default('internal'),
      requestKey,
    }),
    raw,
  );
  const id = key
    ? idFromRequest('client', context.membershipId, key, [input.displayName, input.classification])
    : randomUUID();
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .insert(clients)
      .values({
        organizationId: context.organizationId,
        id,
        ownerMembershipId: context.membershipId,
        ...input,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const [existing] = await tx.select().from(clients).where(eq(clients.id, id));
    return existing;
  });
}

export async function listClients(database: AppDatabase, context: TenantContext) {
  return withTenantTx(database, context, (tx) =>
    tx.select().from(clients).orderBy(asc(clients.displayName)),
  );
}

export async function createProject(
  database: AppDatabase,
  context: TenantContext,
  raw: { name: string; clientId?: string; requestKey?: string },
) {
  requireCapability(context, 'project.manage');
  const input = parse(z.strictObject({ name, clientId: idSchema.optional(), requestKey }), raw);
  const clientId = input.clientId ?? null;
  const id = input.requestKey
    ? idFromRequest('project', context.membershipId, input.requestKey, [input.name, clientId])
    : randomUUID();
  return withTenantTx(database, context, async (tx) => {
    try {
      const [row] = await tx
        .insert(projects)
        .values({ organizationId: context.organizationId, id, name: input.name, clientId })
        .onConflictDoNothing()
        .returning();
      if (row) return row;
      const [existing] = await tx.select().from(projects).where(eq(projects.id, id));
      return existing;
    } catch (error) {
      // A client elsewhere fails its tenant-safe key.
      if (pgCode(error) === '42501') throw new AppError('NOT_FOUND', 'FOREIGN_REFERENCE');
      throw pgCode(error) === FOREIGN_KEY_VIOLATION ? foreignReference() : error;
    }
  });
}

export async function listProjects(database: AppDatabase, context: TenantContext) {
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: projects.id,
        name: projects.name,
        clientId: projects.clientId,
        clientName: clients.displayName,
      })
      .from(projects)
      .leftJoin(clients, eq(clients.id, projects.clientId))
      .orderBy(asc(projects.name)),
  );
}
