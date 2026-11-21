// The adapter protocol (ADR-033 D2): what a business connector says over the egress gateway, to the one
// endpoint an operator configured. It names no vendor. A customer or integrator maps it to whichever CRM,
// ticketing or accounting system they run, and a vendor's own connector can replace it later. What comes back
// is a stranger's data, so all of it is parsed here before anything reads it.
import { z } from 'zod';

export const ADAPTER_BASE_PATH = '/ensemus-adapter/v1';
export const ADAPTER_IDEMPOTENCY_HEADER = 'idempotency-key';

const shortId = z.string().min(1).max(1024);

export const adapterGrantSchema = z.strictObject({
  principal_kind: z.enum(['user', 'group', 'domain', 'anyone']),
  principal_external_id: shortId,
  access: z.enum(['read', 'write', 'owner']),
});

/** One record. `fields` is whatever the source sends: the stream's allowlist decides what stays. */
export const adapterRecordSchema = z.strictObject({
  id: shortId,
  version: shortId.nullable(),
  classification: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
  fields: z.record(z.string().max(128), z.unknown()),
  acl: z.array(adapterGrantSchema).max(1000),
});
export type AdapterRecord = z.infer<typeof adapterRecordSchema>;

/** `GET {base}/streams/{stream}/records?limit=&cursor=&full=1`. */
export const adapterPageSchema = z.strictObject({
  records: z.array(adapterRecordSchema).max(1000),
  deleted: z.array(shortId).max(1000),
  next_cursor: z.string().min(1).max(8192).nullable(),
  has_more: z.boolean(),
});
export type AdapterPage = z.infer<typeof adapterPageSchema>;

/** `POST {base}/operations`, with the same key in the idempotency header and the body. */
export const adapterOperationRequestSchema = z.strictObject({
  tool: z.string().min(1).max(128),
  tool_version: z.string().min(1).max(32),
  idempotency_key: z.string().min(1).max(128),
  request_hash: z.string().min(1).max(128),
  payload: z.unknown(),
});
export type AdapterOperationRequest = z.infer<typeof adapterOperationRequestSchema>;

/** The answer to an operation, and to `GET {base}/operations/{idempotency_key}`. */
export const adapterOperationAnswerSchema = z.strictObject({
  status: z.enum(['applied', 'rejected']),
  operation_id: z.string().min(1).max(998).optional(),
});
export type AdapterOperationAnswer = z.infer<typeof adapterOperationAnswerSchema>;

/**
 * A signed note that something changed, sent to the connection's webhook endpoint. It only asks for a sync,
 * so a sender can never put data into Ensemus this way, even with a valid signature.
 */
export const adapterChangeNoticeSchema = z.strictObject({
  type: z.literal('records_changed'),
});

/** `GET {base}/notes/{external_id}`, for the meeting notes connector. Read only after consent. */
export const adapterNotesSchema = z.strictObject({
  version: shortId.nullable(),
  /** Plain text. Measured again against MAX_NOTES_BYTES where it is stored. */
  text: z.string().min(1).max(524_288),
});
export type AdapterNotes = z.infer<typeof adapterNotesSchema>;
