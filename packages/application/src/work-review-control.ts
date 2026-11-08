// Exact M2 review control metadata. No generated-byte read, service constructor or caller context
// is returned. Human/agent review actions keep their ordinary current-row access path.
import { memberships, type Tx } from '@ensemus/database';
import { and, eq, sql } from 'drizzle-orm';
import { AppError, pgCode } from './errors';
import type { WorkRow } from './work';

export async function heldReviewArtifactIdsInTx(
  tx: Tx,
  work: Pick<
    WorkRow,
    'id' | 'version' | 'status' | 'runId' | 'runRequestedByMembershipId' | 'executionPlan'
  >,
): Promise<readonly string[] | null> {
  const actor = await tx.execute<{ service: boolean }>(
    sql`select app.current_actor_type()='service' service`,
  );
  if (
    actor.rows[0]?.service !== true ||
    work.executionPlan !== 'checklist' ||
    !['running', 'awaiting_approval', 'verifying'].includes(work.status)
  )
    return null;
  const requester = work.runRequestedByMembershipId;
  if (!requester) throw new AppError('POLICY_DENIED');
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.id, requester), eq(memberships.status, 'active')))
    .for('share', { noWait: true });
  if (!member) throw new AppError('POLICY_DENIED');
  try {
    const candidates = await tx.execute<{
      id: string;
    }>(sql`select id from work.held_review_artifact_ids(
      ${work.id}::uuid,${work.version}::bigint,${work.runId},${requester}::uuid) order by id`);
    if (candidates.rows.length > 1000) throw new AppError('POLICY_DENIED');
    if (!candidates.rows.length) return [];
    const visible = await tx.execute<{ id: string }>(
      sql`select candidate.id from(values ${sql.join(
        candidates.rows.map((candidate) => sql`(${candidate.id}::uuid)`),
        sql`,`,
      )}) candidate(id) where knowledge.artifact_readable(candidate.id,${requester}::uuid) order by candidate.id`,
    );
    return visible.rows.map((row) => row.id);
  } catch (error) {
    if (pgCode(error) === '42501' || pgCode(error) === '55P03' || pgCode(error) === '40001')
      throw new AppError('POLICY_DENIED');
    throw error;
  }
}
