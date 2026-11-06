// ADR-030 D12: what a report may hold, what a person reads, and what a transfer needs.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  diagnosticReportSchema,
  openTransfer,
  renderReviewText,
  reportSha256,
  sealForTransfer,
  serializeReport,
  type DiagnosticReport,
  type TransferApproval,
} from './diagnostics';
import {
  exportRecipientPublicKey,
  generateRecipientKeyPair,
  recipientKeyId,
  seal,
  sealedRecipientId,
} from './sealed';

const report: DiagnosticReport = {
  format: 'ensemus.diagnostics',
  format_version: 1,
  generated_at: '2027-02-03T04:05:06.000Z',
  release_version: '2.0.1',
  images: [
    { name: 'web', digest: `sha256:${'a'.repeat(64)}` },
    { name: 'worker', digest: `sha256:${'b'.repeat(64)}` },
  ],
  database: { schema_version: '0301_sovereign_security', reachable: true, tenants: 7 },
  temporal: { reachable: true },
  object_store: { reachable: false },
  outbox: { queued: 11, dead: 13, oldest_seconds: 17 },
  ledger: { queued: 19, dead: 23 },
  configuration: [
    { name: 'ENSEMUS_MODE', sha256: 'c'.repeat(64) },
    { name: 'TEMPORAL_NAMESPACE', sha256: null },
  ],
  error_codes: [{ code: 'outbox.dead:work.execution_requested', count: 29 }],
};
const reportText = serializeReport(report);

const pair = () => {
  const { publicKey, privateKey } = generateRecipientKeyPair();
  return { publicKey, privateKey, base64: exportRecipientPublicKey(publicKey) };
};
const recipient = pair();

const approvalFor = (text: string, keyId = recipientKeyId(recipient.publicKey)) =>
  ({
    approved_by: 'Generated Operator',
    approved_at: '2027-02-03T05:00:00.000Z',
    report_sha256: reportSha256(text),
    recipient_key_id: keyId,
  }) satisfies TransferApproval;

describe('what a report may hold', () => {
  it('takes every kind of value it is meant to', () => {
    expect(diagnosticReportSchema.safeParse(report).success).toBe(true);
    const unreleased = { ...report, release_version: 'unreleased' };
    expect(diagnosticReportSchema.safeParse(unreleased).success).toBe(true);
  });

  it('refuses a field nobody reviewed, at every level', () => {
    for (const changed of [
      { ...report, tenant_name: 'Acme' },
      { ...report, database: { ...report.database, tenant_name: 'Acme' } },
      { ...report, images: [{ ...report.images[0], note: 'Acme' }] },
      { ...report, configuration: [{ name: 'ENSEMUS_MODE', sha256: null, value: 'cloud' }] },
    ]) {
      expect(diagnosticReportSchema.safeParse(changed).success).toBe(false);
    }
  });

  it.each([
    ['a sentence where a code goes', { release_version: 'Quarterly review for Acme' }],
    ['an address where a code goes', { release_version: 'someone@example.invalid' }],
    ['a value where a hash goes', { configuration: [{ name: 'A', sha256: 'cloud' }] }],
    ['a negative count', { outbox: { queued: -1, dead: 0, oldest_seconds: 0 } }],
    ['a fraction', { ledger: { queued: 0.5, dead: 0 } }],
    ['free text where a time goes', { generated_at: 'yesterday' }],
  ])('refuses %s', (_label, change) => {
    expect(diagnosticReportSchema.safeParse({ ...report, ...change }).success).toBe(false);
  });
});

describe('what a person reads', () => {
  const text = renderReviewText(report);

  it('lists every field, one per line', () => {
    for (const line of [
      'format: ensemus.diagnostics',
      'format_version: 1',
      'generated_at: 2027-02-03T04:05:06.000Z',
      'release_version: 2.0.1',
      'images[0].name: web',
      `images[1].digest: sha256:${'b'.repeat(64)}`,
      'database.schema_version: 0301_sovereign_security',
      'database.reachable: true',
      'database.tenants: 7',
      'temporal.reachable: true',
      'object_store.reachable: false',
      'outbox.queued: 11',
      'outbox.dead: 13',
      'outbox.oldest_seconds: 17',
      'ledger.queued: 19',
      'ledger.dead: 23',
      'configuration[0].name: ENSEMUS_MODE',
      `configuration[0].sha256: ${'c'.repeat(64)}`,
      'configuration[1].sha256: (not set)',
      'error_codes[0].code: outbox.dead:work.execution_requested',
      'error_codes[0].count: 29',
    ]) {
      expect(text.split('\n')).toContain(line);
    }
  });

  it('shows an empty list as empty, and says when a count is only a zero for not knowing', () => {
    const quiet = renderReviewText({
      ...report,
      images: [],
      database: { schema_version: 'image:0013_x', reachable: false, tenants: 0 },
    });
    expect(quiet.split('\n')).toContain('images: (none)');
    expect(quiet).toContain('did not answer');
    expect(quiet).toContain('last migration this image ships');
    expect(text).not.toContain('did not answer');
  });

  it('will not show something a report could not hold', () => {
    expect(() =>
      renderReviewText({ ...report, release_version: 'Quarterly review for Acme' }),
    ).toThrow();
  });
});

