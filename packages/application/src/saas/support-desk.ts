// The desk's side, as `ensemus_support`, which cannot read anything else in the database. Owned by the
// support slice (OPS-22, OPS-24). It runs from the operator's command, and there is no web path to it.
import type { EnsemusDrizzle } from '@ensemus/database/support';
import type { TicketStatus } from '@ensemus/saas/support';
import {
  breakGlassLog,
  breakGlassRequests,
  coverageSchedules,
  operatorActions,
  ticketMessages,
  tickets,
  type Tx,
} from '@ensemus/database';
import { replyTicketSchema } from '@ensemus/contracts/saas';
import { TICKET_STATUSES } from '@ensemus/saas/support';
import { and, asc, eq, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';
import { z } from 'zod';
import { coverageTimezoneSchema, coverageWindowsSchema } from './support';

const operatorReference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\r\n\0]/.test(value));
const ticketCommandSchema = z.strictObject({ organizationId: idSchema, ticketId: idSchema }),
  coverageCommandSchema = z.strictObject({ coverageId: idSchema, operatorRef: operatorReference });
export const deskCommandInputSchemas = {
  queue: z.strictObject({
    status: z.enum(TICKET_STATUSES).optional(),
    limit: z.int().min(1).max(100),
  }),
  show: ticketCommandSchema,
  reply: ticketCommandSchema.extend({
    agentRef: operatorReference,
    body: z.string().trim().min(1).max(20000),
  }),
  request: ticketCommandSchema.extend({
    requestedBy: operatorReference,
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    scopeType: z.enum(['work_unit', 'artifact', 'client', 'project']),
    scopeId: idSchema,
    requestedMinutes: z.int().min(1),
  }),
  authorize: z.strictObject({
    organizationId: idSchema,
    requestId: idSchema,
    operatorRef: operatorReference,
  }),
  'coverage-draft': z.strictObject({
    operatorRef: operatorReference,
    staffedByRef: operatorReference,
    timezone: coverageTimezoneSchema,
    windows: coverageWindowsSchema,
  }),
  'coverage-approve': coverageCommandSchema,
  'coverage-retire': coverageCommandSchema,
};

async function operator(tx: Tx) {
  const role = await tx.execute(sql`select current_user as role`);
  if (role.rows[0]?.role !== 'ensemus_operator') throw new AppError('NOT_FOUND');
}
export async function draftSupportCoverage(
  db: DeskDb,
  input: z.input<(typeof deskCommandInputSchemas)['coverage-draft']>,
): Promise<{ coverageId: string }> {
  const value = deskCommandInputSchemas['coverage-draft'].parse(input);
  return db.transaction(async (tx) => {
    await operator(tx);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('support:coverage_versions',0))`,
    );
    const result = await tx.execute(
      sql`select coalesce(max(version),0)+1 as n from support.coverage_schedules`,
    );
    const next = Number(result.rows[0]?.n);
    if (!Number.isSafeInteger(next) || next < 1) throw new AppError('PREREQUISITES_INCOMPLETE');
    const [row] = await tx
      .insert(coverageSchedules)
      .values({
        version: next,
        timezone: value.timezone,
        schedule: value.windows,
        staffedByRef: value.staffedByRef,
        draftedBy: value.operatorRef,
      })
      .returning({ id: coverageSchedules.id });
    await tx.insert(operatorActions).values({
      operatorRef: value.operatorRef,
      action: 'support.coverage.drafted',
      targetRef: `coverage:${row!.id}`,
    });
    return { coverageId: row!.id };
  });
}
async function changeCoverage(
  db: DeskDb,
  input: z.input<typeof coverageCommandSchema>,
  command: 'approve' | 'retire',
) {
  const value = coverageCommandSchema.parse(input);
  return db.transaction(async (tx) => {
    await operator(tx);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('support:coverage_versions',0))`,
    );
    const [row] = await tx
      .select()
      .from(coverageSchedules)
      .where(eq(coverageSchedules.id, value.coverageId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (command === 'approve') {
      if (row.status !== 'draft') throw new AppError('INVALID_STATE');
      coverageWindowsSchema.parse(row.schedule);
      coverageTimezoneSchema.parse(row.timezone);
      if (!row.staffedByRef.trim()) throw new AppError('PREREQUISITES_INCOMPLETE');
      await tx
        .update(coverageSchedules)
        .set({ status: 'retired', retiredAt: new Date() })
        .where(eq(coverageSchedules.status, 'approved'));
      await tx
        .update(coverageSchedules)
        .set({ status: 'approved', approvedBy: value.operatorRef, approvedAt: new Date() })
        .where(eq(coverageSchedules.id, row.id));
    } else {
      if (row.status !== 'approved') throw new AppError('INVALID_STATE');
      await tx
        .update(coverageSchedules)
        .set({ status: 'retired', retiredAt: new Date() })
        .where(eq(coverageSchedules.id, row.id));
    }
    await tx.insert(operatorActions).values({
      operatorRef: value.operatorRef,
      action: command === 'approve' ? 'support.coverage.approved' : 'support.coverage.retired',
      targetRef: `coverage:${row.id}`,
    });
  });
}
export const approveSupportCoverage = (db: DeskDb, input: z.input<typeof coverageCommandSchema>) =>
  changeCoverage(db, input, 'approve');
