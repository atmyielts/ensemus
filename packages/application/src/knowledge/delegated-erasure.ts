// Fixed native app-service operation. SQL owns the actual admission, current holds/restore
// generations and exhaustive material proof. No UUID, caller boolean or GUC is proof by itself.
import type { TenantContext, Tx } from '@ensemus/database';
import { sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';

export async function sealDelegatedErasureInTx(
  tx: Tx,
  context: TenantContext,
  input: { offboardingId: string },
): Promise<boolean> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const parsed = idSchema.safeParse(input.offboardingId);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const offboardingId = parsed.data;
  const capability = await tx.execute<{ available: boolean }>(
    sql`select to_regprocedure('lifecycle.seal_delegated_erasure(uuid)') is not null available`,
  );
  if (capability.rows[0]?.available !== true) return false;
  const result = await tx.execute<{ sealed: boolean }>(
    sql`select case when app.current_organization_id()=${context.organizationId}::uuid
      then lifecycle.seal_delegated_erasure(${offboardingId}::uuid) else false end sealed`,
  );
  return result.rows[0]?.sealed === true;
}
