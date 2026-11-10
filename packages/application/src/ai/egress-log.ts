// `governance.egress_decisions` (SEC-01). The agent role writes it, append-only, and it cannot be backfilled, so
// a failure here stops the call rather than letting something leave unrecorded. People read it filtered, and
// M5's AGENT-10 builds the machine-readable ledger on this table.
import {
  egressDecisions,
  policyBundles,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import type { TenantPolicyBundle } from '@ensemus/policy';
import { and, asc, eq } from 'drizzle-orm';
import { AppError } from '../errors';
import { assertRunInputsOpen } from './input-observations';
import type { EgressLog } from './ports';

/** Pass the agent role's connection. `ensemus_app` has no INSERT here, so web cannot forge a decision. */
export function createEgressLog(database: AppDatabase): EgressLog {
  return {
    async record(context, entry) {
      // The tenant comes from the context and never from the entry. Nor may one run write for another.
      if (entry.runId !== null && entry.runId !== context.agentRunId) {
        throw new AppError('FORBIDDEN');
      }
      await withTenantTx(database, context, async (tx) => {
        // 0417's authority_egress_write admits an `allow` row for an authority-v1 run only under
        // this transaction's own read-scope and authority-v1 admission. Admit it here, as beginTurn
        // and the tool store do; a fenced or refused run throws and nothing leaves (see above). A
        // `deny` needs no admission and is still recorded for a closed run.
        if (entry.runId !== null && entry.decision === 'allow') {
          await assertRunInputsOpen(tx, context);
        }
        await tx.insert(egressDecisions).values({
          organizationId: context.organizationId,
          runId: entry.runId,
          stepId: entry.stepId,
          profileId: entry.profileId,
          dataClass: entry.dataClass,
          purpose: entry.purpose,
          destinationHost: entry.destinationHost,
          decision: entry.decision,
          reasonCode: entry.reasonCode,
          policyVersion: entry.policyVersion,
          requestHash: entry.requestHash,
          expiresAt: entry.expiresAt,
        });
      });
    },
  };
}

export type EgressDecisionView = {
  id: string;
  runId: string | null;
  profileId: string | null;
  dataClass: string;
  purpose: string;
  decision: 'allow' | 'deny';
  reasonCode: string;
  policyVersion: string;
  createdAt: Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Needs `usage.view`. RLS confines it to this tenant, so another tenant's run reads as no decisions. */
export async function listEgressDecisions(
  database: AppDatabase,
  context: TenantContext,
  input: { runId: string },
): Promise<readonly EgressDecisionView[]> {
  if (!can(context.role, 'usage.view')) throw new AppError('FORBIDDEN');
  // Not a run ID at all, so there is nothing to find. PostgreSQL would call this an error instead.
  if (!UUID.test(input.runId)) return [];
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: egressDecisions.id,
        runId: egressDecisions.runId,
        profileId: egressDecisions.profileId,
        dataClass: egressDecisions.dataClass,
        purpose: egressDecisions.purpose,
        decision: egressDecisions.decision,
        reasonCode: egressDecisions.reasonCode,
        policyVersion: egressDecisions.policyVersion,
        createdAt: egressDecisions.createdAt,
      })
      .from(egressDecisions)
      .where(
        and(
          eq(egressDecisions.organizationId, context.organizationId),
          eq(egressDecisions.runId, input.runId),
        ),
      )
      .orderBy(asc(egressDecisions.createdAt), asc(egressDecisions.id)),
  );
  // The table's check constraint holds `decision` to these two words.
  return rows.map((row) => ({ ...row, decision: row.decision as 'allow' | 'deny' }));
}

/**
 * The tenant's active tightening, for `decideEgress`. A bundle's other fields, such as agent limits, are not
 * this function's concern and do not pass through: only the two that decide egress, as stored, because
 * `decideEgress` denies a malformed one rather than this quietly dropping it. Null when none is active.
 */
export async function loadTenantPolicyBundle(
  database: AppDatabase,
  context: TenantContext,
): Promise<TenantPolicyBundle | null> {
  return withTenantTx(database, context, (tx) => loadTenantPolicyBundleInTx(tx, context));
}
/** Same decision data in the actual reservation/dispatch transaction. */
export async function loadTenantPolicyBundleInTx(
  tx: Tx,
  context: TenantContext,
): Promise<TenantPolicyBundle | null> {
  const [row] = await tx
    .select({ version: policyBundles.version, document: policyBundles.document })
    .from(policyBundles)
    .where(
      and(eq(policyBundles.organizationId, context.organizationId), eq(policyBundles.active, true)),
    )
    .limit(1);
  if (!row) return null;
  const document = (row.document ?? {}) as Record<string, unknown>;
  return {
    version: String(row.version),
    ...(document.denyClasses !== undefined
      ? { denyClasses: document.denyClasses as NonNullable<TenantPolicyBundle['denyClasses']> }
      : {}),
    ...(document.allowedRegions !== undefined
      ? { allowedRegions: document.allowedRegions as readonly string[] }
      : {}),
  };
}
