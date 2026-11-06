// Owned by the transport slice (SEC-11). See docs/06-delivery/m4-slices.md and ADR-028 FD-10, FD-21.
import type { SecretLease } from '@ensemus/application';
import type { CredentialLender } from './types';

/** `reviewInterlock` is the value of ENSEMUS_MODEL_CREDENTIALS_REVIEWED, read by the caller. */
export function createCredentialLender(_deps: {
  secrets: SecretLease;
  reviewInterlock: string | null;
}): CredentialLender {
  return {
    withKey() {
      return Promise.reject(new Error('NOT_IMPLEMENTED'));
    },
  };
}
