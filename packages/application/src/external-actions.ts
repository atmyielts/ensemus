// External action intents (WORK-08, ADR-027 D1 and D2). An intent is one exact effect, and it is immutable:
// changing it means a new intent and a new approval. The rule that at most one effect happens is in the
// triggers in migration 0013. This file is what the application does on top of them, and a bug here can make
// it stop early or say less, but cannot get past them.
//
// Locks go work, then approval, then intent, the same order everything that closes an approval takes. The
// two steps that record a provider's answer take only the intent, and never wait for the work.
import { randomUUID } from 'node:crypto';
import {
  approvals,
  connections,
  externalActionAttempts,
  externalActionReceipts,
  externalActions,
  withTenantTx,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { emailSendPayloadSchema } from '@ensemus/contracts/external-actions';
import {
  ACTION_CONNECTOR_TYPES,
  checkBeforeSend,
  connectionRef,
  decideAfterAttempt,
  decideAfterReconcile,
  EMAIL_CONNECTOR_TYPE,
  EMAIL_SEND_TOOL,
  EMAIL_SEND_VERSION,
  idempotencyKeyFor,
  isSettledExternalAction,
  proposedActionFor,
  requestHashFor,
  type AttemptResult,
  type ExternalActionCode,
  type ExternalActionStatus,
  type ReceiptBasis,
  type ReceiptOutcome,
  type ReconcileResult,
} from '@ensemus/domain/external-action';
import {
  AGGREGATE_EXTERNAL_ACTION,
  EXTERNAL_ACTION_CANCELLED,
  EXTERNAL_ACTION_FAILED,
  EXTERNAL_ACTION_PROPOSED,
  EXTERNAL_ACTION_READY,
  EXTERNAL_ACTION_SENT,
  EXTERNAL_ACTION_UNKNOWN,
  externalActionTargetRef,
  NOTIFY_EXTERNAL_ACTION_FAILED,
  NOTIFY_EXTERNAL_ACTION_SENT,
  NOTIFY_EXTERNAL_ACTION_UNKNOWN,
} from '@ensemus/domain/integration-events';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createApprovalInTx, REVIEW_HOURS } from './approvals';
import { AppError } from './errors';
import { emit } from './events';
import type { PreparedAttempt } from './integration-ports';
import {
  auditAction,
  clearApprovalNotifications,
  loadChangeable,
  notify,
  recordApprovalClosed,
} from './work';

export type ProposeExternalActionInput = {
  workUnitId: string;
  connectionId: string;
  toolName: string;
  toolVersion: string;
  /** Checked against the tool's schema here, and frozen once written. */
  payload: unknown;
  /** Who is asked. Never the person proposing it. */
  approverMembershipId: string;
  expiresAt?: Date;
  supersedesId?: string;
  retryOfId?: string;
};

export type ProposedExternalAction = {
  externalActionId: string;
  approvalId: string;
  requestHash: string;
};

type ActionRow = typeof externalActions.$inferSelect;

const connectionSender = z.object({
  fromAddress: z.string(),
  fromName: z.string().optional(),
});

/**
 * An email's exact payload. The sender comes from the connection, right now, so what an approver agrees to
 * has it written down, and a later change to the connection cannot alter that. A caller may repeat the
 * connection's address, as a stored payload does, and may not name any other.
 */
