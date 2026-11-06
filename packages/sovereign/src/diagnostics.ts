// Owned by the diagnostics slice (SOV-06). See docs/06-delivery/m6-slices.md and ADR-030 D12. A diagnostic
// bundle is built from an allowlist: each field is a version, a count, a code or a hash. It is written out
// for a person to read first, and sealing it for someone outside needs their explicit approval. No code in
// this package can send anything, because lint refuses it any network at all.
import { z } from 'zod';

const code = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.int().min(0);

/**
 * Everything a bundle may hold, in a strict schema, so a new field is a reviewed change here and cannot
 * arrive by accident. No name, address, title, body, URL, credential or tenant name has a place in it.
 */
export const diagnosticReportSchema = z.strictObject({
  format: z.literal('ensemus.diagnostics'),
  format_version: z.literal(1),
  generated_at: z.iso.datetime({ offset: true }),
  release_version: code,
  images: z.array(z.strictObject({ name: code, digest: code })).max(64),
  database: z.strictObject({
    schema_version: code,
    reachable: z.boolean(),
    tenants: count,
  }),
  temporal: z.strictObject({ reachable: z.boolean() }),
  object_store: z.strictObject({ reachable: z.boolean() }),
  outbox: z.strictObject({ queued: count, dead: count, oldest_seconds: count }),
  ledger: z.strictObject({ queued: count, dead: count }),
  /** Which settings are present, by name, with a hash of the value. Never a value. */
  configuration: z.array(z.strictObject({ name: code, sha256: hash.nullable() })).max(256),
  /** How often each error code has appeared recently. Codes carry no text from anywhere. */
  error_codes: z.array(z.strictObject({ code, count })).max(512),
});
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;

/** What the customer agreed to, and it travels inside the sealed bundle so the receiver can see it. */
export const transferApprovalSchema = z.strictObject({
  approved_by: z.string().trim().min(1).max(200),
  approved_at: z.iso.datetime({ offset: true }),
  /** The hash of the exact report they read. A different report needs a new approval. */
  report_sha256: hash,
  recipient_key_id: z.string().regex(/^[0-9a-f]{32}$/),
});
export type TransferApproval = z.infer<typeof transferApprovalSchema>;

/** The report as a person reads it: every field, one per line, before anything leaves. */
export function renderReviewText(_report: DiagnosticReport): string {
  throw new Error('NOT_IMPLEMENTED');
}

export type SealRefusal = 'APPROVAL_MISSING' | 'APPROVAL_FOR_ANOTHER_REPORT' | 'REPORT_REFUSED';

/**
 * Seals a report for one recipient. Refuses with no approval, or with an approval of another report or
 * another recipient. The result is written to a file, and moving that file is the customer's own act.
 */
export function sealForTransfer(_input: {
  reportText: string;
  approval: TransferApproval | null;
  recipientPublicKey: string;
}): { ok: true; sealed: Buffer } | { ok: false; code: SealRefusal } {
  throw new Error('NOT_IMPLEMENTED');
}
