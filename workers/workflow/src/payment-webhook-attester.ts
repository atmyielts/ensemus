// Payment-only native signature witness. The existing secrets-role handle never leaves this worker.
import { AppError, idSchema } from '@ensemus/application';
import { attestNativePaymentWebhook, type openSecretsDatabase } from '@ensemus/database/secrets';
import {
  isVerifiedPaymentWebhook,
  type VerifiedPaymentWebhook,
} from '@ensemus/workflows/webhook-activities';

export function createPaymentWebhookAttester(
  database: ReturnType<typeof openSecretsDatabase>['db'],
) {
  return async (proof: VerifiedPaymentWebhook): Promise<{ token: string; expiresAt: Date }> => {
    if (
      !isVerifiedPaymentWebhook(proof) ||
      !Number.isSafeInteger(proof.verifiedAtEpochMs) ||
      Date.now() < proof.verifiedAtEpochMs ||
      Date.now() - proof.verifiedAtEpochMs > 60000 ||
      !/^[0-9]{1,20}$/.test(proof.rowVersion)
    )
      throw new AppError('PREREQUISITES_INCOMPLETE');
    const organizationId = idSchema.parse(proof.organizationId),
      deliveryId = idSchema.parse(proof.deliveryId),
      endpointId = idSchema.parse(proof.endpointId),
      connectionId = idSchema.parse(proof.connectionId),
      signingId = idSchema.parse(proof.signingSecretId);
    try {
      return await attestNativePaymentWebhook(database, {
        organizationId,
        deliveryId,
        rowVersion: proof.rowVersion,
        endpointId,
        connectionId,
        signingSecretId: signingId,
        processor: proof.processor,
        adapterVersion: proof.adapterVersion,
        providerEventId: proof.providerEventId,
        bodySha256: proof.bodySha256,
        requestDigest: proof.requestDigest,
        headersSha256: proof.headersSha256,
        factSha256: proof.factSha256,
        accountNamespaceSha256: proof.accountNamespaceSha256,
        executionIdentitySha256: proof.executionIdentitySha256,
      });
    } catch {
      throw new Error('PAYMENT_WEBHOOK_VERIFICATION_UNAVAILABLE');
    }
  };
}
