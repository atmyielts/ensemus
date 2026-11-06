// Owned by the support slice (OPS-22). Published hours match real staffing, and support has no default
// access to content. See docs/06-delivery/m8-slices.md and ADR-032 D8.
import {
  coverageSchedules,
  organizations,
  offboardings,
  ticketMessages,
  tickets,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { openTicketSchema, replyTicketSchema } from '@ensemus/contracts/saas';
import { can } from '@ensemus/domain/policy';
import { AGGREGATE_TICKET, TICKET_OPENED, TICKET_REPLIED } from '@ensemus/saas/events';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { auditAction } from '../work';
import { emit } from '../events';
import type { TicketCategory, TicketStatus } from '@ensemus/saas/support';

const user = (context: TenantContext) => {
  if (context.actorType !== 'user' || !can(context.role, 'support.use'))
    throw new AppError('NOT_FOUND');
};
const idOf = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
};
const visible = (context: TenantContext) =>
  context.role === 'owner' || context.role === 'admin'
    ? eq(tickets.organizationId, context.organizationId)
    : and(
        eq(tickets.organizationId, context.organizationId),
        eq(tickets.openedByMembershipId, context.membershipId),
      );
const summary = (row: typeof tickets.$inferSelect): TicketSummary => ({
  id: row.id,
  subject: row.subject,
  category: row.category as TicketCategory,
  status: row.status as TicketStatus,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: row.version,
});
async function findTicket(tx: Tx, context: TenantContext, id: string, lock = false) {
  const query = tx
    .select()
    .from(tickets)
    .where(and(visible(context), eq(tickets.id, id)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}
async function checkTenant(tx: Tx, context: TenantContext) {
  const [org] = await tx
    .select({ id: organizations.id, lifecycle: organizations.lifecycle })
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
  const [erasing] = await tx
    .select({ id: offboardings.id })
    .from(offboardings)
    .where(
      and(
        eq(offboardings.organizationId, context.organizationId),
        inArray(offboardings.state, ['erasing', 'verified', 'reported']),
      ),
    )
    .limit(1);
  if (erasing) throw new AppError('INVALID_STATE');
}

/** Presentation only; every mutation repeats its authority check under the org lock. */
export async function supportContentWritable(
  database: AppDatabase,
  context: TenantContext,
): Promise<boolean> {
  user(context);
  return withAccountTx(database, context, async (tx) => {
    const [org] = await tx
      .select({ lifecycle: organizations.lifecycle })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId));
    if (!org || org.lifecycle === 'deleted') return false;
    const [closed] = await tx
      .select({ id: offboardings.id })
      .from(offboardings)
      .where(
        and(
          eq(offboardings.organizationId, context.organizationId),
          inArray(offboardings.state, ['erasing', 'verified', 'reported']),
        ),
      )
      .limit(1);
    return !closed;
  });
}
function version(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new AppError('INVALID_INPUT');
}
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const coverageWindowsSchema = z
  .array(
    z
      .strictObject({
        day: z.int().min(0).max(6),
        from: time,
        to: z.union([time, z.literal('24:00')]),
      })
      .refine((window) => window.from !== window.to),
  )
  .min(1)
  .max(128);
export const coverageTimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  });

export type TicketSummary = {
  id: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type TicketDetail = TicketSummary & {
  messages: readonly {
    id: string;
    authorKind: 'customer' | 'support';
    body: string;
    createdAt: Date;
  }[];
};

/** `support.use`. A tenant's owner and admins see every ticket, and a member sees the ones they opened. */
export async function listTickets(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly TicketSummary[]> {
  user(context);
  return withAccountTx(database, context, async (tx) =>
    (
      await tx
        .select()
        .from(tickets)
        .where(visible(context))
        .orderBy(desc(tickets.updatedAt), desc(tickets.id))
    ).map(summary),
  );
}

export async function getTicket(
  database: AppDatabase,
  context: TenantContext,
  ticketId: string,
): Promise<TicketDetail> {
  user(context);
  const id = idOf(ticketId);
  return withAccountTx(database, context, async (tx) => {
    const row = await findTicket(tx, context, id);
    const messages = await tx
      .select({
        id: ticketMessages.id,
        authorKind: ticketMessages.authorKind,
        body: ticketMessages.body,
        createdAt: ticketMessages.createdAt,
      })
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.organizationId, context.organizationId),
          eq(ticketMessages.ticketId, id),
        ),
      )
      .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));
    return {
      ...summary(row),
      messages: messages.map((message) => ({
        ...message,
        authorKind: message.authorKind as 'customer' | 'support',
      })),
    };
  });
}

