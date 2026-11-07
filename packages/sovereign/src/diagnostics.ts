// Owned by the diagnostics slice (SOV-06). See docs/06-delivery/m6-slices.md and ADR-030 D12. A diagnostic
// bundle is built from an allowlist: each field is a version, a count, a code or a hash. It is written out
// for a person to read first, and sealing it for someone outside needs their explicit approval. No code in
// this package can send anything, because lint refuses it any network at all.
import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import {
  open as openSealed,
  parseRecipientPublicKey,
  recipientKeyId,
  seal,
  SealedRefused,
} from './sealed';

// May start with a digit, because a release (`2.0.0`) and a migration (`0301_sovereign_security`) both do.
const code = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
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

/** What is sealed: the report's exact bytes as a string, and the approval that names them. */
const transferSchema = z.strictObject({
  format: z.literal('ensemus.diagnostic_transfer'),
  format_version: z.literal(1),
  approval: transferApprovalSchema,
  report: z.string(),
});

export const reportSha256 = (reportText: string) =>
  createHash('sha256').update(reportText, 'utf8').digest('hex');

/**
 * The one spelling of a report, which `collect` writes and `seal` insists on. JSON has room to hide things
 * from a reader, in whitespace or in a repeated key that parsing drops, and the approval covers exact bytes,
 * so only this form may be sealed.
 */
export const serializeReport = (report: DiagnosticReport) => `${JSON.stringify(report, null, 2)}\n`;

function linesOf(prefix: string, value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}: (none)`];
    return value.flatMap((item, index) => linesOf(`${prefix}[${index}]`, item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      linesOf(prefix ? `${prefix}.${key}` : key, item),
    );
  }
  return [`${prefix}: ${value === null ? '(not set)' : String(value)}`];
}

/**
 * The report as a person reads it: every field, one per line, before anything leaves. It walks the report
 * rather than naming fields, so a field added to the schema cannot be left out of what they read. It takes
 * nothing the schema would refuse, so nothing can be shown here that a report could not hold.
 */
export function renderReviewText(report: DiagnosticReport): string {
  const checked = diagnosticReportSchema.parse(report);
  const notes = [
    ...(checked.database.reachable
      ? []
      : ['The database did not answer, so its counts below are zero because they are unknown.']),
    ...(checked.database.schema_version.startsWith('image:')
      ? ['schema_version names the last migration this image ships, not what the database ran.']
      : []),
  ];
  return [
    'Ensemus diagnostic report. Read every line below before you approve sending it to anyone.',
    'It holds versions, counts, codes and hashes. Nothing has left this machine, and nothing here sends it.',
    ...notes,
    '',
    ...linesOf('', checked),
    '',
  ].join('\n');
}

export type SealRefusal =
  | 'APPROVAL_MISSING'
  | 'APPROVAL_FOR_ANOTHER_REPORT'
  | 'APPROVAL_FOR_ANOTHER_RECIPIENT'
  | 'RECIPIENT_REFUSED'
  | 'REPORT_REFUSED';

/**
 * Seals a report for one recipient. Refuses with no approval, or with an approval of another report or
 * another recipient. The result is written to a file, and moving that file is the customer's own act.
 */
export function sealForTransfer(input: {
  reportText: string;
  approval: TransferApproval | null;
  recipientPublicKey: string;
}): { ok: true; sealed: Buffer } | { ok: false; code: SealRefusal } {
  const approval = transferApprovalSchema.safeParse(input.approval);
  if (!approval.success) return { ok: false, code: 'APPROVAL_MISSING' };

  let raw: unknown;
  try {
    raw = JSON.parse(input.reportText);
  } catch {
    return { ok: false, code: 'REPORT_REFUSED' };
  }
  const report = diagnosticReportSchema.safeParse(raw);
  if (!report.success || serializeReport(report.data) !== input.reportText) {
    return { ok: false, code: 'REPORT_REFUSED' };
  }
  if (approval.data.report_sha256 !== reportSha256(input.reportText)) {
    return { ok: false, code: 'APPROVAL_FOR_ANOTHER_REPORT' };
  }

  let recipient: KeyObject;
  try {
    recipient = parseRecipientPublicKey(input.recipientPublicKey);
  } catch {
    return { ok: false, code: 'RECIPIENT_REFUSED' };
  }
  if (approval.data.recipient_key_id !== recipientKeyId(recipient)) {
    return { ok: false, code: 'APPROVAL_FOR_ANOTHER_RECIPIENT' };
  }

  const transfer: z.infer<typeof transferSchema> = {
    format: 'ensemus.diagnostic_transfer',
    format_version: 1,
    approval: approval.data,
    report: input.reportText,
  };
  return { ok: true, sealed: seal(Buffer.from(JSON.stringify(transfer)), recipient) };
}

/**
 * What the receiver does. Opens a transfer and checks that the approval inside names these exact bytes and
 * this key, so anyone holding a report can see what its sender agreed to. Sealing proves who can read it,
 * not who wrote it (ADR-030 D6), so this says nothing about who `approved_by` really is.
 */
export function openTransfer(
  sealed: Buffer,
  recipientPrivateKey: KeyObject,
):
  | { ok: true; approval: TransferApproval; report: DiagnosticReport; reportText: string }
  | { ok: false; code: 'NOT_OPENED' | 'TRANSFER_REFUSED' } {
  let plain: Buffer;
  try {
    plain = openSealed(sealed, recipientPrivateKey);
  } catch (error) {
    if (error instanceof SealedRefused) return { ok: false, code: 'NOT_OPENED' };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(plain.toString('utf8'));
  } catch {
    return { ok: false, code: 'TRANSFER_REFUSED' };
  }
  const transfer = transferSchema.safeParse(raw);
  if (!transfer.success) return { ok: false, code: 'TRANSFER_REFUSED' };
  const { approval, report: reportText } = transfer.data;

  let report: DiagnosticReport;
  try {
    report = diagnosticReportSchema.parse(JSON.parse(reportText));
  } catch {
    return { ok: false, code: 'TRANSFER_REFUSED' };
  }
  const named =
    approval.report_sha256 === reportSha256(reportText) &&
    approval.recipient_key_id === recipientKeyId(createPublicKey(recipientPrivateKey));
  return named
    ? { ok: true, approval, report, reportText }
    : { ok: false, code: 'TRANSFER_REFUSED' };
}
