// Runtime contracts for billing, lifecycle and support (ADR-032). The shapes match
// docs/specifications/openapi.yaml, and a test keeps their enums the same. Money crosses as a string of digits,
// because JSON numbers cannot hold every bigint. There is no amount here and no default.
import { z } from 'zod';

const noLineBreaks = (value: string) => !/[\r\n\0]/.test(value);
const shortText = (max: number) => z.string().trim().min(1).max(max).refine(noLineBreaks);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const microsWireSchema = z.string().regex(/^-?(0|[1-9][0-9]{0,18})$/);

export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
/** Approved currency data, never inferred from a code or a floating point formatter. */
export const minorUnitExponentSchema = z.int().min(0).max(4);

export const saveBillingAccountSchema = z.strictObject({
  billing_name: shortText(200),
  billing_email: z.email().max(254).refine(noLineBreaks),
  country_code: countryCodeSchema,
  region_code: z.string().regex(/^[A-Z0-9-]{0,16}$/),
  postal_code: shortText(32).nullable(),
  tax_id: shortText(64).nullable(),
});
export type SaveBillingAccountBody = z.infer<typeof saveBillingAccountSchema>;

export const startSubscriptionSchema = z.strictObject({ plan_version_id: z.uuid() });
export type StartSubscriptionBody = z.infer<typeof startSubscriptionSchema>;

export const changePlanSchema = z.strictObject({ plan_version_id: z.uuid() });
export type ChangePlanBody = z.infer<typeof changePlanSchema>;

/** Echoes what the person was shown. A different price answers QUOTE_CHANGED, and nothing is bought. */
export const requestTopUpSchema = z.strictObject({
  offer_id: z.uuid(),
  quote_hash: z.string().regex(/^[0-9a-f]{64}$/),
  request_key: z.string().min(16).max(128),
});
export type RequestTopUpBody = z.infer<typeof requestTopUpSchema>;

export const resolvePaymentSchema = z.strictObject({
  resolution: z.literal('confirmed_not_charged'),
});
export type ResolvePaymentBody = z.infer<typeof resolvePaymentSchema>;

export const voidInvoiceSchema = z.strictObject({ reason_code: code });
export type VoidInvoiceBody = z.infer<typeof voidInvoiceSchema>;

/** Checked when an operator publishes a policy. Every number is theirs. */
export const collectionStepsSchema = z
  .array(
    z.strictObject({
      afterDays: z.int().min(0).max(3650),
      action: z.enum(['notify', 'retry', 'read_only', 'suspend']),
    }),
  )
  .min(1)
  .max(32);

export const invoiceStatusSchema = z.enum(['draft', 'open', 'paid', 'void', 'uncollectible']);
export const paymentStatusSchema = z.enum([
  'ready',
  'sending',
  'reconciling',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
]);

export const dataCategorySchema = z.enum([
  'transaction_records',
  'work_unit_history',
  'raw_files',
  'search_indexes',
  'derived_embeddings',
  'model_outputs',
  'operational_traces',
  'audit_logs',
  'temporary_debug_captures',
]);

/** A number without its sign-off is refused, since that is an invented number (LIFE-02). */
export const setRetentionRuleSchema = z.strictObject({
  data_category: dataCategorySchema,
  classification: z.enum(['*', 'public', 'internal', 'confidential', 'restricted']),
  retain_days: z.int().min(1).max(36500).nullable(),
  basis_ref: shortText(200),
});
export type SetRetentionRuleBody = z.infer<typeof setRetentionRuleSchema>;

export const holdScopeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('organization'), id: z.null() }),
  z.strictObject({
    type: z.enum(['client', 'project', 'work_unit', 'artifact']),
    id: z.uuid(),
  }),
]);

export const placeLegalHoldSchema = z.strictObject({
  /** A reference, such as a matter number, and not a description of the matter. */
  matter_ref: shortText(120),
  scopes: z.array(holdScopeSchema).min(1).max(100),
});
export type PlaceLegalHoldBody = z.infer<typeof placeLegalHoldSchema>;

export const releaseLegalHoldSchema = z.strictObject({ reason_code: code });
export type ReleaseLegalHoldBody = z.infer<typeof releaseLegalHoldSchema>;

export const requestOffboardingSchema = z.strictObject({
  /** The organization's exact name, typed by the person asking. */
  confirm_name: z.string().min(1).max(120),
});
export type RequestOffboardingBody = z.infer<typeof requestOffboardingSchema>;

export const cancelOffboardingSchema = z.strictObject({ reason_code: code });
export type CancelOffboardingBody = z.infer<typeof cancelOffboardingSchema>;

export const ticketCategorySchema = z.enum(['account', 'billing', 'incident', 'security', 'other']);

export const openTicketSchema = z.strictObject({
  subject: shortText(200),
  category: ticketCategorySchema,
  body: z.string().trim().min(1).max(20_000),
});
export type OpenTicketBody = z.infer<typeof openTicketSchema>;

export const replyTicketSchema = z.strictObject({
  body: z.string().trim().min(1).max(20_000),
});
export type ReplyTicketBody = z.infer<typeof replyTicketSchema>;

export const decideBreakGlassSchema = z.strictObject({
  decision: z.enum(['authorize', 'deny']),
});
export type DecideBreakGlassBody = z.infer<typeof decideBreakGlassSchema>;
