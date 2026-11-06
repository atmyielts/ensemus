// Named client access, UX-16 / KNOW-04. Company role alone never opens a restricted relationship.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  appendAudit,
  clientReaders,
  clients,
  memberships,
  users,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import { AppError, pgCode } from './errors';
import { idSchema } from './ids';

async function ownedClient(tx: Tx, context: TenantContext, id: string, lock = false) {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const [member] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')));
  if (!member || !can(member.role, 'client.manage')) throw new AppError('FORBIDDEN');
  const query = tx.select().from(clients).where(eq(clients.id, id));
  const [client] = await (lock ? query.for('update') : query);
  if (!client || client.ownerMembershipId !== member.id) throw new AppError('NOT_FOUND');
  return client;
}

export async function getClientSharing(
  database: AppDatabase,
  context: TenantContext,
  rawId: string,
) {
  const parsed = idSchema.safeParse(rawId);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return withTenantTx(database, context, async (tx) => {
    const client = await ownedClient(tx, context, parsed.data);
    const readers = await tx
      .select({
        membershipId: clientReaders.membershipId,
        name: users.name,
        status: memberships.status,
      })
      .from(clientReaders)
      .innerJoin(memberships, eq(memberships.id, clientReaders.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(clientReaders.clientId, client.id))
      .orderBy(asc(users.name), asc(clientReaders.membershipId));
    return {
      clientId: client.id,
      name: client.displayName,
      classification: client.classification,
      version: client.accessVersion,
      readers,
    };
  });
}

const sharingInput = z.strictObject({
  clientId: idSchema,
  expectedVersion: z.number().int().positive(),
  readerMembershipIds: z.array(idSchema).max(200),
});
/** Replace the displayed named-reader set under one owner lock and a stale-form version check. */
export async function setClientReaders(
  database: AppDatabase,
  context: TenantContext,
  raw: {
    clientId: string;
    expectedVersion: number;
    readerMembershipIds: readonly string[];
  },
) {
  const parsed = sharingInput.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const input = parsed.data;
  try {
    return await withTenantTx(database, context, async (tx) => {
      const client = await ownedClient(tx, context, input.clientId, true);
      const readers = [...new Set(input.readerMembershipIds)]
        .filter((id) => id !== context.membershipId)
        .sort();
      if (client.accessVersion !== input.expectedVersion) {
        const current = await tx
          .select({ id: clientReaders.membershipId })
          .from(clientReaders)
          .where(eq(clientReaders.clientId, client.id))
          .orderBy(asc(clientReaders.membershipId));
        // A second submit of the same rendered form acknowledges its one committed effect.
        if (
          client.accessVersion === input.expectedVersion + 1 &&
          JSON.stringify(current.map((value) => value.id)) === JSON.stringify(readers)
        )
          return { version: client.accessVersion };
        throw new AppError('VERSION_CONFLICT');
      }
      const active = readers.length
        ? await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(and(inArray(memberships.id, readers), eq(memberships.status, 'active')))
        : [];
      if (active.length !== readers.length) throw new AppError('NOT_FOUND');
      await tx.delete(clientReaders).where(eq(clientReaders.clientId, client.id));
      if (readers.length)
        await tx.insert(clientReaders).values(
          readers.map((membershipId) => ({
            organizationId: context.organizationId,
            clientId: client.id,
            membershipId,
            grantedByMembershipId: context.membershipId,
          })),
        );
      const version = client.accessVersion + 1;
      const changed = await tx
        .update(clients)
        .set({ accessVersion: version })
        .where(and(eq(clients.id, client.id), eq(clients.accessVersion, input.expectedVersion)))
        .returning({ id: clients.id });
      if (changed.length !== 1) throw new AppError('NOT_FOUND');
      await appendAudit(tx, {
        organizationId: context.organizationId,
        actorType: 'user',
        actorId: context.membershipId,
        action: 'client.access_changed',
        targetRef: `client:${client.id}`,
        decision: 'allow',
        safeReason: 'NAMED_READERS_UPDATED',
      });
      return { version };
    });
  } catch (error) {
    if (pgCode(error) === '23503' || pgCode(error) === '42501') throw new AppError('NOT_FOUND');
    throw error;
  }
}
