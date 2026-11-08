// Process-local proof only. No Temporal payload, browser or app caller can construct this brand.
import { AppError, idSchema } from '@ensemus/application';
import { isVerifiedPaymentLookupOutcome, type VerifiedPaymentLookupOutcome } from '@ensemus/connectors/payment';
import { attestNativePaymentLookup, type openSecretsDatabase } from '@ensemus/database/secrets';

export function createPaymentLookupAttester(database: ReturnType<typeof openSecretsDatabase>['db']) {
  return async (proof: VerifiedPaymentLookupOutcome) => {
    if (!isVerifiedPaymentLookupOutcome(proof) || Date.now() < proof.verifiedAtEpochMs ||
      Date.now() - proof.verifiedAtEpochMs > 60000)
      throw new AppError('PREREQUISITES_INCOMPLETE');
    return attestNativePaymentLookup(database, {
      organizationId: idSchema.parse(proof.organizationId), paymentId: idSchema.parse(proof.paymentId),
      attemptId: idSchema.parse(proof.attemptId), executionBindingId: idSchema.parse(proof.executionBindingId),
      lookupOperationId: idSchema.parse(proof.lookupOperationId), restoreGeneration: idSchema.parse(proof.restoreGeneration),
      authoritySha256: proof.authoritySha256, requestKeySha256: proof.requestKeySha256,
      factCanonical: proof.factCanonical,
    });
  };
}