export const retireSupportCoverage = (db: DeskDb, input: z.input<typeof coverageCommandSchema>) =>
  changeCoverage(db, input, 'retire');

async function desk(tx: Tx) {
  const result = await tx.execute(sql`select current_user as role`);
  if (result.rows[0]?.role !== 'ensemus_support') throw new AppError('NOT_FOUND');
}
const idOf = (value: string) => {
  const result = idSchema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
};
const reference = (value: string) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value === value.trim() &&
  value.length <= 200 &&
  !/[\r\n\0]/.test(value);
async function ticket(tx: Tx, organizationId: string, ticketId: string, lock = false) {
  const query = tx
    .select()
    .from(tickets)
    .where(and(eq(tickets.organizationId, organizationId), eq(tickets.id, ticketId)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}
/**
 * The desk reads every tenant's queue, but each write it makes is born in exactly one tenant. The
 * erasure birth fence (0508, restored for support content by 0533) requires a new row to name the
 * tenant the transaction is bound to, so a desk write binds to the tenant of the ticket it has just
 * locked, never to a value that only the caller supplied.
 */
async function bindTicketTenant(tx: Tx, row: { organizationId: string }) {
  await tx.execute(sql`select set_config('app.organization_id', ${row.organizationId}, true)`);
}

export type DeskDb = EnsemusDrizzle;

/** Only the fixed erasure fence's NOWAIT refusal is retryable. No provider action is replayed. */
export class SupportContentBusy extends Error {
  override name = 'SupportContentBusy';
  readonly code = 'SUPPORT_CONTENT_BUSY';
  readonly retryable = true;
  constructor() {
    super('This organization is being updated. Try again.');
  }
}

export async function listDeskQueue(
  db: DeskDb,
  input: { status?: TicketStatus; limit: number },
): Promise<
  readonly { organizationId: string; ticketId: string; status: string; updatedAt: Date }[]
> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.status !== undefined && !TICKET_STATUSES.includes(input.status))
  )
    throw new AppError('INVALID_INPUT');
  return db.transaction(async (tx) => {
    await desk(tx);
    return tx
      .select({
        organizationId: tickets.organizationId,
        ticketId: tickets.id,
        status: tickets.status,
        updatedAt: tickets.updatedAt,
      })
      .from(tickets)
      .where(input.status ? eq(tickets.status, input.status) : undefined)
      .orderBy(asc(tickets.updatedAt), asc(tickets.id))
      .limit(input.limit);
  });
}

