import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
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

/** Where a refusal happened. Our own words, so nothing a caller sent can reach the row. */
export type RefusalSurface = 'web' | 'api';

export type RefusalEntry = {
  organizationId: string;
  /** The membership, or the account when the person has no membership in this tenant. */
  actorId: string;
  surface: RefusalSurface;
  /** An error code from our own list, never text from the request. */
  code: string;
  now?: Date;
};

/** A tenant under attack from many accounts still gets no more rows than this in an hour. */
export const MAX_REFUSALS_PER_HOUR = 1000;

/**
 * Records that a request was refused, in as few words as that can be said: who, where and which code.
 * It runs after the refused work has rolled back, and it holds nothing from the request, because a
 * refused request is the one most likely to be carrying something it should not.
 *
 * One person repeating one refusal makes one row an hour, so a flood costs a failed insert each time
 * and never fills the table, and it cannot be used to bury what came before. Returns whether a row was
 * written. The append-only rule still holds: repeats add nothing, and nothing is ever updated.
 */
export async function appendRefusal(tx: Tx, entry: RefusalEntry): Promise<boolean> {
  const now = entry.now ?? new Date();
  const hour = now.toISOString().slice(0, 13);
  const dedupeKey = `${entry.actorId}:${entry.surface}:${entry.code}:${hour}`;
  // The cheap check first, because in a flood this is nearly every request.
  const [already] = await tx
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, entry.organizationId),
        eq(auditEvents.dedupeKey, dedupeKey),
      ),
    );
  if (already) return false;
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, entry.organizationId),
        isNotNull(auditEvents.dedupeKey),
        gt(auditEvents.occurredAt, new Date(now.getTime() - 60 * 60 * 1000)),
      ),
    );
  if (n >= MAX_REFUSALS_PER_HOUR) return false;
  const written = await tx
    .insert(auditEvents)
    .values({
      organizationId: entry.organizationId,
      actorType: 'user',
      actorId: entry.actorId,
      action: `access.refused.${entry.surface}`,
      targetRef: `organization:${entry.organizationId}`,
      decision: 'deny',
      safeReason: entry.code,
      dedupeKey,
      occurredAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: auditEvents.id });
  return written.length > 0;
}
