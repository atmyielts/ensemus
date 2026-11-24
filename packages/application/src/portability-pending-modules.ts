// The frozen /3 archive has no M11 record shapes. Recognizing these schemas permits only a native
// proof that this tenant has no such data; this list does not declare the tables portable or erasable.
// The complete portability inventory remains a release gate until a new reviewed profile covers them.
export const PENDING_PORTABILITY_TABLES = [
  'integrations.business_record_actions',
  'integrations.business_records',
  'marketplace.installations',
  'marketplace.listings',
  'marketplace.security_reviews',
  'marketplace.submissions',
  'sandbox.runs',
  'skills.bundle_uploads',
  'skills.packages',
  'skills.test_runs',
  'skills.package_versions',
  'skills.trusted_signers',
  'tenancy.residency_requirements',
  'federation.org_settings',
  'federation.grants',
  'federation.outbound_items',
  'federation.inbound_items',
  'federation.crossings',
  // These two describe the deployment, not a company's portable execution authority.
  'tenancy.deployment_profile',
  'tenancy.isolation_evidence',
] as const;
