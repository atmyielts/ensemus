// Teams, members, invitations, clients and projects (UX-15, UX-16, ID-02).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendAudit,
  clients,
  invitations,
  memberships,
  notifications,
  projects,
  teamMemberships,
  teams,
  users,
  withInvitationTx,
  withNewTenantTx,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { can, type Capability } from '@ensemus/domain/policy';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, pgCode } from './errors';
import { closeReviewsForLostAccess } from './work';

const name = z.string().trim().min(1).max(200);
const classification = z.enum(['public', 'internal', 'confidential', 'restricted']);
const identifier = z.uuid();

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
  raw: { name: string; parentId?: string | null },
) {
  requireCapability(context, 'team.manage');
  const input = parse(z.strictObject({ name, parentId: z.uuid().nullable().optional() }), raw);
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .insert(teams)
      .values({
        organizationId: context.organizationId,
        name: input.name,
        parentId: input.parentId ?? null,
      })
      .returning();
    return row;
  });
}

export async function setTeamParent(
  database: AppDatabase,
  context: TenantContext,
  input: { teamId: string; parentId: string | null },
) {
  requireCapability(context, 'team.manage');
  return withTenantTx(database, context, async (tx) => {
    try {
      await tx.update(teams).set({ parentId: input.parentId }).where(eq(teams.id, input.teamId));
    } catch (error) {
      const code = pgCode(error);
      if (code === 'EN002' || code === '23514') throw new AppError('TEAM_CYCLE');
      throw error;
    }
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
    const [member] = await tx
      .select({ status: memberships.status })
      .from(memberships)
      .where(eq(memberships.id, input.membershipId));
    if (member?.status !== 'active') throw new AppError('INVALID_INPUT');
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
  return withTenantTx(database, context, (tx) =>
    tx
      .delete(teamMemberships)
      .where(
        and(
          eq(teamMemberships.teamId, input.teamId),
          eq(teamMemberships.membershipId, input.membershipId),
        ),
      ),
  );
}

export async function listTeams(database: AppDatabase, context: TenantContext) {
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
    return rows.map((team) => ({
      ...team,
      members: members.filter((member) => member.teamId === team.id),
    }));
  });
}

// --- Members

/**
 * Changes that can remove an owner run one at a time per organization. Locking only the target row
 * would let two owners each remove the other, each seeing the other still in place. This is taken
 * first, so nothing below can deadlock against it.
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
  }
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
    const [target] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.id, input.membershipId))
      .for('update');
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
    const [target] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.id, input.membershipId))
      .for('update');
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
    const revoked = await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(eq(invitations.id, input.invitationId))
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
 */
export async function acceptInvitation(
  database: AppDatabase,
  input: { token: string; userId: string; email: string; emailVerified: boolean },
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

  return withNewTenantTx(database, invitation.organizationId, input.userId, async (tx) => {
    // Re-read under a lock, so two simultaneous accepts cannot both succeed.
    const [current] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.id, invitation.id))
      .for('update');
    if (!current || current.acceptedAt || current.revokedAt) {
      throw new AppError('INVITATION_INVALID');
    }
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
  raw: { displayName: string; classification?: string },
) {
  requireCapability(context, 'client.manage');
  const input = parse(
    z.strictObject({ displayName: name, classification: classification.default('internal') }),
    raw,
  );
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .insert(clients)
      .values({ organizationId: context.organizationId, ...input })
      .returning();
    return row;
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
  raw: { name: string; clientId?: string },
) {
  requireCapability(context, 'project.manage');
  const input = parse(z.strictObject({ name, clientId: z.uuid().optional() }), raw);
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .insert(projects)
      .values({
        organizationId: context.organizationId,
        name: input.name,
        clientId: input.clientId ?? null,
      })
      .returning();
    return row;
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