function freezeEmailPayload(payload: unknown, config: unknown) {
  const sender = connectionSender.safeParse(config);
  if (!sender.success) throw new AppError('INVALID_INPUT');
  const given = (payload ?? {}) as { from?: { address?: unknown } | null };
  if (given.from !== undefined && given.from?.address !== sender.data.fromAddress) {
    throw new AppError('INVALID_INPUT');
  }
  const parsed = emailSendPayloadSchema.safeParse({
    ...given,
    from: {
      address: sender.data.fromAddress,
      ...(sender.data.fromName ? { name: sender.data.fromName } : {}),
    },
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

/** Everything that moves an intent's status goes through here, so the row and its version move together. */
async function moveAction(
  tx: Tx,
  action: ActionRow,
  to: ExternalActionStatus,
  code: ExternalActionCode | null,
  extra: { externalId?: string } = {},
) {
  const now = new Date();
  const version = action.version + 1;
  await tx
    .update(externalActions)
    .set({
      status: to,
      statusReason: code,
      version,
      updatedAt: now,
      ...(isSettledExternalAction(to) ? { settledAt: now } : {}),
      ...(extra.externalId ? { externalId: extra.externalId } : {}),
    })
    .where(eq(externalActions.id, action.id));
  return { ...action, status: to, statusReason: code, version };
}

function addReceipt(
  tx: Tx,
  context: TenantContext,
  action: ActionRow,
  receipt: {
    outcome: ReceiptOutcome;
    basis: ReceiptBasis;
    code: ExternalActionCode;
    attemptId?: string;
    providerStatus?: number | undefined;
    externalId?: string | null | undefined;
  },
) {
  return (
    tx
      .insert(externalActionReceipts)
      .values({
        organizationId: context.organizationId,
        externalActionId: action.id,
        attemptId: receipt.attemptId ?? null,
        outcome: receipt.outcome,
        basis: receipt.basis,
        code: receipt.code,
        providerStatus: receipt.providerStatus ?? null,
        externalId: receipt.externalId ?? null,
        requestHash: action.requestHash,
      })
      // A retried Activity writing the same result finds it already there.
      .onConflictDoNothing()
  );
}

/** A fact for projections, by ID and code. The payload never goes in an event. */
function emitActionEvent(
  tx: Tx,
  context: TenantContext,
  action: ActionRow,
  eventType: string,
  code?: ExternalActionCode | null,
) {
  return emit(tx, context, {
    eventType,
    aggregateType: AGGREGATE_EXTERNAL_ACTION,
    aggregateId: action.id,
    aggregateVersion: action.version,
    classification: action.classification,
    payload: {
      external_action_id: action.id,
      work_unit_id: action.workUnitId,
      ...(code ? { code } : {}),
    },
  });
}

/** Tells whoever answers for the work and whoever asked. A reference is all that goes in the inbox. */
async function tellPeople(tx: Tx, context: TenantContext, action: ActionRow, kind: string) {
  const [work] = await tx
    .select({ ownerMembershipId: workUnits.ownerMembershipId })
    .from(workUnits)
    .where(eq(workUnits.id, action.workUnitId));
  await notify(
    tx,
    context,
    [work?.ownerMembershipId, action.createdByMembershipId],
    kind,
    externalActionTargetRef(action.id),
  );
}

/** Ends an intent that never reached anyone, and says why. */
async function cancelAction(
  tx: Tx,
  context: TenantContext,
  action: ActionRow,
  code: ExternalActionCode,
) {
  const moved = await moveAction(tx, action, 'cancelled', code);
  await addReceipt(tx, context, moved, { outcome: 'cancelled', basis: 'system', code });
  await emitActionEvent(tx, context, moved, EXTERNAL_ACTION_CANCELLED, code);
  await auditAction(
    tx,
    context,
    'external_action.cancelled',
    externalActionTargetRef(action.id),
    code,
  );
  return moved;
}

async function endAsFailed(
  tx: Tx,
  context: TenantContext,
  action: ActionRow,
  code: ExternalActionCode,
  receipt: {
    basis: ReceiptBasis;
    attemptId?: string;
    providerStatus?: number | undefined;
    externalId?: string | undefined;
  },
) {
  const moved = await moveAction(tx, action, 'failed', code);
  await addReceipt(tx, context, moved, { outcome: 'failed', code, ...receipt });
  await emitActionEvent(tx, context, moved, EXTERNAL_ACTION_FAILED, code);
  await auditAction(
    tx,
    context,
    'external_action.failed',
    externalActionTargetRef(action.id),
    code,
  );
  await tellPeople(tx, context, moved, NOTIFY_EXTERNAL_ACTION_FAILED);
  return moved;
}

async function endAsSent(
  tx: Tx,
  context: TenantContext,
  action: ActionRow,
  code: ExternalActionCode,
  receipt: {
    basis: ReceiptBasis;
    attemptId: string;
    providerStatus?: number | undefined;
    externalId?: string | undefined;
  },
) {
  const moved = await moveAction(tx, action, 'sent', code, {
    ...(receipt.externalId ? { externalId: receipt.externalId } : {}),
  });
  await addReceipt(tx, context, moved, { outcome: 'sent', code, ...receipt });
  await emitActionEvent(tx, context, moved, EXTERNAL_ACTION_SENT, code);
  await auditAction(tx, context, 'external_action.sent', externalActionTargetRef(action.id), code);
  await tellPeople(tx, context, moved, NOTIFY_EXTERNAL_ACTION_SENT);
  return moved;
}

/**
 * Writes the intent and its approval in the caller's transaction, with the same hash on both, and emits
 * external_action.proposed. Refuses restricted work and a connection that is not active.
 */
export async function proposeExternalActionInTx(
  tx: Tx,
  context: TenantContext,
  input: ProposeExternalActionInput,
): Promise<ProposedExternalAction> {
  const work = await loadChangeable(tx, context, input.workUnitId);
  // Its data class denies leaving by default, and the check on the table holds this too.
  if (work.classification === 'restricted') throw new AppError('RESTRICTED_NOT_ALLOWED');

  if (input.toolName !== EMAIL_SEND_TOOL || input.toolVersion !== EMAIL_SEND_VERSION) {
    throw new AppError('INVALID_INPUT');
  }
  const [connection] = await tx
    .select()
    .from(connections)
    .where(eq(connections.id, input.connectionId))
    .for('share');
  if (!connection) throw new AppError('NOT_FOUND');
  if (connection.state !== 'active') throw new AppError('CONNECTION_NOT_ACTIVE');
  if (connection.connectorType !== EMAIL_CONNECTOR_TYPE) throw new AppError('INVALID_INPUT');

  const payload = freezeEmailPayload(input.payload, connection.config);
  const proposal = {
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    connectionId: connection.id,
    payload,
  };
  const action = proposedActionFor(proposal);
  const approval = await createApprovalInTx(tx, context, {
    workUnitId: work.id,
    action,
    approverMembershipId: input.approverMembershipId,
    expiresAt: input.expiresAt ?? new Date(Date.now() + REVIEW_HOURS * 60 * 60 * 1000),
  });

  const id = randomUUID();
  const createdBy = context.actorType === 'service' ? null : context.membershipId;
  const [row] = await tx
    .insert(externalActions)
    .values({
      organizationId: context.organizationId,
      id,
      workUnitId: work.id,
      connectionId: connection.id,
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      targetRef: connectionRef(connection.id),
      payload,
      requestHash: approval.actionHash,
      idempotencyKey: idempotencyKeyFor(id),
      classification: work.classification,
      requiresApproval: true,
      approvalId: approval.id,
      supersedesId: input.supersedesId ?? null,
      retryOfId: input.retryOfId ?? null,
      status: 'awaiting_approval',
      createdByMembershipId: createdBy,
    })
    .returning();
  await emitActionEvent(tx, context, row as ActionRow, EXTERNAL_ACTION_PROPOSED);
  await auditAction(tx, context, 'external_action.proposed', externalActionTargetRef(id));
  return { externalActionId: id, approvalId: approval.id, requestHash: approval.actionHash };
}

export function proposeExternalAction(
  database: AppDatabase,
  context: TenantContext,
  input: ProposeExternalActionInput,
): Promise<ProposedExternalAction> {
  return withTenantTx(database, context, (tx) => proposeExternalActionInTx(tx, context, input));
}

/** Finds an intent without locking it, so the work can be locked first. Another tenant's is not found. */
async function findAction(tx: Tx, id: string) {
  const [found] = await tx.select().from(externalActions).where(eq(externalActions.id, id));
  if (!found) throw new AppError('NOT_FOUND');
  return found;
}

async function lockAction(tx: Tx, id: string) {
  const [locked] = await tx
    .select()
    .from(externalActions)
    .where(eq(externalActions.id, id))
    .for('update');
  if (!locked) throw new AppError('NOT_FOUND');
  return locked;
}

function attemptsOf(tx: Tx, externalActionId: string) {
  return tx
    .select()
    .from(externalActionAttempts)
    .where(eq(externalActionAttempts.externalActionId, externalActionId))
    .orderBy(asc(externalActionAttempts.attemptNo));
}

/**
 * QA-007. Changing an intent means a new one: this closes the old intent as SUPERSEDED, cancels its
 * approval even if it was approved, and proposes the new payload for a new decision. Refused once any
 * attempt exists, with EXTERNAL_ACTION_NOT_EDITABLE.
 */
export function reviseExternalAction(
  database: AppDatabase,
  context: TenantContext,
  input: {
    externalActionId: string;
    expectedVersion: number;
    payload: unknown;
    approverMembershipId: string;
  },
): Promise<ProposedExternalAction> {
  return withTenantTx(database, context, async (tx) => {
    const found = await findAction(tx, input.externalActionId);
    const work = await loadChangeable(tx, context, found.workUnitId);
    const [approval] = found.approvalId
      ? await tx.select().from(approvals).where(eq(approvals.id, found.approvalId)).for('update')
      : [];
    const action = await lockAction(tx, found.id);
    if (action.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (action.status !== 'awaiting_approval' && action.status !== 'ready') {
      throw new AppError('EXTERNAL_ACTION_NOT_EDITABLE');
    }
    if ((await attemptsOf(tx, action.id)).length > 0) {
      throw new AppError('EXTERNAL_ACTION_NOT_EDITABLE');
    }

    // First, so closing the approval below finds nothing left to cancel on this intent's behalf.
    await cancelAction(tx, context, action, 'SUPERSEDED');
    if (approval && (approval.status === 'pending' || approval.status === 'approved')) {
      await tx
        .update(approvals)
        .set({ status: 'cancelled', decidedAt: new Date() })
        .where(eq(approvals.id, approval.id));
      if (approval.status === 'pending') {
        await recordApprovalClosed(tx, context, work, approval.id, {
          reason: 'SUPERSEDED',
          kind: 'approval.superseded',
          tell: [approval.requestedByMembershipId],
        });
      } else {
        // It was resolved when it was decided. This only stops that decision being spent.
        await clearApprovalNotifications(tx, [approval.id]);
        await auditAction(tx, context, 'approval.closed', `approval:${approval.id}`, 'SUPERSEDED');
      }
    }

    return proposeExternalActionInTx(tx, context, {
      workUnitId: action.workUnitId,
      connectionId: action.connectionId,
      toolName: action.toolName,
      toolVersion: action.toolVersion,
      payload: input.payload,
      approverMembershipId: input.approverMembershipId,
      supersedesId: action.id,
    });
  });
}

/** An intent that asked again and has not itself ended in not being sent. */
const STILL_LIVE: readonly ExternalActionStatus[] = [
  'awaiting_approval',
  'ready',
  'sending',
  'reconciling',
  'unknown',
  'sent',
];

/**
 * Asks again for an action that ended `failed`, as a new intent pointing back at it. It needs its own
 * approval, even if a person just said the old one was not sent. One at a time: two retries of one failure
 * would be two emails, each with a perfectly good approval.
 */
export function retryExternalAction(
  database: AppDatabase,
  context: TenantContext,
  input: { externalActionId: string; approverMembershipId: string },
): Promise<ProposedExternalAction> {
  return withTenantTx(database, context, async (tx) => {
    const found = await findAction(tx, input.externalActionId);
    await loadChangeable(tx, context, found.workUnitId);
    const action = await lockAction(tx, found.id);
    if (action.status !== 'failed') throw new AppError('EXTERNAL_ACTION_NOT_RETRYABLE');
    const live = await tx
      .select({ id: externalActions.id })
      .from(externalActions)
      .where(
        and(
          eq(externalActions.retryOfId, action.id),
          inArray(externalActions.status, [...STILL_LIVE]),
        ),
      );
    if (live.length > 0) throw new AppError('EXTERNAL_ACTION_NOT_RETRYABLE');
    // The sender is read from the connection again. What it was has no say in what goes out now.
    const { from: _from, ...rest } = action.payload as Record<string, unknown>;
    return proposeExternalActionInTx(tx, context, {
      workUnitId: action.workUnitId,
      connectionId: action.connectionId,
      toolName: action.toolName,
      toolVersion: action.toolVersion,
      payload: rest,
      approverMembershipId: input.approverMembershipId,
      retryOfId: action.id,
    });
  });
}

/**
 * Whether an `email.send` approval still binds what its intent holds, for deciding it. What a reviewer was
 * shown came from the approval, so a row changed behind the application's back has to be caught here too.
 */
export async function assertIntentMatchesApproval(
  tx: Tx,
  approval: { id: string; actionHash: string },
) {
  const [action] = await tx
    .select()
    .from(externalActions)
    .where(eq(externalActions.approvalId, approval.id));
  // A request made by hand for this tool, with no intent behind it, has nothing here that could go out.
  if (!action) return;
  if (action.status !== 'awaiting_approval') throw new AppError('APPROVAL_STALE');
  if (action.requestHash !== approval.actionHash || recomputeHash(action) !== approval.actionHash) {
    throw new AppError('APPROVAL_STALE');
  }
}

const recomputeHash = (action: ActionRow) =>
  requestHashFor({
    toolName: action.toolName,
    toolVersion: action.toolVersion,
    connectionId: action.connectionId,
    payload: action.payload,
  });

const CLOSED_CODES = {
  denied: 'APPROVAL_DENIED',
  expired: 'APPROVAL_EXPIRED',
  cancelled: 'APPROVAL_NOT_VALID',
} as const;

/**
 * Called, in the same transaction, from every path that closes an approval. An approved intent goes to
 * ready and emits external_action.ready. Anything else cancels it. Does nothing for other approvals.
 */
export async function onApprovalClosedInTx(
  tx: Tx,
  context: TenantContext,
  input: { approvalId: string; outcome: 'approved' | 'denied' | 'expired' | 'cancelled' },
): Promise<void> {
  const [action] = await tx
    .select()
    .from(externalActions)
    .where(eq(externalActions.approvalId, input.approvalId))
    .for('update');
  if (!action) return;

  if (input.outcome === 'approved') {
    if (action.status !== 'awaiting_approval') return;
    const moved = await moveAction(tx, action, 'ready', null);
    await emitActionEvent(tx, context, moved, EXTERNAL_ACTION_READY);
    await auditAction(tx, context, 'external_action.ready', externalActionTargetRef(action.id));
    return;
  }
  // An approval closing after the attempt says nothing about what the attempt did, so that is left alone.
  if (action.status === 'awaiting_approval' || action.status === 'ready') {
    await cancelAction(tx, context, action, CLOSED_CODES[input.outcome]);
  }
}

export type BeginAttemptResult =
  | { kind: 'send'; attempt: PreparedAttempt }
  /** It is past this point, or the recheck stopped it. The status says where it ended up. */
  | { kind: 'stop'; status: 'sent' | 'failed' | 'cancelled' | 'unknown' }
  /** An attempt already exists that could have sent. This call must not contact the provider. */
  | { kind: 'reconcile'; attemptId: string };

/**
 * ADR-027 D2. Locks the intent, runs checkBeforeSend, then writes the attempt and moves to sending, and
 * commits all of that before returning. Whatever happens afterwards, the record exists first.
 *
 * The work and the connection are share-locked for this one transaction, so stopping one or revoking the
 * other either waits and then finds the attempt, or commits first and is seen by the recheck.
 */
export function beginAttempt(
  database: AppDatabase,
  context: TenantContext,
  input: { externalActionId: string; runId: string },
): Promise<BeginAttemptResult> {
  return withTenantTx(database, context, async (tx) => {
    const found = await findAction(tx, input.externalActionId);
    const [work] = await tx
      .select({ status: workUnits.status })
      .from(workUnits)
      .where(eq(workUnits.id, found.workUnitId))
      .for('share');
    const action = await lockAction(tx, found.id);
    const attempts = await attemptsOf(tx, action.id);
    const status = action.status as ExternalActionStatus;

    switch (status) {
      case 'sending':
      case 'reconciling': {
        const claim = attempts.at(-1);
        if (!claim) throw new AppError('INVALID_STATE');
        return { kind: 'reconcile', attemptId: claim.id };
      }
      case 'sent':
      case 'failed':
      case 'cancelled':
      case 'unknown':
        return { kind: 'stop', status };
      // Nothing starts a run before approval. If one ever does, it ends here and changes nothing.
      case 'awaiting_approval':
        return { kind: 'stop', status: 'cancelled' };
      case 'ready':
        break;
    }

    const [approval] = action.approvalId
      ? await tx
          .select({
            status: approvals.status,
            actionHash: approvals.actionHash,
            expiresAt: approvals.expiresAt,
          })
          .from(approvals)
          .where(eq(approvals.id, action.approvalId))
      : [];
    const [connection] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, action.connectionId))
      .for('share');

    const check = checkBeforeSend(
      {
        status,
        requiresApproval: action.requiresApproval,
        requestHash: action.requestHash,
        recomputedHash: recomputeHash(action),
        approval: approval ?? null,
        workStatus: work?.status ?? 'cancelled',
        connectionState: connection?.state ?? 'revoked',
        attemptsSoFar: attempts.length,
      },
      new Date(),
    );
    if (!check.ok) {
      if (check.to === 'failed') {
        await endAsFailed(tx, context, action, check.code, { basis: 'system' });
        return { kind: 'stop', status: 'failed' };
      }
      if (check.to === 'cancelled') {
        const moved = await cancelAction(tx, context, action, check.code);
        // Someone is expecting this to go. Stopping it is not a thing they should find out by looking.
        await tellPeople(tx, context, moved, NOTIFY_EXTERNAL_ACTION_FAILED);
      }
      return { kind: 'stop', status: 'cancelled' };
    }

    const attemptId = randomUUID();
    const attemptNo = attempts.length + 1;
    // The trigger on this insert is the last line (ADR-027 D2): it locks the intent again and refuses this
    // unless the intent is ready and every earlier attempt definitely did not send.
    await tx.insert(externalActionAttempts).values({
      organizationId: context.organizationId,
      id: attemptId,
      externalActionId: action.id,
      attemptNo,
      requestHash: action.requestHash,
      idempotencyKey: action.idempotencyKey,
      runId: input.runId,
    });
    await moveAction(tx, action, 'sending', null);
    return {
      kind: 'send',
      attempt: {
        externalActionId: action.id,
        attemptId,
        attemptNo,
        toolName: action.toolName,
        toolVersion: action.toolVersion,
        idempotencyKey: action.idempotencyKey,
        requestHash: action.requestHash,
        payload: action.payload,
        connection: {
          id: connection?.id ?? action.connectionId,
          connectorType: connection?.connectorType ?? '',
          config: connection?.config ?? {},
          credentialSecretId: connection?.credentialSecretId ?? null,
        },
      },
    };
  });
}

export type AttemptStep = 'sent' | 'failed' | 'cancelled' | 'unknown' | 'retry' | 'reconcile';

const stepFor = (status: string): AttemptStep => {
  switch (status) {
    case 'sent':
    case 'failed':
    case 'cancelled':
    case 'unknown':
      return status;
    case 'ready':
    case 'awaiting_approval':
      return 'retry';
    default:
      return 'reconcile';
  }
};

async function findAttempt(tx: Tx, attemptId: string) {
  const [attempt] = await tx
    .select()
    .from(externalActionAttempts)
    .where(eq(externalActionAttempts.id, attemptId));
  if (!attempt) throw new AppError('NOT_FOUND');
  return attempt;
}

/**
 * Records what the attempt ended with, its receipt, and the move this leads to. Safe to repeat.
 *
 * An answer can arrive after the workflow gave up on it, from an Activity Temporal timed out and that went
 * on anyway (ADR-027 D2). `accepted` and `rejected` are the provider's word, so they are believed whenever
 * they come, and they send nothing. Anything else adds nothing to "we don't know". If a person has already
 * said what they found, that stays what the intent says, and the provider's word is still put on the record
 * beside it, so whoever looks can see the two disagree.
 */
export function finishAttempt(
  database: AppDatabase,
  context: TenantContext,
  input: { attemptId: string; result: AttemptResult },
): Promise<AttemptStep> {
  return withTenantTx(database, context, async (tx) => {
    const { result } = input;
    const found = await findAttempt(tx, input.attemptId);
    const action = await lockAction(tx, found.externalActionId);
    const attempt = await findAttempt(tx, input.attemptId);
    const status = action.status as ExternalActionStatus;

    // Already answered, by this call before or by something that knew more.
    if (attempt.outcome !== null && attempt.outcome !== 'indeterminate') return stepFor(status);

    const isLate = status !== 'sending';
    const providerAnswered = result.outcome === 'accepted' || result.outcome === 'rejected';
    if (isLate && !providerAnswered) return stepFor(status);

    await tx
      .update(externalActionAttempts)
      .set({
        outcome: result.outcome,
        outcomeCode: result.code,
        providerStatus: result.providerStatus ?? null,
        externalId: result.externalId ?? null,
        finishedAt: new Date(),
      })
      .where(eq(externalActionAttempts.id, attempt.id));

    const receipt = {
      attemptId: attempt.id,
      providerStatus: result.providerStatus,
      externalId: result.externalId,
    };
    if (isSettledExternalAction(status)) {
      await addReceipt(tx, context, action, {
        outcome: result.outcome === 'accepted' ? 'sent' : 'failed',
        basis: 'provider',
        code: result.code,
        ...receipt,
      });
      await auditAction(
        tx,
        context,
        'external_action.late_answer',
        externalActionTargetRef(action.id),
        result.code,
      );
      return stepFor(status);
    }

    const decision = decideAfterAttempt(result, attempt.attemptNo);
    switch (decision.status) {
      case 'sent':
        await endAsSent(tx, context, action, result.code, { basis: 'provider', ...receipt });
        return 'sent';
      case 'failed': {
        const notSent = result.outcome === 'not_sent';
        const code = notSent && result.retryable === true ? 'ATTEMPTS_EXHAUSTED' : result.code;
        await endAsFailed(tx, context, action, code, {
          // The provider said no, or Ensemus knows it never got that far.
          basis: notSent ? 'system' : 'provider',
          ...receipt,
        });
        return 'failed';
      }
      case 'ready':
        await moveAction(tx, action, 'ready', result.code);
        return 'retry';
      case 'reconciling':
        await moveAction(tx, action, 'reconciling', result.code);
        return 'reconcile';
    }
  });
}

export type InterruptedState =
  /** No attempt could have sent, so another try is safe. */
  | 'nothing_sent'
  /** An attempt has no outcome. It may have sent, so the only safe step is to reconcile. */
  | 'attempt_open'
  /** It already ended, and the Activity's answer was what got lost. */
  | 'settled';

/** What to do after a send Activity failed or timed out. Reads PostgreSQL and contacts nobody. */
export function inspectInterrupted(
  database: AppDatabase,
  context: TenantContext,
  input: { externalActionId: string },
): Promise<InterruptedState> {
  return withTenantTx(database, context, async (tx) => {
    const action = await findAction(tx, input.externalActionId);
    switch (action.status as ExternalActionStatus) {
      case 'sending':
      case 'reconciling':
        return 'attempt_open';
      case 'ready':
        return 'nothing_sent';
      default:
        return 'settled';
    }
  });
}

/** Where a settled intent ended, for a workflow that lost the answer. Before approval, this run is over. */
export function readSettledOutcome(
  database: AppDatabase,
  context: TenantContext,
  input: { externalActionId: string },
): Promise<'sent' | 'failed' | 'cancelled' | 'unknown'> {
  return withTenantTx(database, context, async (tx) => {
    const { status } = await findAction(tx, input.externalActionId);
    return status === 'sent' || status === 'failed' || status === 'unknown' ? status : 'cancelled';
  });
}

export type ReconcilePreparation =
  | { kind: 'reconcile'; attempt: PreparedAttempt }
  | { kind: 'settled'; status: 'sent' | 'failed' | 'cancelled' | 'unknown' }
  /** A late answer already said nothing went, so there is nothing to ask about. */
  | { kind: 'nothing_open' };

/** Moves to reconciling and marks an open attempt indeterminate before asking the provider. */
export function beginReconcile(
  database: AppDatabase,
  context: TenantContext,
  input: { externalActionId: string; code: 'WORKER_INTERRUPTED' | 'TIMEOUT_AFTER_COMMIT' },
): Promise<ReconcilePreparation> {
  return withTenantTx(database, context, async (tx) => {
    const action = await lockAction(tx, input.externalActionId);
    const status = action.status as ExternalActionStatus;
    if (
      status === 'sent' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'unknown'
    ) {
      return { kind: 'settled', status };
    }
    if (status !== 'sending' && status !== 'reconciling') return { kind: 'nothing_open' };

    const attempt = (await attemptsOf(tx, action.id)).at(-1);
    if (!attempt) throw new AppError('INVALID_STATE');
    if (attempt.outcome === null) {
      await tx
        .update(externalActionAttempts)
        .set({ outcome: 'indeterminate', outcomeCode: input.code, finishedAt: new Date() })
        .where(eq(externalActionAttempts.id, attempt.id));
    }
    if (status === 'sending') await moveAction(tx, action, 'reconciling', input.code);

    const [connection] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, action.connectionId));
    return {
      kind: 'reconcile',
      attempt: {
        externalActionId: action.id,
        attemptId: attempt.id,
        attemptNo: attempt.attemptNo,
        toolName: action.toolName,
        toolVersion: action.toolVersion,
        idempotencyKey: action.idempotencyKey,
        requestHash: action.requestHash,
        payload: action.payload,
        connection: {
          id: action.connectionId,
          connectorType: connection?.connectorType ?? '',
          config: connection?.config ?? {},
          credentialSecretId: connection?.credentialSecretId ?? null,
        },
      },
    };
  });
}