/** `support.use`, in any standing, because someone suspended still has to reach a person. */
export async function openTicket(
  database: AppDatabase,
  context: TenantContext,
  input: { subject: string; category: TicketCategory; body: string },
): Promise<{ ticketId: string }> {
  user(context);
  const parsed = openTicketSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await checkTenant(tx, context);
    const [row] = await tx
      .insert(tickets)
      .values({
        organizationId: context.organizationId,
        subject: parsed.data.subject,
        category: parsed.data.category,
        openedByMembershipId: context.membershipId,
      })
      .returning();
    await tx.insert(ticketMessages).values({
      organizationId: context.organizationId,
      ticketId: row!.id,
      authorKind: 'customer',
      authorRef: context.membershipId,
      body: parsed.data.body,
    });
    await auditAction(tx, context, 'support.ticket_opened', `ticket:${row!.id}`);
    await emit(tx, context, {
      eventType: TICKET_OPENED,
      aggregateType: AGGREGATE_TICKET,
      aggregateId: row!.id,
      aggregateVersion: row!.version,
      classification: 'internal',
      payload: { ticket_id: row!.id },
    });
    return { ticketId: row!.id };
  });
}

export async function replyToTicket(
  database: AppDatabase,
  context: TenantContext,
  input: { ticketId: string; body: string; expectedVersion: number },
): Promise<{ version: number }> {
  user(context);
  const id = idOf(input.ticketId),
    parsed = replyTicketSchema.safeParse({ body: input.body });
  version(input.expectedVersion);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await checkTenant(tx, context);
    const row = await findTicket(tx, context, id, true);
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (row.status === 'closed') throw new AppError('INVALID_STATE');
    await tx.insert(ticketMessages).values({
      organizationId: context.organizationId,
      ticketId: id,
      authorKind: 'customer',
      authorRef: context.membershipId,
      body: parsed.data.body,
    });
    await tx
      .update(tickets)
      .set({
        status: 'waiting_on_support',
        resolvedAt: null,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, id));
    await auditAction(tx, context, 'support.ticket_replied', `ticket:${id}`);
    await emit(tx, context, {
      eventType: TICKET_REPLIED,
      aggregateType: AGGREGATE_TICKET,
      aggregateId: id,
      aggregateVersion: row.version + 1,
      classification: 'internal',
      payload: { ticket_id: id, author_kind: 'customer' },
    });
    return { version: row.version + 1 };
  });
}

export async function closeTicket(
  database: AppDatabase,
  context: TenantContext,
  input: { ticketId: string; expectedVersion: number },
): Promise<void> {
  user(context);
  const id = idOf(input.ticketId);
  version(input.expectedVersion);
  return withAccountTx(database, context, async (tx) => {
    await checkTenant(tx, context);
    const row = await findTicket(tx, context, id, true);
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (row.status === 'closed') return;
    await tx
      .update(tickets)
      .set({
        status: 'closed',
        resolvedAt: row.resolvedAt ?? new Date(),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, id));
    await auditAction(tx, context, 'support.ticket_closed', `ticket:${id}`);
  });
}

export type PublishedCoverage = {
  version: number;
  timezone: string;
  windows: readonly import('@ensemus/saas/support').CoverageWindow[];
} | null;

/** What the support page shows. Null says plainly that no hours have been published. */
export async function getPublishedCoverage(database: AppDatabase): Promise<PublishedCoverage> {
  return database.run(async (tx) => {
    const [row] = await tx
      .select({
        version: coverageSchedules.version,
        timezone: coverageSchedules.timezone,
        windows: coverageSchedules.schedule,
      })
      .from(coverageSchedules)
      .where(eq(coverageSchedules.status, 'approved'))
      .orderBy(desc(coverageSchedules.version))
      .limit(1);
    if (!row) return null;
    const windows = coverageWindowsSchema.safeParse(row.windows),
      timezone = coverageTimezoneSchema.safeParse(row.timezone);
    if (!windows.success || !timezone.success) throw new AppError('PREREQUISITES_INCOMPLETE');
    return { version: row.version, timezone: timezone.data, windows: windows.data };
  });
}