/** Opening a named ticket is the explicit step that reveals what the customer chose to send the desk. */
export async function getDeskTicket(
  db: DeskDb,
  input: { organizationId: string; ticketId: string },
) {
  const organizationId = idOf(input.organizationId),
    ticketId = idOf(input.ticketId);
  return db.transaction(async (tx) => {
    await desk(tx);
    const row = await ticket(tx, organizationId, ticketId);
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
          eq(ticketMessages.organizationId, organizationId),
          eq(ticketMessages.ticketId, ticketId),
        ),
      )
      .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));
    return {
      id: row.id,
      organizationId,
      subject: row.subject,
      category: row.category,
      status: row.status,
      messages,
    };
  });
}

/** Sets `first_response_at` the first time, which is how response times are measured and not promised. */
export async function replyAsDesk(
  db: DeskDb,
  input: { organizationId: string; ticketId: string; agentRef: string; body: string },
): Promise<void> {
  const organizationId = idOf(input.organizationId),
    ticketId = idOf(input.ticketId),
    parsed = replyTicketSchema.safeParse({ body: input.body });
  if (!parsed.success || !reference(input.agentRef)) throw new AppError('INVALID_INPUT');
  try {
    return await db.transaction(async (tx) => {
      await desk(tx);
      const row = await ticket(tx, organizationId, ticketId, true);
      if (row.status === 'closed') throw new AppError('INVALID_STATE');
      await bindTicketTenant(tx, row);
      const now = new Date();
      await tx.insert(ticketMessages).values({
        organizationId,
        ticketId,
        authorKind: 'support',
        authorRef: input.agentRef,
        body: parsed.data.body,
      });
      await tx
        .update(tickets)
        .set({
          status: 'waiting_on_customer',
          firstResponseAt: row.firstResponseAt ?? now,
          resolvedAt: null,
          version: row.version + 1,
          updatedAt: now,
        })
        .where(and(eq(tickets.organizationId, organizationId), eq(tickets.id, ticketId)));
    });
  } catch (error) {
    if (pgCode(error) === 'EN807') throw new SupportContentBusy();
    throw error;
  }
}

/** Files a request, which grants nothing. Refused unless the deployment has break-glass turned on. */
export async function requestBreakGlass(
  db: DeskDb,
  input: {
    organizationId: string;
    ticketId: string;
    requestedBy: string;
    reasonCode: string;
    scopeType: 'work_unit' | 'artifact' | 'client' | 'project';
    scopeId: string;
    requestedMinutes: number;
  },
  config: import('@ensemus/saas/support').BreakGlassConfig,
): Promise<{ requestId: string }> {
  if (!config.enabled) throw new AppError('BREAK_GLASS_DISABLED');
  const organizationId = idOf(input.organizationId),
    ticketId = idOf(input.ticketId),
    scopeId = idOf(input.scopeId);
  if (
    !reference(input.requestedBy) ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.reasonCode) ||
    !['work_unit', 'artifact', 'client', 'project'].includes(input.scopeType) ||
    !Number.isSafeInteger(input.requestedMinutes) ||
    input.requestedMinutes < 1 ||
    !Number.isSafeInteger(config.maxMinutes) ||
    config.maxMinutes < 1 ||
    input.requestedMinutes > config.maxMinutes
  )
    throw new AppError('INVALID_INPUT');
  return db.transaction(async (tx) => {
    await desk(tx);
    const row = await ticket(tx, organizationId, ticketId, true);
    if (row.status === 'closed') throw new AppError('INVALID_STATE');
    await bindTicketTenant(tx, row);
    const [request] = await tx
      .insert(breakGlassRequests)
      .values({
        organizationId,
        ticketId,
        requestedBy: input.requestedBy,
        reasonCode: input.reasonCode,
        scopeType: input.scopeType,
        scopeId,
        requestedMinutes: input.requestedMinutes,
      })
      .returning({ id: breakGlassRequests.id });
    await tx.insert(breakGlassLog).values({
      organizationId,
      requestId: request!.id,
      action: 'requested',
      actorRef: input.requestedBy,
      targetRef: `${input.scopeType}:${scopeId}`,
    });
    return { requestId: request!.id };
  });
}