describe('sealing for someone outside', () => {
  it('seals with the approval inside, for only that recipient to read', () => {
    const result = sealForTransfer({
      reportText,
      approval: approvalFor(reportText),
      recipientPublicKey: recipient.base64,
    });
    if (!result.ok) throw new Error(result.code);

    expect(sealedRecipientId(result.sealed)).toBe(recipientKeyId(recipient.publicKey));
    const opened = openTransfer(result.sealed, recipient.privateKey);
    expect(opened).toMatchObject({ ok: true, reportText, report });
    if (opened.ok) expect(opened.approval.approved_by).toBe('Generated Operator');

    expect(openTransfer(result.sealed, pair().privateKey)).toEqual({
      ok: false,
      code: 'NOT_OPENED',
    });
  });

  it('refuses with no approval', () => {
    expect(
      sealForTransfer({ reportText, approval: null, recipientPublicKey: recipient.base64 }),
    ).toEqual({ ok: false, code: 'APPROVAL_MISSING' });
  });

  it('refuses an approval nobody put a name to', () => {
    expect(
      sealForTransfer({
        reportText,
        approval: { ...approvalFor(reportText), approved_by: '   ' },
        recipientPublicKey: recipient.base64,
      }),
    ).toEqual({ ok: false, code: 'APPROVAL_MISSING' });
  });

  it('refuses an approval of another report', () => {
    const other = serializeReport({ ...report, release_version: '2.0.2' });
    expect(
      sealForTransfer({
        reportText,
        approval: approvalFor(other),
        recipientPublicKey: recipient.base64,
      }),
    ).toEqual({ ok: false, code: 'APPROVAL_FOR_ANOTHER_REPORT' });
  });

  it('refuses an approval for another recipient', () => {
    expect(
      sealForTransfer({
        reportText,
        approval: approvalFor(reportText, recipientKeyId(pair().publicKey)),
        recipientPublicKey: recipient.base64,
      }),
    ).toEqual({ ok: false, code: 'APPROVAL_FOR_ANOTHER_RECIPIENT' });
  });

  it('refuses a recipient key that is not an X25519 public key', () => {
    const signing = generateKeyPairSync('ed25519').publicKey.export({
      type: 'spki',
      format: 'der',
    });
    for (const recipientPublicKey of ['not a key', signing.toString('base64')]) {
      expect(
        sealForTransfer({ reportText, approval: approvalFor(reportText), recipientPublicKey }),
      ).toEqual({ ok: false, code: 'RECIPIENT_REFUSED' });
    }
  });

  it.each([
    ['a field added', JSON.stringify({ ...report, tenant_name: 'Acme' })],
    ['a value that does not fit', reportText.replace('2.0.1', 'A B')],
    ['something that is not JSON', 'Acme quarterly review'],
    ['the same report spaced to hide something', reportText.replace('{', '{ \t ')],
    [
      'a repeated key, which parsing would drop',
      reportText.replace('{', '{\n  "release_version": "HiddenFromTheReader",'),
    ],
  ])('refuses a report with %s, even when the approval names it', (_label, text) => {
    expect(
      sealForTransfer({
        reportText: text,
        approval: approvalFor(text),
        recipientPublicKey: recipient.base64,
      }),
    ).toEqual({ ok: false, code: 'REPORT_REFUSED' });
  });
});

describe('what a receiver checks', () => {
  // Anyone with the public key can seal, so a receiver cannot take the sender's tool on trust.
  const forge = (inner: object) => seal(Buffer.from(JSON.stringify(inner)), recipient.publicKey);
  const transfer = {
    format: 'ensemus.diagnostic_transfer',
    format_version: 1,
    approval: approvalFor(reportText),
    report: reportText,
  };

  it('accepts what the approval names', () => {
    expect(openTransfer(forge(transfer), recipient.privateKey).ok).toBe(true);
  });

  it.each([
    [
      'an approval of other bytes',
      { ...transfer, approval: approvalFor(reportText.replace('2.0.1', '9.9.9')) },
    ],
    [
      'an approval for another key',
      { ...transfer, approval: approvalFor(reportText, recipientKeyId(pair().publicKey)) },
    ],
    ['a field added to what was sealed', { ...transfer, note: 'Acme' }],
    ['a newer format', { ...transfer, format_version: 2 }],
  ])('refuses %s', (_label, inner) => {
    expect(openTransfer(forge(inner), recipient.privateKey)).toEqual({
      ok: false,
      code: 'TRANSFER_REFUSED',
    });
  });

  it('refuses a report with a field added, even when the approval names it', () => {
    const text = JSON.stringify({ ...report, tenant_name: 'Acme' });
    const inner = { ...transfer, report: text, approval: approvalFor(text) };
    expect(openTransfer(forge(inner), recipient.privateKey)).toEqual({
      ok: false,
      code: 'TRANSFER_REFUSED',
    });
  });
});