export type ReconcileStep = 'sent' | 'failed' | 'retry' | 'unknown';

/**
 * Records the provider's answer. `cannot_answer` goes to unknown, tells the accountable owner and the
 * requester, and stops. Nothing in this file resends from there.
 */
export function finishReconcile(
  database: AppDatabase,
  context: TenantContext,
  input: {
    attemptId: string;
    result: ReconcileResult;
    lookup: 'none' | 'best_effort' | 'authoritative';
  },
): Promise<ReconcileStep> {
  return withTenantTx(database, context, async (tx) => {
    const found = await findAttempt(tx, input.attemptId);
    const action = await lockAction(tx, found.externalActionId);
    const attempt = await findAttempt(tx, input.attemptId);
    if (action.status !== 'reconciling') {
      const step = stepFor(action.status);
      if (step === 'reconcile') throw new AppError('INVALID_STATE');
      return step === 'cancelled' ? 'failed' : step;
    }

    const decision = decideAfterReconcile(input.result, input.lookup);
    const externalId =
      input.result.answer === 'found' ? input.result.externalId : (attempt.externalId ?? undefined);
    const providerStatus =
      input.result.answer === 'found' || input.result.answer === 'refused'
        ? input.result.providerStatus
        : undefined;
    // What the connector already said about an indeterminate attempt stays: it is the only thing known.
    if (decision.attemptOutcome !== 'indeterminate') {
      await tx
        .update(externalActionAttempts)
        .set({
          outcome: decision.attemptOutcome,
          outcomeCode: decision.code,
          providerStatus: providerStatus ?? null,
          externalId: externalId ?? null,
          finishedAt: new Date(),
        })
        .where(eq(externalActionAttempts.id, attempt.id));
    }

    const receipt = { attemptId: attempt.id, providerStatus, externalId };
    switch (decision.status) {
      case 'sent':
        await endAsSent(tx, context, action, decision.code, {
          basis: 'reconciliation',
          ...receipt,
        });
        return 'sent';
      case 'failed':
        await endAsFailed(tx, context, action, decision.code, {
          basis: 'reconciliation',
          ...receipt,
        });
        return 'failed';
      case 'ready':
        await moveAction(tx, action, 'ready', decision.code);
        return 'retry';
      case 'unknown': {
        const moved = await moveAction(tx, action, 'unknown', decision.code);
        await addReceipt(tx, context, moved, {
          outcome: 'unknown',
          basis: 'reconciliation',
          code: decision.code,
          ...receipt,
        });
        await emitActionEvent(tx, context, moved, EXTERNAL_ACTION_UNKNOWN, decision.code);
        await auditAction(
          tx,
          context,
          'external_action.unknown',
          externalActionTargetRef(action.id),
          decision.code,
        );
        await tellPeople(tx, context, moved, NOTIFY_EXTERNAL_ACTION_UNKNOWN);
        return 'unknown';
      }
    }
  });
}

