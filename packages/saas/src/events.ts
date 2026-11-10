// Outbox event names for M8 (ADR-032). Payloads are IDs and enums only, and the dispatcher sees none of
// them: it works from the event's type and aggregate ID alone.

export const AGGREGATE_SUBSCRIPTION = 'subscription';
export const AGGREGATE_INVOICE = 'invoice';
export const AGGREGATE_PAYMENT = 'payment';
export const AGGREGATE_PAYMENT_WEBHOOK_EVENT = 'payment_webhook_event';
export const AGGREGATE_TOP_UP = 'top_up';
export const AGGREGATE_LEGAL_HOLD = 'legal_hold';
export const AGGREGATE_OFFBOARDING = 'offboarding';
export const AGGREGATE_TICKET = 'ticket';
export const AGGREGATE_BREAK_GLASS = 'break_glass';
export const AGGREGATE_ORGANIZATION = 'organization';

/** A live subscription exists. The dispatcher makes sure this tenant's billing schedule does. */
export const SUBSCRIPTION_STARTED = 'subscription.started';
export const SUBSCRIPTION_PLAN_CHANGED = 'subscription.plan_changed';
export const SUBSCRIPTION_CANCEL_REQUESTED = 'subscription.cancel_requested';
export const SUBSCRIPTION_CANCELED = 'subscription.canceled';

/** A tenant's standing moved. Nothing outside PostgreSQL consumes this yet. */
export const TENANT_STANDING_CHANGED = 'tenant.standing_changed';
/** Stops this tenant's schedules. The dispatcher deletes them, and a repeat finds them gone. */
export const TENANT_SCHEDULES_ENDED = 'tenant.schedules_ended';

export const INVOICE_ISSUED = 'invoice.issued';
export const INVOICE_PAID = 'invoice.paid';
export const INVOICE_VOIDED = 'invoice.voided';

/** Someone or something asked to charge an invoice. The dispatcher starts paymentWorkflow, once. */
export const PAYMENT_REQUESTED = 'payment.requested';
export const PAYMENT_SUCCEEDED = 'payment.succeeded';
export const PAYMENT_FAILED = 'payment.failed';
export const PAYMENT_UNKNOWN = 'payment.unknown';
/** A verified event reached the operator's organization. The dispatcher starts paymentEventWorkflow. */
export const PAYMENT_EVENT_RECEIVED = 'payment_event.received';

export const CREDITS_LOW = 'credits.low';
export const CREDITS_EXHAUSTED = 'credits.exhausted';
export const TOP_UP_REQUESTED = 'top_up.requested';
export const TOP_UP_CREDITED = 'top_up.credited';

/** A retention rule exists. The dispatcher makes sure this tenant's retention schedule does. */
export const RETENTION_RULE_SET = 'retention.rule_set';
export const LEGAL_HOLD_PLACED = 'legal_hold.placed';
export const LEGAL_HOLD_RELEASED = 'legal_hold.released';

/** Starts or wakes tenantOffboardingWorkflow, which reads what to do next from the row. */
export const OFFBOARDING_REQUESTED = 'offboarding.requested';
export const OFFBOARDING_RESUMED = 'offboarding.resumed';
export const OFFBOARDING_CANCELLED = 'offboarding.cancelled';
export const OFFBOARDING_REPORTED = 'offboarding.reported';

export const TICKET_OPENED = 'ticket.opened';
export const TICKET_REPLIED = 'ticket.replied';
export const BREAK_GLASS_REQUESTED = 'break_glass.requested';
export const BREAK_GLASS_AUTHORIZED = 'break_glass.authorized';
export const BREAK_GLASS_CLOSED = 'break_glass.closed';

/** Notification kinds. The target is the matching `*TargetRef`, and the slice owning it adds the words. */
export const NOTIFY_INVOICE_ISSUED = 'invoice.issued';
export const NOTIFY_PAYMENT_FAILED = 'payment.failed';
export const NOTIFY_PAYMENT_UNKNOWN = 'payment.unknown';
export const NOTIFY_CREDITS_LOW = 'credits.low';
export const NOTIFY_CREDITS_EXHAUSTED = 'credits.exhausted';
export const NOTIFY_STANDING_CHANGED = 'tenant.standing_changed';
export const NOTIFY_OFFBOARDING = 'offboarding.progress';
export const NOTIFY_TICKET_REPLIED = 'ticket.replied';
export const NOTIFY_BREAK_GLASS = 'break_glass.requested';
export const invoiceTargetRef = (id: string) => `invoice:${id}`;
export const paymentTargetRef = (id: string) => `payment:${id}`;
export const offboardingTargetRef = (id: string) => `offboarding:${id}`;
export const ticketTargetRef = (id: string) => `ticket:${id}`;
export const breakGlassTargetRef = (id: string) => `break_glass:${id}`;
export const organizationTargetRef = (id: string) => `organization:${id}`;
