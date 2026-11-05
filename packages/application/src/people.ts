// Teams, members, invitations, clients and projects (UX-15, UX-16, ID-02).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendAudit,
  clients,
  invitations,
  memberships,
  projects,
  teamMemberships,
  teams,
  users,
  withInvitationTx,
  withNewTenantTx,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { can, type Capability } from '@ensemus/domain/policy';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, pgCode } from './errors';

const name = z.string().trim().min(1).max(200);
const classification = z.enum(['public', 'internal', 'confidential', 'restricted']);

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
  input: { teamId: string; membershipId: string },
) {
  requireCapability(context, 'team.manage');
  return withTenantTx(database, context, (tx) =>
    tx
      .insert(teamMemberships)
      .values({ organizationId: context.organizationId, ...input })
      .onConflictDoNothing(),
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
export async function setMemberRole(
  database: AppDatabase,
  context: TenantContext,
  input: { membershipId: string; role: 'owner' | 'admin' | 'member' },
) {
  requireCapability(context, 'member.manage');
  // Only an owner can create another owner, or change one.
  return withTenantTx(database, context, async (tx) => {
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
  });
}

async function assertAnotherOwner(
  tx: Parameters<Parameters<AppDatabase['run']>[0]>[0],
  id: string,
) {
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
  return withTenantTx(database, context, (tx) =>
    tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(eq(invitations.id, input.invitationId)),
  );
}

/**
 * Accepts an invitation. It grants only the organization and role it names, works once, and only
 * for the person it was sent to. Every failure gives the same answer, so a guessed token learns
 * nothing.
 */
export async function acceptInvitation(
  database: AppDatabase,
  input: { token: string; userId: string; email: string },
) {
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

  await withNewTenantTx(database, invitation.organizationId, input.userId, async (tx) => {
    // Re-read under a lock, so two simultaneous accepts cannot both succeed.
    const [current] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.id, invitation.id))
      .for('update');
    if (!current || current.acceptedAt || current.revokedAt) {
      throw new AppError('INVITATION_INVALID');
    }
    await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, invitation.id));
    await tx
      .insert(memberships)
      .values({
        organizationId: invitation.organizationId,
        userId: input.userId,
        role: invitation.role,
      })
      .onConflictDoNothing();
    await appendAudit(tx, {
      organizationId: invitation.organizationId,
      actorType: 'user',
      action: 'member.joined',
      targetRef: `invitation:${invitation.id}`,
      decision: 'allow',
    });
  });
  return { organizationId: invitation.organizationId };
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
