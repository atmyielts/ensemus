// Owned by the transport slice (SEC-11). See docs/06-delivery/m4-slices.md and ADR-028 FD-10, FD-21.
//
// How long a key lives, since "wiped" only covers part of it. The sealed value is opened into one Buffer,
// which SecretBroker lends and this lender wipes when `use` returns, however it returns. An HTTP header can
// only be a string, so an adapter has to copy the key into one, and JavaScript strings are immutable: that
// copy, and the header buffers undici makes from it, stay in memory until the garbage collector reuses
// them, and nothing here can zero them. So the exposure is one process's heap, for a little longer than
// the call, and a heap dump of agent-worker could hold a key. That is why the worker runs alone (FD-2) and
// why no adapter keeps a provider instance past its call. The outside review should see this paragraph.
import type { SecretLease } from '@ensemus/application';
import { isHostedProviderKind } from '@ensemus/domain/ai';
import { modelKeyPurpose } from '@ensemus/domain/ai-binding';
import type { CredentialLender } from './types';

/** No hosted key may be opened on this deployment (FD-21). Says nothing about the key or the profile. */
export class CredentialsNotReviewed extends Error {
  override name = 'CredentialsNotReviewed';
  readonly code = 'MODEL_CREDENTIALS_NOT_REVIEWED';
  constructor() {
    super('Model credentials have not been reviewed on this deployment');
  }
}

/** `reviewInterlock` is the value of ENSEMUS_MODEL_CREDENTIALS_REVIEWED, read by the caller. */
export function createCredentialLender(deps: {
  secrets: SecretLease;
  reviewInterlock: string | null;
}): CredentialLender {
  const reviewed = Boolean(deps.reviewInterlock?.trim());
  return {
    async withKey(profile, use) {
      // Checked at use as well as at capture, so a key sealed before the setting was removed stays shut,
      // and before the broker is asked, so a refusal never opens anything.
      if (isHostedProviderKind(profile.providerKind) && !reviewed) {
        throw new CredentialsNotReviewed();
      }
      // Derived here, from the endpoint this call will really use, and never read from a row. A tampered
      // endpoint therefore fails AES-GCM authentication inside the broker, as SecretUnavailable.
      const purpose = modelKeyPurpose(profile.profileId, profile.endpointUrl);
      return deps.secrets.withSecret(
        { organizationId: profile.organizationId, secretId: profile.secretRef, purpose },
        async (key) => {
          try {
            return await use(key);
          } finally {
            // SecretBroker wipes this too. The port does not promise that, so it is not relied on.
            key.fill(0);
          }
        },
      );
    },
  };
}