/**
 * Ends an intent that has used all its tries, or whose connector never picked it up. Only from ready: a
 * repeat finds it already over, and an attempt that may have sent is not something this can speak for.
 */
export function failUnsent(
  database: AppDatabase,
  context: TenantContext,
  input: { externalActionId: string; code: 'ATTEMPTS_EXHAUSTED' | 'CONNECTOR_UNAVAILABLE' },
): Promise<void> {
  return withTenantTx(database, context, async (tx) => {
    const action = await lockAction(tx, input.externalActionId);
    if (action.status !== 'ready') return;
    await endAsFailed(tx, context, action, input.code, { basis: 'system' });
  });
}

/** Sent actions with a receipt that says so, from the provider, reconciliation or a person. */
const verifiedOn = (workUnitIds: readonly string[]) =>
  and(
    inArray(externalActions.workUnitId, [...workUnitIds]),
    eq(externalActions.status, 'sent'),
    sql`exists (
      select 1 from ${externalActionReceipts}
       where ${externalActionReceipts.organizationId} = ${externalActions.organizationId}
         and ${externalActionReceipts.externalActionId} = ${externalActions.id}
         and ${externalActionReceipts.outcome} = 'sent'
         and ${externalActionReceipts.basis} in ('provider', 'reconciliation', 'person')
    )`,
  );

/**
 * The `external_receipt` evidence for a Work Unit: sent actions with a receipt from the provider, from
 * reconciliation, or from a person who was shown it was unknown (ADR-027 D6). work.ts counts these.
 */
export async function countVerifiedReceipts(tx: Tx, workUnitId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(externalActions)
    .where(verifiedOn([workUnitId]));
  return row?.n ?? 0;
}

/** The same count for a page of Work Units, in one query. */
export async function countVerifiedReceiptsByWork(
  tx: Tx,
  workUnitIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (workUnitIds.length === 0) return new Map();
  const rows = await tx
    .select({ workUnitId: externalActions.workUnitId, n: sql<number>`count(*)::int` })
    .from(externalActions)
    .where(verifiedOn(workUnitIds))
    .groupBy(externalActions.workUnitId);
  return new Map(rows.map((row) => [row.workUnitId, row.n]));
}

/** Whether this tenant has an active connection that could ever produce a receipt (ADR-027 D6). */
export async function hasActionConnection(tx: Tx): Promise<boolean> {
  const rows = await tx
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.state, 'active'),
        inArray(connections.connectorType, [...ACTION_CONNECTOR_TYPES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
