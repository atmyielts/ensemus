// No provider I/O here. The broker's native proof token is consumed under fresh, exact SQL authority.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import type { PaymentConnectionAuthority, PaymentGatewayBinding, PaymentTransportAdmission } from '@ensemus/saas/payment';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../errors';
import { idSchema } from '../ids';

const sha = z.string().regex(/^[0-9a-f]{64}$/);
export const paymentAuthoritySchema = z.strictObject({
  restoreGeneration: idSchema,
  billingOrganizationId: idSchema,
  connectionId: idSchema,
  connectionVersion: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
  credentialSecretId: idSchema,
  processor: z.string().regex(/^[a-z][a-z0-9_]{1,55}$/),
  adapterVersion: z
    .string()
    .max(64)
    .regex(/^\d+\.\d+\.\d+$/),
  apiOrigin: z.string().max(2048).url(),
  configSha256: sha,
  authoritySha256: sha,
});
const bindingSchema = z.strictObject({
  id: idSchema,
  authoritySha256: sha,
  identitySha256: sha,
  accountNamespaceSha256: sha,
  bindingSha256: sha,
  customerState: z.enum(['new', 'sending', 'confirmed', 'unknown']),
  customerRefHash: sha.nullable(),
});
export type PaymentExecutionBinding = z.infer<typeof bindingSchema>;
const service = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
};
const identifier = (value: string) => {
  const result = idSchema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
};
const one = <T>(rows: unknown[], schema: z.ZodType<T>): T => {
  const parsed = schema.safeParse(rows[0]);
  if (rows.length !== 1 || !parsed.success) throw new AppError('PREREQUISITES_INCOMPLETE');
  return parsed.data;
};

export async function preflightPaymentExecution(
  database: AppDatabase,
  context: TenantContext,
  input: {
    paymentId: string;
    billingOrganizationId: string;
    connectionId: string;
    processor: string;
    adapterVersion: string;
    apiOrigin: string;
  },
): Promise<PaymentConnectionAuthority> {
  service(context);
  const paymentId = identifier(input.paymentId),
    billingOrg = identifier(input.billingOrganizationId),
    connectionId = identifier(input.connectionId);
  return withAccountTx(database, context, async (tx) => {
    const result = await tx.execute(
      sql`select * from billing.payment_execution_preflight(${paymentId}::uuid,${billingOrg}::uuid,${connectionId}::uuid,${input.processor},${input.adapterVersion},${input.apiOrigin})`,
    );
    return one(result.rows, paymentAuthoritySchema);
  });
}

export async function bindPaymentExecution(
  database: AppDatabase,
  context: TenantContext,
  input: {
    paymentId: string;
    token: string;
  },
): Promise<PaymentExecutionBinding> {
  service(context);
  const paymentId = identifier(input.paymentId);
  if (!sha.safeParse(input.token).success) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const result = await tx.execute(
      sql`select * from billing.bind_payment_execution(${paymentId}::uuid,${input.token})`,
    );
    return one(result.rows, bindingSchema);
  });
}

export async function readPaymentExecutionBinding(
  database: AppDatabase,
  context: TenantContext,
  input: { paymentId: string },
): Promise<PaymentExecutionBinding | null> {
  service(context);
  const paymentId = identifier(input.paymentId);
  return withAccountTx(database, context, async (tx) => {
    const result = await tx.execute(
      sql`select * from billing.read_payment_execution(${paymentId}::uuid)`,
    );
    return result.rows.length === 0 ? null : one(result.rows, bindingSchema);
  });
}

/** Native worker only: pin a chosen stored signing endpoint to a genuinely qualified original execution. */
export async function qualifyPaymentWebhookExecution(
  database: AppDatabase,
  operator: TenantContext,
  input: {
    originOrganizationId: string;
    paymentId: string;
    bindingId: string;
    endpointId: string;
  },
): Promise<void> {
  service(operator);
  await withAccountTx(database, operator, async (tx) => {
    const result =
      await tx.execute(sql`select billing.qualify_payment_webhook(${identifier(input.originOrganizationId)}::uuid,
      ${identifier(input.paymentId)}::uuid,${identifier(input.bindingId)}::uuid,${identifier(input.endpointId)}::uuid) as qualified`);
    if (result.rows.length !== 1 || result.rows[0]?.qualified !== true)
      throw new AppError('PREREQUISITES_INCOMPLETE');
  });
}

/** Called by the actual relay gateway immediately before I/O. No readiness Boolean can replace SQL admission. */
export async function assertPaymentTransport(
  database: AppDatabase,
  context: TenantContext,
  binding: PaymentGatewayBinding,
): Promise<PaymentTransportAdmission> {
  service(context);
  if (identifier(binding.organizationId) !== context.organizationId)
    throw new AppError('NOT_FOUND');
  const authority = paymentAuthoritySchema.safeParse(binding.authority);
  if (!authority.success) throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    const a = authority.data,
      execution = binding.executionBinding;
    const result =
      await tx.execute(sql`select * from billing.admit_payment_transport(${identifier(binding.paymentId)}::uuid,
      ${a.billingOrganizationId}::uuid,${a.connectionId}::uuid,${a.processor},${a.adapterVersion},${a.apiOrigin},${a.authoritySha256},
      ${binding.phase},${execution?.id ?? null}::uuid,${execution?.identitySha256 ?? null},${execution?.bindingSha256 ?? null},
      ${binding.attemptId ?? null}::uuid,${binding.customerToken ?? null}::uuid,${a.restoreGeneration}::uuid)`);
    return one(result.rows, z.strictObject({ restoreGeneration: idSchema, lookupOperationId: idSchema.nullable() }));
  });
}

export async function beginPaymentCustomerRegistration(
  database: AppDatabase,
  context: TenantContext,
  input: { paymentId: string; bindingId: string },
) {
  service(context);
  return withAccountTx(database, context, async (tx) => {
    const result = await tx.execute(
      sql`select * from billing.begin_payment_customer(${identifier(input.paymentId)}::uuid,${identifier(input.bindingId)}::uuid)`,
    );
    return one(
      result.rows,
      z.strictObject({
        action: z.enum(['send', 'confirmed', 'unknown']),
        token: idSchema.nullable(),
        requestKey: z.string().max(256),
        customerRef: z.string().max(256).nullable(),
      }),
    );
  });
}

export async function finishPaymentCustomerRegistration(
  database: AppDatabase,
  context: TenantContext,
  input: {
    paymentId: string;
    bindingId: string;
    token: string;
    customerRef: string | null;
  },
): Promise<void> {
  service(context);
  if (
    input.customerRef !== null &&
    (!input.customerRef || input.customerRef.length > 256 || /[\r\n\0]/.test(input.customerRef))
  )
    throw new AppError('INVALID_INPUT');
  await withAccountTx(database, context, async (tx) => {
    const result =
      await tx.execute(sql`select billing.finish_payment_customer(${identifier(input.paymentId)}::uuid,${identifier(input.bindingId)}::uuid,
      ${identifier(input.token)}::uuid,${input.customerRef}) as settled`);
    if (result.rows.length !== 1 || result.rows[0]?.settled !== true)
      throw new AppError('PREREQUISITES_INCOMPLETE');
  });
}
