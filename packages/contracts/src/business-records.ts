// Runtime contracts for stored business records and the effects proposed on them (EXP-02, ADR-033 D3). The
// request and response shapes match docs/specifications/openapi.yaml. Each `*PayloadSchema` is exactly what an
// approval binds, so every field in it is in the hash (QA-007, ADR-027 D1).
import { z } from 'zod';

const noLineBreaks = (value: string) => !/[\r\n\0]/.test(value);

/** Money stays a string, so a float never rounds it. */
const decimal = z.string().regex(/^-?\d{1,18}(\.\d{1,6})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const externalRef = z.string().min(1).max(1024);
const stream = z.string().regex(/^[a-z0-9_.-]{1,64}$/);

/**
 * Changing named fields on one record. `expected_version` is the version the person was looking at, and the
 * adapter refuses the change if the source has moved on, so an approval cannot overwrite something it never
 * saw. Which fields are writable is checked against BUSINESS_STREAMS wherever this is parsed.
 */
export const recordUpdatePayloadSchema = z.strictObject({
  record: z.strictObject({
    stream,
    external_id: externalRef,
    expected_version: z.string().min(1).max(1024).nullable(),
  }),
  changes: z.record(
    z.string().min(1).max(128),
    z.union([z.string().max(8000), z.number(), z.boolean(), z.null()]),
  ),
});
export type RecordUpdatePayload = z.infer<typeof recordUpdatePayloadSchema>;

/** An internal note on a ticket. `visibility` is a literal: there is no customer-facing form. */
export const ticketCommentAddPayloadSchema = z.strictObject({
  ticket: z.strictObject({ external_id: externalRef }),
  visibility: z.literal('internal'),
  body: z.string().trim().min(1).max(8000),
});
export type TicketCommentAddPayload = z.infer<typeof ticketCommentAddPayloadSchema>;

/**
 * A draft invoice, for a person in the accounting system to review. It has no status field and no bank or
 * payment field, because a draft is all this tool can ever make, and it posts and pays nothing (catalog:
 * "never autonomous transfers by default").
 */
export const invoiceDraftCreatePayloadSchema = z.strictObject({
  customer_ref: z.string().min(1).max(200),
  currency,
  due_on: day.optional(),
  reference: z.string().min(1).max(200).refine(noLineBreaks).optional(),
  memo: z.string().min(1).max(1000).optional(),
  lines: z
    .array(
      z.strictObject({
        description: z.string().trim().min(1).max(500),
        quantity: decimal,
        unit_price: decimal,
      }),
    )
    .min(1)
    .max(200),
});
export type InvoiceDraftCreatePayload = z.infer<typeof invoiceDraftCreatePayloadSchema>;

/** Settings a business connector takes. Never a host, a port or a credential. */
export const businessConnectorConfigSchema = z.strictObject({
  /** The name to check the adapter's TLS certificate against, and the Host header. */
  tlsServerName: z
    .string()
    .regex(/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z][A-Za-z0-9-]{0,62}$/)
    .optional(),
  /** The selected streams. Left out means none: choosing what to keep is a decision someone makes. */
  streams: z.array(stream).max(32).default([]),
  /** What the provider granted this connection. Read and write are asked for separately. */
  scopes: z.array(z.string().regex(/^[a-z_]+\.(read|write)$/)).max(4),
});
export type BusinessConnectorConfig = z.infer<typeof businessConnectorConfigSchema>;

const approver = z.uuid();
const workUnitId = z.uuid();

export const proposeRecordUpdateSchema = z.strictObject({
  work_unit_id: workUnitId,
  approver_membership_id: approver,
  /** The version shown on the page. A stale one is refused here, before anyone is asked. */
  expected_version: z.string().min(1).max(1024).nullable(),
  changes: recordUpdatePayloadSchema.shape.changes,
});
export type ProposeRecordUpdateBody = z.infer<typeof proposeRecordUpdateSchema>;

export const proposeTicketCommentSchema = z.strictObject({
  work_unit_id: workUnitId,
  approver_membership_id: approver,
  body: ticketCommentAddPayloadSchema.shape.body,
});
export type ProposeTicketCommentBody = z.infer<typeof proposeTicketCommentSchema>;

export const proposeInvoiceDraftSchema = z.strictObject({
  work_unit_id: workUnitId,
  connection_id: z.uuid(),
  approver_membership_id: approver,
  invoice: invoiceDraftCreatePayloadSchema,
});
export type ProposeInvoiceDraftBody = z.infer<typeof proposeInvoiceDraftSchema>;

export const reviseBusinessActionSchema = z.strictObject({
  approver_membership_id: approver,
  payload: z.record(z.string(), z.unknown()),
});
export type ReviseBusinessActionBody = z.infer<typeof reviseBusinessActionSchema>;

export const retryBusinessActionSchema = z.strictObject({ approver_membership_id: approver });
export type RetryBusinessActionBody = z.infer<typeof retryBusinessActionSchema>;
