// A private SQL projection supplies licensing/standing facts without granting financial bodies.
import type { TenantContext, Tx } from '@ensemus/database';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../errors';
import { idSchema } from '../ids';

const metadata = z
  .strictObject({
    planVersionId: idSchema.nullable(),
    subscriptionStatus: z.enum(['active', 'past_due', 'canceled']).nullable(),
    balanceMicrocredits: z
      .union([z.bigint(), z.string().regex(/^-?[0-9]{1,19}$/)])
      .transform(BigInt),
    standingReasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .nullable(),
    standingChangedAt: z.coerce.date().nullable(),
  })
  .refine((value) => (value.planVersionId === null) === (value.subscriptionStatus === null));

export async function loadEntitlementMetadataInTx(tx: Tx, context: TenantContext) {
  const result = await tx.execute(
    sql`select "planVersionId","subscriptionStatus","balanceMicrocredits","standingReasonCode","standingChangedAt" from billing.current_entitlement_metadata() where app.current_organization_id()=${context.organizationId}::uuid`,
  );
  const parsed = metadata.safeParse(result.rows[0]);
  if (result.rows.length !== 1 || !parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
}
