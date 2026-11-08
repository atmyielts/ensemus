// Payment-only native signature witness. The existing secrets-role handle never leaves this worker.
import { AppError, idSchema } from '@ensemus/application';
import type { openSecretsDatabase } from '@ensemus/database/secrets';
import { isVerifiedPaymentWebhook, type VerifiedPaymentWebhook } from '@ensemus/workflows/webhook-activities';
import { sql } from 'drizzle-orm';

export function createPaymentWebhookAttester(database: ReturnType<typeof openSecretsDatabase>['db']) {
  return async (proof: VerifiedPaymentWebhook): Promise<{ token: string; expiresAt: Date }> => {
    if (!isVerifiedPaymentWebhook(proof) || !Number.isSafeInteger(proof.verifiedAtEpochMs)
      || Date.now()<proof.verifiedAtEpochMs || Date.now()-proof.verifiedAtEpochMs>60000
      || !/^[0-9]{1,20}$/.test(proof.rowVersion)) throw new AppError('PREREQUISITES_INCOMPLETE');
    const organizationId = idSchema.parse(proof.organizationId), deliveryId = idSchema.parse(proof.deliveryId),
      endpointId = idSchema.parse(proof.endpointId), connectionId = idSchema.parse(proof.connectionId), signingId = idSchema.parse(proof.signingSecretId);
    try {
      return await database.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.organization_id',${organizationId},true)`);
        const result = await tx.execute<{ token: string; expiresAt: Date }>(sql`select * from billing.attest_payment_webhook(
          ${deliveryId}::uuid,${proof.rowVersion},${endpointId}::uuid,${connectionId}::uuid,${signingId}::uuid,
          ${proof.processor},${proof.adapterVersion},${proof.providerEventId},${proof.bodySha256},${proof.requestDigest},${proof.headersSha256},
          ${proof.factSha256},${proof.accountNamespaceSha256},${proof.executionIdentitySha256})`);
        const row=result.rows[0];
        if (result.rows.length!==1 || !row || !/^[0-9a-f]{64}$/.test(row.token) || !(row.expiresAt instanceof Date)
          || !Number.isFinite(row.expiresAt.getTime())) throw new Error('PAYMENT_WEBHOOK_VERIFICATION_UNAVAILABLE');
        return {token:row.token,expiresAt:row.expiresAt};
      });
    } catch { throw new Error('PAYMENT_WEBHOOK_VERIFICATION_UNAVAILABLE'); }
  };
}
