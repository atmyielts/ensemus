// An approval binds to one exact action (docs/04-security/04-authorization-and-approvals.md).
import { createHash } from 'node:crypto';

export type ProposedAction = {
  toolName: string;
  toolVersion: string;
  targetRef: string | null;
  payload: unknown;
};

/** JSON with sorted keys at every level, so equal actions always produce the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) throw new TypeError('Actions may not contain undefined');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(',')}}`;
}

export function actionHash(action: ProposedAction): string {
  return createHash('sha256').update(canonicalJson(action)).digest('hex');
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export type ApprovalDenial =
  'NOT_PENDING' | 'EXPIRED' | 'WRONG_APPROVER' | 'HASH_MISMATCH' | 'SELF_APPROVAL';

export type ApprovalFacts = {
  status: ApprovalStatus;
  expiresAt: Date;
  approverMembershipId: string;
  requestedByMembershipId: string | null;
  boundHash: string;
};

/** Checks a person's decision against exactly what they were shown. */
export function checkDecision(
  approval: ApprovalFacts,
  decision: { actorMembershipId: string; shownHash: string; now: Date },
): { ok: true } | { ok: false; reason: ApprovalDenial } {
  if (approval.status !== 'pending') return { ok: false, reason: 'NOT_PENDING' };
  if (decision.now >= approval.expiresAt) return { ok: false, reason: 'EXPIRED' };
  if (decision.actorMembershipId !== approval.approverMembershipId) {
    return { ok: false, reason: 'WRONG_APPROVER' };
  }
  if (decision.actorMembershipId === approval.requestedByMembershipId) {
    return { ok: false, reason: 'SELF_APPROVAL' };
  }
  if (decision.shownHash !== approval.boundHash) return { ok: false, reason: 'HASH_MISMATCH' };
  return { ok: true };
}

/** Re-checked just before an approved action runs. Editing the action voids the approval. */
export function checkExecution(
  approval: Pick<ApprovalFacts, 'status' | 'expiresAt' | 'boundHash'>,
  execution: { action: ProposedAction; now: Date },
): { ok: true } | { ok: false; reason: 'NOT_APPROVED' | 'EXPIRED' | 'HASH_MISMATCH' } {
  if (approval.status !== 'approved') return { ok: false, reason: 'NOT_APPROVED' };
  if (execution.now >= approval.expiresAt) return { ok: false, reason: 'EXPIRED' };
  if (actionHash(execution.action) !== approval.boundHash) {
    return { ok: false, reason: 'HASH_MISMATCH' };
  }
  return { ok: true };
}
