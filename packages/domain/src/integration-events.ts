// Outbox event names for connectors and external actions (ADR-027). Payloads are IDs and enums only, and
// the dispatcher sees none of them: it works from the event's type and aggregate ID alone.

/** Aggregate types these events carry, which is how the dispatcher finds the ID it needs. */
export const AGGREGATE_EXTERNAL_ACTION = 'external_action';
export const AGGREGATE_WEBHOOK_DELIVERY = 'webhook_delivery';
export const AGGREGATE_CONNECTION = 'connection';

/** Proposed and waiting for approval. Nothing consumes it yet. */
export const EXTERNAL_ACTION_PROPOSED = 'external_action.proposed';
/** Approved or needing no approval. The dispatcher starts externalActionWorkflow. */
export const EXTERNAL_ACTION_READY = 'external_action.ready';
/** Facts for projections. Nothing outside PostgreSQL consumes these yet. */
export const EXTERNAL_ACTION_SENT = 'external_action.sent';
export const EXTERNAL_ACTION_FAILED = 'external_action.failed';
export const EXTERNAL_ACTION_UNKNOWN = 'external_action.unknown';
export const EXTERNAL_ACTION_CANCELLED = 'external_action.cancelled';
export const EXTERNAL_ACTION_RESOLVED = 'external_action.resolved';

/** A delivery was stored. The dispatcher starts webhookDeliveryWorkflow. */
export const WEBHOOK_RECEIVED = 'webhook.received';

/** A connection has something to do. Both start connectorSyncWorkflow, which reads what from the row. */
export const CONNECTOR_SYNC_REQUESTED = 'connector.sync_requested';
export const CONNECTION_REVOKED = 'connection.revoked';
export const CONNECTION_CREATED = 'connection.created';

/** Notification kinds. The target is `external_action:{id}`. */
export const NOTIFY_EXTERNAL_ACTION_UNKNOWN = 'external_action.unknown';
export const NOTIFY_EXTERNAL_ACTION_FAILED = 'external_action.failed';
export const NOTIFY_EXTERNAL_ACTION_SENT = 'external_action.sent';
export const externalActionTargetRef = (id: string) => `external_action:${id}`;
