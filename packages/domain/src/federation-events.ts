// Outbox event names for cross-organization work (ADR-035 D3). Payloads are IDs and enums only. The event
// lives in the tenant whose person acted, and the other side hears from a worker, never from this row.

/** Aggregate types these events carry, which is how the dispatcher finds the ID it needs. */
export const AGGREGATE_FEDERATION_GRANT = 'federation_grant';
export const AGGREGATE_FEDERATION_ITEM = 'federation_item';
export const AGGREGATE_FEDERATION_SETTINGS = 'federation_settings';

/** Facts for projections and the audit trail. Nothing outside PostgreSQL consumes these. */
export const FEDERATION_SETTINGS_CHANGED = 'federation.settings_changed';
export const FEDERATION_GRANT_PROPOSED = 'federation.grant_proposed';
export const FEDERATION_GRANT_ACCEPTED = 'federation.grant_accepted';
export const FEDERATION_GRANT_ACTIVATED = 'federation.grant_activated';

/** Either side ended it. The dispatcher starts federationPurgeWorkflow, once per grant. */
export const FEDERATION_GRANT_ENDED = 'federation.grant_ended';

/** Someone sent an item. The dispatcher starts federationDeliveryWorkflow, once per item. */
export const FEDERATION_ITEM_PUBLISHED = 'federation.item_published';
/** The sender took it back. The dispatcher starts federationPurgeWorkflow for that one item. */
export const FEDERATION_ITEM_WITHDRAWN = 'federation.item_withdrawn';
/** A worker wrote this in the receiver's tenant after the copy landed. Nothing consumes it yet. */
export const FEDERATION_ITEM_RECEIVED = 'federation.item_received';
export const FEDERATION_ITEM_DISPOSED = 'federation.item_disposed';

/** Notification kinds. The target is `federation_grant:{id}` or `federation_item:{id}`. */
export const NOTIFY_FEDERATION_GRANT_ACCEPTED = 'federation.grant_accepted';
export const NOTIFY_FEDERATION_GRANT_ACTIVATED = 'federation.grant_activated';
export const NOTIFY_FEDERATION_GRANT_ENDED = 'federation.grant_ended';
export const NOTIFY_FEDERATION_ITEM_RECEIVED = 'federation.item_received';
export const federationGrantTargetRef = (id: string) => `federation_grant:${id}`;
export const federationItemTargetRef = (id: string) => `federation_item:${id}`;

/** Audit actions, written in both tenants, since both are entitled to know. */
export const AUDIT_FEDERATION_ENABLED = 'federation.enabled';
export const AUDIT_FEDERATION_DISABLED = 'federation.disabled';
export const AUDIT_FEDERATION_GRANT_PROPOSED = 'federation.grant_proposed';
export const AUDIT_FEDERATION_GRANT_ACCEPTED = 'federation.grant_accepted';
export const AUDIT_FEDERATION_GRANT_ACTIVATED = 'federation.grant_activated';
export const AUDIT_FEDERATION_GRANT_ENDED = 'federation.grant_ended';
export const AUDIT_FEDERATION_ITEM_SENT = 'federation.item_sent';
export const AUDIT_FEDERATION_ITEM_RECEIVED = 'federation.item_received';
export const AUDIT_FEDERATION_ITEM_WITHDRAWN = 'federation.item_withdrawn';
export const AUDIT_FEDERATION_FILE_READ = 'federation.file_read';
export const AUDIT_RESIDENCY_DENIED = 'residency.denied';
export const AUDIT_RESIDENCY_REQUIREMENT_SET = 'residency.requirement_set';
export const AUDIT_RESIDENCY_REQUIREMENT_REMOVED = 'residency.requirement_removed';
