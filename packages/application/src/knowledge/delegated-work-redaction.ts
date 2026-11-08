// Fixed native-agent/service privacy effect. No Work body, fabricated AgentContext, caller-supplied
// hold result or generic binding map is exposed. SQL rechecks 0510 in this same transaction.
import type { TenantContext, Tx } from '@ensemus/database';
import { WORK_STATES } from '@ensemus/domain/work-unit';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { recordDelegatedWorkRedactionInTx, type WorkTransitionMetadata } from '../work';

export const DELEGATED_REDACTION_SCOPE_KINDS = ['knowledge_source', 'work_unit', 'project', 'client', 'object_record'] as const;
const inputSchema = z.strictObject({
  childRunId: idSchema, workUnitId: idSchema, scopeKind: z.enum(DELEGATED_REDACTION_SCOPE_KINDS),
  scopeId: idSchema, purgeJobId: idSchema.nullable(),
}).superRefine((value, ctx) => {
  if ((value.scopeKind === 'knowledge_source') !== (value.purgeJobId !== null))
    ctx.addIssue({ code: 'custom', message: 'Purge authority does not match the scope.' });
});
export type DelegatedWorkRedactionInput = z.infer<typeof inputSchema>;
const wire = z.strictObject({
  id: idSchema, status: z.enum(WORK_STATES),
  version: z.preprocess((value) => typeof value === 'string' ? Number(value) : value,
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
  classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  ownerMembershipId: idSchema, runId: z.null(), runRequestedAt: z.coerce.date().nullable(),
  runRequestedByMembershipId: idSchema.nullable(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/), dispositionSha256: z.string().regex(/^[0-9a-f]{64}$/),
  changed: z.boolean(),
});
const genuine = new WeakMap<object, { tx: Tx; context: TenantContext }>();
export type DelegatedWorkDisposition = Readonly<{
  current: WorkTransitionMetadata;
  contentSha256: string;
}>;
/** Validates and consumes, never constructs, the capability. The metadata cannot be replayed into
 * another transaction, another context or a second event/audit write. */
export function consumeDelegatedWorkDisposition(value: DelegatedWorkDisposition, tx: Tx, context: TenantContext) {
  const issued = genuine.get(value);
  if (!issued || issued.tx !== tx || issued.context !== context) return false;
  genuine.delete(value);
  return true;
}

export async function redactDelegatedWorkInTx(tx: Tx, context: TenantContext, raw: DelegatedWorkRedactionInput): Promise<
  { confirmed: false } | { confirmed: true; changed: boolean; version: number; dispositionSha256: string }
> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const input = parsed.data;
  const result = await tx.execute(sql`select id,status,version,classification,"ownerMembershipId","runId","runRequestedAt",
    "runRequestedByMembershipId","contentSha256","dispositionSha256",changed from work.redact_delegated_body(
      ${input.childRunId}::uuid,${input.workUnitId}::uuid,${input.scopeKind},${input.scopeId}::uuid,${input.purgeJobId}::uuid)`);
  if (result.rows.length === 0) return { confirmed: false };
  const fact = wire.safeParse(result.rows[0]);
  if (result.rows.length !== 1 || !fact.success || fact.data.id !== input.workUnitId) throw new AppError('INVALID_STATE');
  if (fact.data.changed) {
    const row = fact.data;
    const disposition: DelegatedWorkDisposition = Object.freeze({
      current: Object.freeze({ id: row.id, status: row.status, version: row.version, classification: row.classification,
        ownerMembershipId: row.ownerMembershipId, runId: row.runId, runRequestedAt: row.runRequestedAt,
        runRequestedByMembershipId: row.runRequestedByMembershipId }),
      contentSha256: row.contentSha256,
    });
    genuine.set(disposition, { tx, context });
    await recordDelegatedWorkRedactionInTx(tx, context, disposition);
  }
  return { confirmed: true, changed: fact.data.changed, version: fact.data.version, dispositionSha256: fact.data.dispositionSha256 };
}
