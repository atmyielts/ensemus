// The frozen /3 archive has no M11 record shapes. Recognizing these schemas permits only a native
// proof that this tenant has no such data; this list does not declare the tables portable or erasable.
// The complete portability inventory remains a release gate until a new reviewed profile covers them.
export const PENDING_PORTABILITY_TABLES = [
  'marketplace.installations',
  'skills.packages',
  'skills.trusted_signers',
  'federation.org_settings',
  'federation.grants',
  'federation.outbound_items',
  'federation.inbound_items',
  'federation.crossings',
  // These two describe the deployment, not a company's portable execution authority.
  'tenancy.deployment_profile',
  'tenancy.isolation_evidence',
] as const;
