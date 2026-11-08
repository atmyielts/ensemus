// Only this native worker holds the existing broker-role database handle. Nothing is sent to a browser/workflow.
import { AppError, idSchema } from '@ensemus/application';
import {
  isVerifiedPaymentExecutionIdentity,
  type VerifiedPaymentExecutionIdentity,
} from '@ensemus/connectors/payment';
import type { PaymentConnectionAuthority } from '@ensemus/saas/payment';
import { attestNativePaymentIdentity, type openSecretsDatabase } from '@ensemus/database/secrets';

export function createPaymentIdentityAttester(
  database: ReturnType<typeof openSecretsDatabase>['db'],
) {
  return async (input: {
    organizationId: string;
    paymentId: string;
    authority: PaymentConnectionAuthority;
    proof: VerifiedPaymentExecutionIdentity;
  }) => {
    const { proof, authority } = input;
    if (
      !isVerifiedPaymentExecutionIdentity(proof) ||
      proof.authoritySha256 !== authority.authoritySha256 ||
      proof.restoreGeneration !== authority.restoreGeneration ||
      proof.apiOrigin !== authority.apiOrigin ||
      proof.identity.processor !== authority.processor ||
      proof.identity.adapterVersion !== authority.adapterVersion ||
      Date.now() < proof.verifiedAtEpochMs ||
      Date.now() - proof.verifiedAtEpochMs > 60000
    )
      throw new AppError('PREREQUISITES_INCOMPLETE');
    const organizationId = idSchema.parse(input.organizationId),
      paymentId = idSchema.parse(input.paymentId);
    return attestNativePaymentIdentity(database, {
      organizationId,
      paymentId,
      billingOrganizationId: authority.billingOrganizationId,
      connectionId: authority.connectionId,
      processor: authority.processor,
      adapterVersion: authority.adapterVersion,
      apiOrigin: authority.apiOrigin,
      authoritySha256: authority.authoritySha256,
      identitySha256: proof.sha256,
      accountNamespaceSha256: proof.accountNamespaceSha256,
      readReceiptSha256: proof.readReceiptSha256,
      restoreGeneration: idSchema.parse(proof.restoreGeneration),
    });
  };
}
