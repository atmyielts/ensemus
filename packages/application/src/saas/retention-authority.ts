// A transaction-local proof, never a request flag. Only the retention source can mint it, and the
// deletion path checks the current rule and artifact again while holding its normal work lock.
import {
  artifacts,
  retentionCursors,
  retentionRules,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { retentionCutoff } from '@ensemus/saas/lifecycle';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { isHeldInTx } from './legal-holds';

const brand: unique symbol = Symbol('artifact-retention-authority');
export type ArtifactRetentionAuthority = { readonly [brand]: true };
const proofs = new WeakMap<
  ArtifactRetentionAuthority,
  { tx: Tx; organizationId: string; artifactId: string; ruleId: string; cutoff: Date }
>();

export function artifactRetentionAuthorityInTx(
  tx: Tx,
  context: TenantContext,
  input: { artifactId: string; ruleId: string; cutoff: Date },
): ArtifactRetentionAuthority {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
  if (
    !idSchema.safeParse(input.artifactId).success ||
    !idSchema.safeParse(input.ruleId).success ||
    !Number.isFinite(input.cutoff.getTime())
  )
    throw new AppError('INVALID_INPUT');
  const proof: ArtifactRetentionAuthority = Object.freeze({ [brand]: true as const });
  proofs.set(proof, {
    tx,
    organizationId: context.organizationId,
    artifactId: input.artifactId,
    ruleId: input.ruleId,
    cutoff: new Date(input.cutoff),
  });
  return proof;
}

/** A terminal work state is bypassed only for the exact expired artifact and the exact current rule. */
export async function assertArtifactRetentionInTx(
  tx: Tx,
  context: TenantContext,
  artifactId: string,
  authority: ArtifactRetentionAuthority,
): Promise<void> {
  const proof = proofs.get(authority);
  if (
    context.actorType !== 'service' ||
    !proof ||
    proof.tx !== tx ||
    proof.organizationId !== context.organizationId ||
    proof.artifactId !== artifactId
  )
    throw new AppError('NOT_FOUND');
  const [artifact] = await tx
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.organizationId, context.organizationId), eq(artifacts.id, artifactId)))
    .for('update');
  if (!artifact) throw new AppError('NOT_FOUND');
  const rules = await tx
    .select()
    .from(retentionRules)
    .where(
      and(
        eq(retentionRules.organizationId, context.organizationId),
        eq(retentionRules.dataCategory, 'raw_files'),
        isNull(retentionRules.supersededAt),
      ),
    );
  const rule =
    rules.find((row) => row.classification === artifact.classification) ??
    rules.find((row) => row.classification === '*');
  const [position] = await tx
    .select()
    .from(retentionCursors)
    .where(
      and(
        eq(retentionCursors.organizationId, context.organizationId),
        eq(retentionCursors.dataCategory, 'raw_files'),
        eq(retentionCursors.classification, artifact.classification),
        eq(retentionCursors.ruleId, proof.ruleId),
      ),
    )
    .for('update');
  const clock = await tx.execute(sql`select now()::text as at`);
  const wire = clock.rows[0]?.at;
  if (typeof wire !== 'string') throw new AppError('PREREQUISITES_INCOMPLETE');
  const latest = retentionCutoff(rules, 'raw_files', artifact.classification, new Date(wire));
  if (
    !rule ||
    rule.id !== proof.ruleId ||
    !rule.basisRef.trim() ||
    rule.retainDays === null ||
    !position ||
    position.completed ||
    position.cutoffAt.getTime() !== proof.cutoff.getTime() ||
    !latest ||
    proof.cutoff > latest ||
    artifact.createdAt >= proof.cutoff
  )
    throw new AppError('INVALID_STATE');
  if (await isHeldInTx(tx, context, { type: 'artifact', id: artifactId }))
    throw new AppError('LEGAL_HOLD_ACTIVE');
}
