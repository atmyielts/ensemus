// Only this native worker holds the existing broker-role database handle. Nothing is sent to a browser/workflow.
import { AppError, idSchema } from '@ensemus/application';
import { isVerifiedPaymentExecutionIdentity, type VerifiedPaymentExecutionIdentity } from '@ensemus/connectors/payment';
import type { PaymentConnectionAuthority } from '@ensemus/saas/payment';
import type { openSecretsDatabase } from '@ensemus/database/secrets';
import { sql } from 'drizzle-orm';

export function createPaymentIdentityAttester(database: ReturnType<typeof openSecretsDatabase>['db']) {
  return async (input: { organizationId: string; paymentId: string; authority: PaymentConnectionAuthority; proof: VerifiedPaymentExecutionIdentity }) => {
    const { proof, authority } = input;
    if (!isVerifiedPaymentExecutionIdentity(proof) || proof.authoritySha256 !== authority.authoritySha256
      || proof.apiOrigin !== authority.apiOrigin || proof.identity.processor !== authority.processor
      || proof.identity.adapterVersion !== authority.adapterVersion || Date.now() < proof.verifiedAtEpochMs
      || Date.now() - proof.verifiedAtEpochMs > 60000) throw new AppError('PREREQUISITES_INCOMPLETE');
    const organizationId = idSchema.parse(input.organizationId), paymentId = idSchema.parse(input.paymentId);
    return database.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.organization_id',${authority.billingOrganizationId},true)`);
      const result = await tx.execute<{ token: string; expiresAt: Date }>(sql`select * from billing.attest_payment_identity(${organizationId}::uuid,
        ${paymentId}::uuid,${authority.billingOrganizationId}::uuid,${authority.connectionId}::uuid,${authority.processor},${authority.adapterVersion},${authority.apiOrigin},
        ${authority.authoritySha256},${proof.sha256},${proof.accountNamespaceSha256},${proof.readReceiptSha256})`);
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row || !/^[0-9a-f]{64}$/.test(row.token)
        || !(row.expiresAt instanceof Date) || !Number.isFinite(row.expiresAt.getTime())) throw new AppError('PREREQUISITES_INCOMPLETE');
      return { token: row.token, expiresAt: row.expiresAt };
    });
  };
}
