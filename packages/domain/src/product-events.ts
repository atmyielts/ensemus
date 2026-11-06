// Outbox event names for M7 (ADR-031). Payloads are IDs and enums only, and the dispatcher sees none of
// them: it works from the event's type and aggregate ID alone.

export const AGGREGATE_SIMULATION_RUN = 'simulation_run';
export const AGGREGATE_PROCESS_RUN = 'process_run';
export const AGGREGATE_OBJECT_MIGRATION = 'object_migration';
export const AGGREGATE_AGENT_DRAFT = 'agent_draft';
export const AGGREGATE_PROCESS_DRAFT = 'process_draft';
export const AGGREGATE_PUBLISH_REVIEW = 'publish_review';
export const AGGREGATE_OBJECT_TYPE = 'object_type';
export const AGGREGATE_PACK_INSTALLATION = 'pack_installation';
export const AGGREGATE_OUTCOME_DRAFT = 'outcome_draft';
export const AGGREGATE_SSO_CONNECTION = 'sso_connection';
export const AGGREGATE_MEMBERSHIP = 'membership';
export const AGGREGATE_ORGANIZATION = 'organization';

/** The dispatcher starts simulationWorkflow, one per run ever. */
export const SIMULATION_REQUESTED = 'simulation.requested';
/** The dispatcher starts processRunWorkflow, one per run ever. */
export const PROCESS_RUN_REQUESTED = 'process_run.requested';
/** Something a run waits on may have moved. The dispatcher signals it. A timer covers a lost signal. */
export const PROCESS_RUN_WAKE = 'process_run.wake';
/** Someone asked a run to stop. The next step sees it in PostgreSQL. This only saves the wait. */
export const PROCESS_RUN_STOP_REQUESTED = 'process_run.stop_requested';
/** The dispatcher starts objectMigrationWorkflow, one per migration ever. */
export const OBJECT_MIGRATION_REQUESTED = 'object_migration.requested';

/** Facts for projections. Nothing outside PostgreSQL consumes these yet. */
export const AGENT_DRAFT_SUBMITTED = 'agent_draft.submitted';
export const PUBLISH_REVIEW_DECIDED = 'publish_review.decided';
export const AGENT_DRAFT_PUBLISHED = 'agent_draft.published';
export const PROCESS_SPEC_PUBLISHED = 'process_spec.published';
export const PROCESS_RUN_FINISHED = 'process_run.finished';
export const OBJECT_TYPE_CHANGED = 'object_type.changed';
export const PACK_ACTIVATED = 'pack.activated';
export const PACK_ROLLED_BACK = 'pack.rolled_back';
export const OUTCOME_AUTHORIZED = 'outcome.authorized';
export const ONBOARDING_FINISHED = 'onboarding.finished';
export const SSO_CONNECTION_CHANGED = 'sso_connection.changed';
export const MEMBER_DEPROVISIONED = 'member.deprovisioned';
export const SECURITY_POLICY_CHANGED = 'security_policy.changed';

/** Notification kinds. Each has a target of `{kind}:{id}`. */
export const NOTIFY_PUBLISH_REVIEW_REQUESTED = 'publish_review.requested';
export const NOTIFY_PUBLISH_REVIEW_DECIDED = 'publish_review.decided';
export const NOTIFY_PROCESS_RUN_FINISHED = 'process_run.finished';
export const publishReviewTargetRef = (id: string) => `publish_review:${id}`;
export const processRunTargetRef = (id: string) => `process_run:${id}`;
