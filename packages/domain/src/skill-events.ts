// Outbox event names for skills, sandbox runs and the marketplace (ADR-034). Payloads are IDs and enums
// only. The dispatcher sees none of them: it works from the event's type and aggregate ID alone.

export const AGGREGATE_SKILL_VERSION = 'skill_version';
export const AGGREGATE_SKILL_SIGNER = 'skill_signer';
export const AGGREGATE_SANDBOX_RUN = 'sandbox_run';
export const AGGREGATE_MARKETPLACE_SUBMISSION = 'marketplace_submission';
export const AGGREGATE_MARKETPLACE_INSTALLATION = 'marketplace_installation';

/** Bytes are stored. The dispatcher starts skillVerificationWorkflow, once per version, ever. */
export const SKILL_VERSION_UPLOADED = 'skill_version.uploaded';
/** Facts for projections. Nothing outside PostgreSQL consumes these yet. */
export const SKILL_VERSION_VERIFIED = 'skill_version.verified';
export const SKILL_VERSION_REJECTED = 'skill_version.rejected';
export const SKILL_VERSION_PUBLISHED = 'skill_version.published';
export const SKILL_VERSION_YANKED = 'skill_version.yanked';
export const SKILL_SIGNER_ADDED = 'skill_signer.added';
export const SKILL_SIGNER_REVOKED = 'skill_signer.revoked';

/** The dispatcher starts sandboxRunWorkflow. A run that tests a version starts as a child instead. */
export const SANDBOX_RUN_REQUESTED = 'sandbox_run.requested';
/** The dispatcher cancels the run's workflow. The row is rechecked before start, so this cannot lose. */
export const SANDBOX_RUN_CANCEL_REQUESTED = 'sandbox_run.cancel_requested';
export const SANDBOX_RUN_SETTLED = 'sandbox_run.settled';

/** Facts. The operator works from the submissions table, on purpose with no path from an event. */
export const MARKETPLACE_SUBMITTED = 'marketplace_submission.submitted';
export const MARKETPLACE_WITHDRAWN = 'marketplace_submission.withdrawn';
export const MARKETPLACE_DELIST_REQUESTED = 'marketplace_submission.delist_requested';

/** The dispatcher starts marketplaceInstallWorkflow. */
export const MARKETPLACE_INSTALL_REQUESTED = 'marketplace_installation.requested';
export const MARKETPLACE_INSTALLED = 'marketplace_installation.installed';
export const MARKETPLACE_INSTALL_FAILED = 'marketplace_installation.failed';
export const MARKETPLACE_REMOVED = 'marketplace_installation.removed';

/** Notification kinds. Targets are `skill_version:{id}`, `sandbox_run:{id}`. */
export const NOTIFY_SKILL_VERSION_VERIFIED = 'skill_version.verified';
export const NOTIFY_SKILL_VERSION_REJECTED = 'skill_version.rejected';
export const NOTIFY_SKILL_VERSION_YANKED = 'skill_version.yanked';
export const NOTIFY_MARKETPLACE_INSTALL_FAILED = 'marketplace_installation.failed';
export const skillVersionTargetRef = (id: string) => `skill_version:${id}`;
export const sandboxRunTargetRef = (id: string) => `sandbox_run:${id}`;
