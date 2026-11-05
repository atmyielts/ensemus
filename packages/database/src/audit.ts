import { auditEvents } from './schema';
import type { Tx } from './tenant';

export type AuditEntry = {
  organizationId: string;
  actorType: 'user' | 'service' | 'agent' | 'system';
  actorId?: string;
  /** A dotted action name such as organization.created. */
  action: string;
  /** An opaque reference such as secret:<uuid>, never a name or a document's content. */
  targetRef: string;
  decision: 'allow' | 'deny';
  safeReason?: string;
  correlationId?: string;
};

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const TARGET = /^[a-z_]+:[0-9a-zA-Z-]{1,64}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Appends to the audit log inside the caller's transaction. The formats are strict so free text,
 * and with it confidential content, cannot reach the log by accident (ADR-013).
 */
export async function appendAudit(tx: Tx, entry: AuditEntry) {
  if (!ACTION.test(entry.action)) throw new Error('Invalid audit action format');
  if (!TARGET.test(entry.targetRef)) throw new Error('Invalid audit target format');
  if (entry.safeReason && !REASON.test(entry.safeReason)) {
    throw new Error('Audit reasons must be codes, not free text');
  }
  await tx.insert(auditEvents).values(entry);
}
