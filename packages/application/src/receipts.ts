// Owned by the receipts slice (CONNECT-06). See docs/06-delivery/m3-slices.md and ADR-027 D6. Reading is
// filtered by who can read the Work Unit, and someone who cannot gets not found.
import type { EmailSendPayload, ProposeEmailActionBody } from '@ensemus/contracts/external-actions';
import {
  connections,
  externalActionAttempts,
  externalActionReceipts,
  externalActions,
  memberships,
  notifications,
  users,
  webhookDeliveries,
  webhookEndpoints,
  withTenantTx,
  workAssignments,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  ACTION_CONNECTOR_TYPES,
  MAX_RESOLUTION_REASON_LENGTH,
  RESOLUTIONS,
  type ExternalActionStatus,
  type ReceiptBasis,
  type ReceiptOutcome,
  type Resolution,
} from '@ensemus/domain/external-action';
import {
  AGGREGATE_EXTERNAL_ACTION,
  EXTERNAL_ACTION_RESOLVED,
  externalActionTargetRef,
  NOTIFY_EXTERNAL_ACTION_FAILED,
  NOTIFY_EXTERNAL_ACTION_SENT,
  NOTIFY_EXTERNAL_ACTION_UNKNOWN,
} from '@ensemus/domain/integration-events';
import { can, canChangeWork, canManageWork, type Classification } from '@ensemus/domain/policy';
import { and, asc, count, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from './errors';
import { emit } from './events';
import { auditAction, loadReadable, notify, visibleTo, type WorkRow } from './work';

export type ExternalActionSummary = {
  id: string;
  workUnitId: string;
  workTitle: string;
  toolName: string;
  /** Read from the payload, so a list can be told apart. Only ever shown to who can read the work. */
  subject: string | null;
  status: ExternalActionStatus;
  statusReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ExternalActionReceiptView = {
  outcome: ReceiptOutcome;
  basis: ReceiptBasis;
  code: string | null;
  providerStatus: number | null;
  externalId: string | null;
  actorName: string | null;
  recordedAt: Date;
};

export type ExternalActionDetail = ExternalActionSummary & {
  connectionName: string;
  /** The exact payload, for people who can read the work. */
  payload: unknown;
  requestHash: string;
  approvalId: string | null;
  externalId: string | null;
  supersedesId: string | null;
  retryOfId: string | null;
  attemptCount: number;
  receipts: readonly ExternalActionReceiptView[];
  resolution: Resolution | null;
  resolutionReason: string | null;
  resolvedByName: string | null;
  /** Whether this person may say what happened. Worked out here, so a page cannot get it wrong. */
  canResolve: boolean;
  /** Whether this person may ask for it again. */
  canRetry: boolean;
  /** Whether this person may change what would be sent, which is only before any attempt. */
  canRevise: boolean;
};

export type ExternalActionPage = {
  items: readonly ExternalActionSummary[];
  next: string | null;
};

const PAGE_SIZE = 50;
const REVIEW_LIMIT = 200;

const isUuid = (value: string) => z.uuid().safeParse(value).success;

const encodeCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify([at, id])).toString('base64url');

// A timestamp exactly as PostgreSQL wrote it. Anything else was not one of ours.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = z
      .tuple([z.string().regex(CURSOR_TIME), z.uuid()])
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { at, id };
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}

const SUMMARY = {
  id: externalActions.id,
  workUnitId: externalActions.workUnitId,
  workTitle: workUnits.title,
  toolName: externalActions.toolName,
  subject: sql<string | null>`${externalActions.payload} ->> 'subject'`,
  status: sql<ExternalActionStatus>`${externalActions.status}`,
  statusReason: externalActions.statusReason,
  version: externalActions.version,
  createdAt: externalActions.createdAt,
  updatedAt: externalActions.updatedAt,
};

