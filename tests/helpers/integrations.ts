// Test seeds for ADR-027 tables, shared by every M3 slice. They walk an intent to a status through the
// real transitions and triggers, as the application role, so a seed can never reach a state the rules
// forbid. Generated test values only: no real address, credential or provider.
import { randomUUID } from 'node:crypto';
import {
  approvals,
  connections,
  externalActionAttempts,
  externalActions,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { actionHash } from '@ensemus/domain/approval';
import {
  EMAIL_SEND_TOOL,
  EMAIL_SEND_VERSION,
  idempotencyKeyFor,
  proposedActionFor,
  type AttemptOutcome,
  type ExternalActionStatus,
} from '@ensemus/domain/external-action';
import { eq } from 'drizzle-orm';

export function testEmailPayload(overrides: Record<string, unknown> = {}) {
  return {
    from: { address: 'sender@example.invalid' },
    to: ['recipient@example.invalid'],
    subject: 'A test message',
    text_body: 'Nothing here is real.',
    ...overrides,
  };
}

export async function seedConnection(
  database: AppDatabase,
  context: TenantContext,
  overrides: Partial<typeof connections.$inferInsert> = {},
) {
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(connections).values({
      organizationId: context.organizationId,
      id,
      connectorType: 'email_smtp',
      displayName: 'Test mail',
      ...overrides,
    }),
  );
  return id;
}

export type SeededAction = {
  id: string;
  approvalId: string;
  requestHash: string;
  attemptId?: string;
};

/**
 * Makes an intent with its approval and walks it to `status`, through the same moves the code makes. The
 * approval is decided here directly: this is a seed for testing what comes after it, and the tests that
 * cover deciding one go through decideApproval.
 */
export async function seedExternalAction(
  database: AppDatabase,
  context: TenantContext,
  input: {
    workUnitId: string;
    connectionId: string;
    approverMembershipId: string;
    status: ExternalActionStatus;
    payload?: unknown;
  },
): Promise<SeededAction> {
  const id = randomUUID();
  const approvalId = randomUUID();
  const payload = input.payload ?? testEmailPayload();
  const action = proposedActionFor({
    toolName: EMAIL_SEND_TOOL,
    toolVersion: EMAIL_SEND_VERSION,
    connectionId: input.connectionId,
    payload,
  });
  const requestHash = actionHash(action);
  const organizationId = context.organizationId;
  const attemptId = randomUUID();

  await withTenantTx(database, context, async (tx) => {
    await tx.insert(approvals).values({
      organizationId,
      id: approvalId,
      workUnitId: input.workUnitId,
      toolName: action.toolName,
      action,
      actionHash: requestHash,
      targetRef: action.targetRef,
      approverMembershipId: input.approverMembershipId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await tx.insert(externalActions).values({
      organizationId,
      id,
      workUnitId: input.workUnitId,
      connectionId: input.connectionId,
      toolName: action.toolName,
      toolVersion: action.toolVersion,
      targetRef: action.targetRef as string,
      payload,
      requestHash,
      idempotencyKey: idempotencyKeyFor(id),
      classification: 'internal',
      requiresApproval: true,
      approvalId,
      status: 'awaiting_approval',
    });

    const move = (status: ExternalActionStatus, extra: object = {}) =>
      tx
        .update(externalActions)
        .set({ status, ...extra })
        .where(eq(externalActions.id, id));
    const finishAttempt = (outcome: AttemptOutcome) =>
      tx
        .update(externalActionAttempts)
        .set({ outcome })
        .where(eq(externalActionAttempts.id, attemptId));

    if (input.status === 'awaiting_approval') return;
    if (input.status === 'cancelled') {
      await move('cancelled', { statusReason: 'SUPERSEDED' });
      return;
    }
    await tx
      .update(approvals)
      .set({ status: 'approved', decidedAt: new Date() })
      .where(eq(approvals.id, approvalId));
    await move('ready');
    if (input.status === 'ready') return;

    await tx.insert(externalActionAttempts).values({
      organizationId,
      id: attemptId,
      externalActionId: id,
      attemptNo: 1,
      requestHash,
      idempotencyKey: idempotencyKeyFor(id),
      runId: 'test-run',
    });
    await move('sending');
    switch (input.status) {
      case 'sending':
        return;
      case 'sent':
        await finishAttempt('accepted');
        await move('sent');
        return;
      case 'failed':
        await finishAttempt('rejected');
        await move('failed');
        return;
      case 'reconciling':
      case 'unknown':
        await finishAttempt('indeterminate');
        await move('reconciling');
        if (input.status === 'unknown') await move('unknown');
        return;
    }
  });
  return {
    id,
    approvalId,
    requestHash,
    ...(input.status === 'ready' || input.status === 'awaiting_approval' ? {} : { attemptId }),
  };
}
