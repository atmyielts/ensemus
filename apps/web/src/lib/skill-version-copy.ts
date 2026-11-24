const VERIFICATION_ERRORS: Readonly<Record<string, string>> = {
  BUNDLE_UNAVAILABLE: 'The stored bundle could not be read.',
  BUNDLE_HASH_MISMATCH: 'The stored bytes do not match the upload.',
  SIGNER_UNTRUSTED: 'The publisher key is untrusted.',
  SIGNER_REVOKED: 'The publisher key was revoked.',
  VERSION_TAKEN: 'That version number is already in use.',
  TESTS_FAILED: 'The bundle did not pass its fixture checks.',
  SANDBOX_UNAVAILABLE: 'This deployment cannot run the bundle’s code tests.',
};

export function verificationError(code: string) {
  return VERIFICATION_ERRORS[code] ?? 'The bundle did not pass verification.';
}