export async function listExternalActions(
  database: AppDatabase,
  context: TenantContext,
  input: { workUnitId?: string; status?: ExternalActionStatus; after?: string; limit?: number },
): Promise<ExternalActionPage> {
  // A list exists for people. A service only ever works on the one intent it was started for.
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  const limit = Math.min(Math.max(input.limit ?? PAGE_SIZE, 1), PAGE_SIZE);
  const cursor = input.after ? decodeCursor(input.after) : null;
  return withTenantTx(database, context, async (tx) => {
    const rows = await tx
      .select({
        ...SUMMARY,
        // As text, because a JavaScript date would round microseconds away and skip rows.
        cursorAt: sql<string>`${externalActions.createdAt}::text`,
      })
      .from(externalActions)
      .innerJoin(workUnits, eq(workUnits.id, externalActions.workUnitId))
      .where(
        and(
          visibleTo(context),
          input.workUnitId ? eq(externalActions.workUnitId, input.workUnitId) : undefined,
          input.status ? eq(externalActions.status, input.status) : undefined,
          cursor
            ? or(
                sql`${externalActions.createdAt} < ${cursor.at}::timestamptz`,
                and(
                  sql`${externalActions.createdAt} = ${cursor.at}::timestamptz`,
                  lt(externalActions.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(externalActions.createdAt), desc(externalActions.id))
      .limit(limit + 1);
    const last = rows[limit - 1];
    return {
      items: rows.slice(0, limit).map(({ cursorAt: _unused, ...row }) => row),
      next: rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null,
    };
  });
}

async function isAssigned(tx: Tx, context: TenantContext, workUnitId: string) {
  if (context.actorType === 'service') return false;
  const rows = await tx
    .select({ m: workAssignments.membershipId })
    .from(workAssignments)
    .where(
      and(
        eq(workAssignments.workUnitId, workUnitId),
        eq(workAssignments.membershipId, context.membershipId),
      ),
    );
  return rows.length > 0;
}

/** What this person may do with this work, by the same rules as the work's own page. */
async function allowedOn(tx: Tx, context: TenantContext, work: WorkRow) {
  if (context.actorType === 'service') return { manage: false, change: false };
  const facts = {
    classification: work.classification as Classification,
    ownerMembershipId: work.ownerMembershipId,
    isAssigned: await isAssigned(tx, context, work.id),
  };
  const who = { membershipId: context.membershipId, role: context.role };
  return { manage: canManageWork(facts, who), change: canChangeWork(facts, who) };
}

export async function getExternalActionDetail(
  database: AppDatabase,
  context: TenantContext,
  externalActionId: string,
): Promise<ExternalActionDetail> {
  // Not found, as for anything else that is not there: this comes from an address bar.
  if (!isUuid(externalActionId)) throw new AppError('NOT_FOUND');
  return withTenantTx(database, context, async (tx) => {
    const [action] = await tx
      .select()
      .from(externalActions)
      .where(eq(externalActions.id, externalActionId));
    if (!action) throw new AppError('NOT_FOUND');
    const work = await loadReadable(tx, context, action.workUnitId);
    const allowed = await allowedOn(tx, context, work);
    const [connection] = await tx
      .select({ displayName: connections.displayName, state: connections.state })
      .from(connections)
      .where(eq(connections.id, action.connectionId));
    const attempts = await tx
      .select({ externalId: externalActionAttempts.externalId })
      .from(externalActionAttempts)
      .where(eq(externalActionAttempts.externalActionId, action.id))
      .orderBy(desc(externalActionAttempts.attemptNo));
    const receipts = await tx
      .select({
        outcome: sql<ReceiptOutcome>`${externalActionReceipts.outcome}`,
        basis: sql<ReceiptBasis>`${externalActionReceipts.basis}`,
        code: externalActionReceipts.code,
        providerStatus: externalActionReceipts.providerStatus,
        externalId: externalActionReceipts.externalId,
        actorName: users.name,
        recordedAt: externalActionReceipts.recordedAt,
      })
      .from(externalActionReceipts)
      .leftJoin(memberships, eq(memberships.id, externalActionReceipts.actorMembershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(eq(externalActionReceipts.externalActionId, action.id))
      .orderBy(asc(externalActionReceipts.recordedAt), asc(externalActionReceipts.id));
    const [resolver] = action.resolvedByMembershipId
      ? await tx
          .select({ name: users.name })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(eq(memberships.id, action.resolvedByMembershipId))
      : [];

    const status = action.status as ExternalActionStatus;
    const connectionActive = connection?.state === 'active';
    return {
      id: action.id,
      workUnitId: action.workUnitId,
      workTitle: work.title,
      toolName: action.toolName,
      subject: subjectOf(action.payload),
      status,
      statusReason: action.statusReason,
      version: action.version,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      connectionName: connection?.displayName ?? '',
      payload: action.payload,
      requestHash: action.requestHash,
      approvalId: action.approvalId,
      // Whichever step got it down, so someone asked to search for it always has it if it exists.
      externalId:
        action.externalId ??
        attempts.find((attempt) => attempt.externalId)?.externalId ??
        receipts.findLast((receipt) => receipt.externalId)?.externalId ??
        null,
      supersedesId: action.supersedesId,
      retryOfId: action.retryOfId,
      attemptCount: attempts.length,
      receipts,
      resolution: action.resolution as Resolution | null,
      resolutionReason: action.resolutionReason,
      resolvedByName: resolver?.name ?? null,
      canResolve: status === 'unknown' && allowed.manage,
      canRetry: status === 'failed' && allowed.change && connectionActive,
      canRevise:
        (status === 'awaiting_approval' || status === 'ready') &&
        attempts.length === 0 &&
        allowed.change &&
        connectionActive,
    };
  });
}

const subjectOf = (payload: unknown) => {
  const subject = (payload as { subject?: unknown } | null)?.subject;
  return typeof subject === 'string' ? subject : null;
};

/** Everything unknown this person may resolve, oldest first. */
export async function listExternalActionsNeedingReview(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly ExternalActionSummary[]> {
  // A service may not resolve anything, so nothing is waiting on one.
  if (context.actorType === 'service') return [];
  const elevated = context.role === 'owner' || context.role === 'admin';
  return withTenantTx(database, context, (tx) =>
    tx
      .select(SUMMARY)
      .from(externalActions)
      .innerJoin(workUnits, eq(workUnits.id, externalActions.workUnitId))
      .where(
        and(
          eq(externalActions.status, 'unknown'),
          // canManageWork, as a query: starting from what they can read keeps an admin out of
          // restricted work they are not on.
          visibleTo(context),
          elevated ? undefined : eq(workUnits.ownerMembershipId, context.membershipId),
        ),
      )
      .orderBy(asc(externalActions.updatedAt), asc(externalActions.id))
      .limit(REVIEW_LIMIT),
  );
}

/** How many of those there are, for a page that only needs to say so. */
export async function countExternalActionsNeedingReview(
  database: AppDatabase,
  context: TenantContext,
): Promise<number> {
  if (context.actorType === 'service') return 0;
  const elevated = context.role === 'owner' || context.role === 'admin';
  const [row] = await withTenantTx(database, context, (tx) =>
    tx
      .select({ n: count() })
      .from(externalActions)
      .innerJoin(workUnits, eq(workUnits.id, externalActions.workUnitId))
      .where(
        and(
          eq(externalActions.status, 'unknown'),
          visibleTo(context),
          elevated ? undefined : eq(workUnits.ownerMembershipId, context.membershipId),
        ),
      ),
  );
  return row?.n ?? 0;
}

const RESOLVED: Record<
  Resolution,
  {
    status: 'sent' | 'failed';
    code: 'PERSON_CONFIRMED_SENT' | 'PERSON_CONFIRMED_NOT_SENT';
    kind: string;
  }
> = {
  confirmed_sent: {
    status: 'sent',
    code: 'PERSON_CONFIRMED_SENT',
    kind: NOTIFY_EXTERNAL_ACTION_SENT,
  },
  confirmed_not_sent: {
    status: 'failed',
    code: 'PERSON_CONFIRMED_NOT_SENT',
    kind: NOTIFY_EXTERNAL_ACTION_FAILED,
  },
};

/**
 * A person says what happened. Only from `unknown`, and only by someone who canManageWork, which leaves
 * out a service. Writes a person's receipt, an audit row and external_action.resolved. Saying it was not
 * sent ends it as failed: doing it again is retryExternalAction, with a new approval.
 */
export async function resolveUnknownExternalAction(
  database: AppDatabase,
  context: TenantContext,
  input: {
    externalActionId: string;
    expectedVersion: number;
    resolution: Resolution;
    reason: string;
  },
): Promise<{ status: 'sent' | 'failed'; version: number }> {
  // The trigger needs a named person for this move, and a service has no name to give (ADR-027 D6).
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  if (!isUuid(input.externalActionId)) throw new AppError('NOT_FOUND');
  if (!RESOLUTIONS.includes(input.resolution)) throw new AppError('INVALID_INPUT');
  const reason = input.reason.trim();
  if (!reason) throw new AppError('REASON_REQUIRED');
  if (reason.length > MAX_RESOLUTION_REASON_LENGTH) throw new AppError('INVALID_INPUT');
  const resolved = RESOLVED[input.resolution];

  return withTenantTx(database, context, async (tx) => {
    // Locked, so two people answering at once cannot both be believed.
    const [action] = await tx
      .select()
      .from(externalActions)
      .where(eq(externalActions.id, input.externalActionId))
      .for('update');
    if (!action) throw new AppError('NOT_FOUND');
    const work = await loadReadable(tx, context, action.workUnitId);
    const { manage } = await allowedOn(tx, context, work);
    if (!manage) throw new AppError('FORBIDDEN');
    if (action.status !== 'unknown') throw new AppError('EXTERNAL_ACTION_NOT_RESOLVABLE');
    if (action.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');

    const now = new Date();
    const version = action.version + 1;
    await tx
      .update(externalActions)
      .set({
        status: resolved.status,
        statusReason: resolved.code,
        resolvedByMembershipId: context.membershipId,
        resolution: input.resolution,
        // Kept here under the Work Unit's access rules, and never in events, audit or Temporal.
        resolutionReason: reason,
        version,
        updatedAt: now,
        settledAt: now,
      })
      .where(eq(externalActions.id, action.id));
    await tx.insert(externalActionReceipts).values({
      organizationId: context.organizationId,
      externalActionId: action.id,
      outcome: resolved.status,
      basis: 'person',
      code: resolved.code,
      externalId: action.externalId,
      requestHash: action.requestHash,
      actorMembershipId: context.membershipId,
      recordedAt: now,
    });
    const targetRef = externalActionTargetRef(action.id);
    await auditAction(tx, context, EXTERNAL_ACTION_RESOLVED, targetRef, resolved.code);
    await emit(tx, context, {
      eventType: EXTERNAL_ACTION_RESOLVED,
      aggregateType: AGGREGATE_EXTERNAL_ACTION,
      aggregateId: action.id,
      aggregateVersion: version,
      classification: action.classification,
      payload: {
        external_action_id: action.id,
        work_unit_id: action.workUnitId,
        resolution: input.resolution,
        status: resolved.status,
      },
    });
    // The question has an answer now, so nobody else should still be asked it.
    await tx
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())`, remindAt: null })
      .where(
        and(
          eq(notifications.targetRef, targetRef),
          eq(notifications.kind, NOTIFY_EXTERNAL_ACTION_UNKNOWN),
        ),
      );
    await notify(
      tx,
      context,
      [work.ownerMembershipId, action.createdByMembershipId],
      resolved.kind,
      targetRef,
    );
    return { status: resolved.status, version };
  });
}

export type WebhookActivity = {
  id: string;
  connectionId: string;
  state: string;
  rejectCode: string | null;
  receivedAt: Date;
};

const WEBHOOK_ACTIVITY_LIMIT = 20;

/**
 * Recent callbacks and how each ended, for whoever manages connections. A sender always hears the same
 * answer, so this is the only way to see that a signature failed (ADR-027 Trade-offs). It reads metadata
 * only: the body and headers of something nobody has verified never come here.
 */
export async function listWebhookActivity(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly WebhookActivity[]> {
  if (!can(context.role, 'connection.manage')) throw new AppError('FORBIDDEN');
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: webhookDeliveries.id,
        connectionId: webhookEndpoints.connectionId,
        state: webhookDeliveries.state,
        rejectCode: webhookDeliveries.rejectCode,
        receivedAt: webhookDeliveries.receivedAt,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .orderBy(desc(webhookDeliveries.receivedAt), desc(webhookDeliveries.id))
      .limit(WEBHOOK_ACTIVITY_LIMIT),
  );
}

export type ActionConnection = {
  id: string;
  displayName: string;
  connectorType: string;
  /** The address it sends as. Not a secret: anyone approving a send sees it on the approval. */
  fromAddress: string | null;
  fromName?: string;
};

const senderSettings = z.looseObject({
  fromAddress: z.string().min(1),
  fromName: z.string().min(1).optional(),
});

function senderOf(config: unknown): { fromAddress: string | null; fromName?: string } {
  const parsed = senderSettings.safeParse(config);
  if (!parsed.success) return { fromAddress: null };
  return {
    fromAddress: parsed.data.fromAddress,
    ...(parsed.data.fromName ? { fromName: parsed.data.fromName } : {}),
  };
}

/**
 * The connections someone can choose when proposing a send, and what decides whether work may ask for an
 * outside system's receipt. Managing connections takes connection.manage, and seeing that one exists does
 * not: whoever works on this has to be able to say which mail server it goes through.
 */
export function listActionConnections(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly ActionConnection[]> {
  return withTenantTx(database, context, async (tx) => {
    const rows = await tx
      .select({
        id: connections.id,
        displayName: connections.displayName,
        connectorType: connections.connectorType,
        config: connections.config,
      })
      .from(connections)
      .where(
        and(
          eq(connections.state, 'active'),
          inArray(connections.connectorType, [...ACTION_CONNECTOR_TYPES]),
        ),
      )
      .orderBy(asc(connections.displayName), asc(connections.id));
    return rows.map(({ config, ...row }) => ({ ...row, ...senderOf(config) }));
  });
}

async function loadSender(tx: Tx, connectionId: string) {
  const [connection] = await tx
    .select({
      state: connections.state,
      connectorType: connections.connectorType,
      config: connections.config,
    })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!connection) throw new AppError('NOT_FOUND');
  if (connection.state !== 'active') throw new AppError('CONNECTION_NOT_ACTIVE');
  if (!ACTION_CONNECTOR_TYPES.includes(connection.connectorType)) {
    throw new AppError('INVALID_INPUT');
  }
  const { fromAddress, fromName } = senderOf(connection.config);
  if (!fromAddress) throw new AppError('INVALID_INPUT');
  return { address: fromAddress, ...(fromName ? { name: fromName } : {}) };
}

type EmailContent = ProposeEmailActionBody['email'];

/**
 * The whole payload an approver will see. The sender is read from the connection now and frozen in the
 * payload, so nothing a caller sends can set it, and an administrator changing a connection's address
 * later cannot change what someone has already agreed to (ADR-027 D1).
 */
export async function emailPayloadFromConnection(
  database: AppDatabase,
  context: TenantContext,
  connectionId: string,
  email: EmailContent,
): Promise<EmailSendPayload> {
  if (!isUuid(connectionId)) throw new AppError('NOT_FOUND');
  return withTenantTx(database, context, async (tx) => ({
    ...email,
    from: await loadSender(tx, connectionId),
  }));
}

/** The same for changing an action, through the connection that action already names. */
export async function emailPayloadForRevision(
  database: AppDatabase,
  context: TenantContext,
  externalActionId: string,
  email: EmailContent,
): Promise<EmailSendPayload> {
  if (!isUuid(externalActionId)) throw new AppError('NOT_FOUND');
  return withTenantTx(database, context, async (tx) => {
    const [action] = await tx
      .select({
        workUnitId: externalActions.workUnitId,
        connectionId: externalActions.connectionId,
      })
      .from(externalActions)
      .where(eq(externalActions.id, externalActionId));
    if (!action) throw new AppError('NOT_FOUND');
    await loadReadable(tx, context, action.workUnitId);
    return { ...email, from: await loadSender(tx, action.connectionId) };
  });
}
