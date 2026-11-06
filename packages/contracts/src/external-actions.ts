// Runtime contracts for connectors, external actions and webhooks (ADR-027). The request and response
// shapes match docs/specifications/openapi.yaml, and a test keeps their enums the same.
import { z } from 'zod';

/** Stops header injection at the door: an address or subject with a line break never gets further. */
const noLineBreaks = (value: string) => !/[\r\n\0]/.test(value);

const emailAddress = z.email().max(254).refine(noLineBreaks);
const MAX_RECIPIENTS = 50;

/**
 * Exactly what an `email.send` approval binds. Every field is in the hash, so a recipient, the sender or
 * a word of the text cannot change after approval (QA-007). Bodies are plain text, with no attachments
 * in M3, and the Message-ID is derived from the intent, so nothing else goes in here.
 */
export const emailSendPayloadSchema = z
  .strictObject({
    from: z.strictObject({
      address: emailAddress,
      name: z.string().trim().min(1).max(120).refine(noLineBreaks).optional(),
    }),
    to: z.array(emailAddress).min(1).max(MAX_RECIPIENTS),
    cc: z.array(emailAddress).max(MAX_RECIPIENTS).optional(),
    bcc: z.array(emailAddress).max(MAX_RECIPIENTS).optional(),
    reply_to: emailAddress.optional(),
    subject: z.string().trim().min(1).max(200).refine(noLineBreaks),
    text_body: z.string().min(1).max(200_000),
  })
  .refine(
    (mail) => mail.to.length + (mail.cc?.length ?? 0) + (mail.bcc?.length ?? 0) <= MAX_RECIPIENTS,
    { path: ['to'] },
  );
export type EmailSendPayload = z.infer<typeof emailSendPayloadSchema>;

export const externalActionStatusSchema = z.enum([
  'awaiting_approval',
  'ready',
  'sending',
  'reconciling',
  'sent',
  'failed',
  'unknown',
  'cancelled',
]);
export type ExternalActionStatusDto = z.infer<typeof externalActionStatusSchema>;

/** What a person is asked for when they say what happened to an unknown action. */
export const resolveExternalActionSchema = z.strictObject({
  resolution: z.enum(['confirmed_sent', 'confirmed_not_sent']),
  reason: z.string().trim().min(1).max(2000),
});
export type ResolveExternalActionBody = z.infer<typeof resolveExternalActionSchema>;

/** Proposing a send. The sender comes from the connection, on the server, and not from this. */
export const proposeEmailActionSchema = z.strictObject({
  connection_id: z.uuid(),
  approver_membership_id: z.uuid(),
  email: z.strictObject({
    to: z.array(emailAddress).min(1).max(MAX_RECIPIENTS),
    cc: z.array(emailAddress).max(MAX_RECIPIENTS).optional(),
    bcc: z.array(emailAddress).max(MAX_RECIPIENTS).optional(),
    reply_to: emailAddress.optional(),
    subject: z.string().trim().min(1).max(200).refine(noLineBreaks),
    text_body: z.string().min(1).max(200_000),
  }),
});
export type ProposeEmailActionBody = z.infer<typeof proposeEmailActionSchema>;

/** A revision replaces the content, and needs its own approval. The old intent is closed. */
export const reviseEmailActionSchema = proposeEmailActionSchema.omit({ connection_id: true });
export type ReviseEmailActionBody = z.infer<typeof reviseEmailActionSchema>;

export const retryExternalActionSchema = z.strictObject({ approver_membership_id: z.uuid() });
export type RetryExternalActionBody = z.infer<typeof retryExternalActionSchema>;

export const createConnectionSchema = z.strictObject({
  connector_type: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  display_name: z.string().trim().min(1).max(120),
  /** Checked against that connector's own settings, on the server. It can never name a host. */
  config: z.record(z.string(), z.unknown()),
  /** Sealed on arrival. It is never returned, logged or stored as sent. */
  credential: z.string().min(1).max(4096).optional(),
});
export type CreateConnectionBody = z.infer<typeof createConnectionSchema>;

export const connectionStateSchema = z.enum(['active', 'disabled', 'revoked']);

/**
 * The generic inbound webhook's body. The signature covers it, and it can only ask: the action still
 * needs a person's approval, and it names work and a connection in the tenant the endpoint belongs to.
 */
export const inboundWebhookEnvelopeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('external_action.proposed'),
    work_unit_id: z.uuid(),
    connection_id: z.uuid(),
    email: proposeEmailActionSchema.shape.email,
  }),
  z.strictObject({ type: z.literal('connector.sync_requested') }),
]);
export type InboundWebhookEnvelope = z.infer<typeof inboundWebhookEnvelopeSchema>;
