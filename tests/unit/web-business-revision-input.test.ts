import { describe, it, expect } from 'vitest';
import {
  businessRevisionFields,
  businessRevisionPayload,
} from '../../apps/web/src/lib/business-revision-input';
const tool = 'crm.record.update';
const payload = {
  record: { stream: 'crm.accounts', external_id: 'generated-source', expected_version: 'v1' },
  changes: { status: 'open', next_step: 'Call tomorrow' },
};
const values = (name: string, p: unknown) =>
  Object.fromEntries(
    (businessRevisionFields(name, p) ?? []).map((field) => [field.name, field.value]),
  );
describe('business proposal value revisions', () => {
  it('keeps the exact target/version and other proposed fields while changing one value', () => {
    expect(
      businessRevisionPayload(tool, payload, {
        ...values(tool, payload),
        'change.status': 'qualified',
        external_id: 'attacker-target',
        expected_version: 'v99',
      }),
    ).toEqual({ ...payload, changes: { ...payload.changes, status: 'qualified' } });
  });
  it('preserves the distinction between clearing a value and an empty string', () => {
    expect(
      businessRevisionPayload(tool, payload, {
        ...values(tool, payload),
        'clear.change.next_step': 'on',
      }),
    ).toMatchObject({ changes: { status: 'open', next_step: null } });
    expect(
      businessRevisionPayload(tool, payload, { ...values(tool, payload), 'change.next_step': '' }),
    ).toMatchObject({ changes: { next_step: '' } });
  });
  it('keeps a ticket note internal and rejects an empty replacement', () => {
    const note = {
      ticket: { external_id: 'generated-ticket' },
      visibility: 'internal',
      body: 'Earlier note',
    };
    expect(
      businessRevisionPayload('ticketing.comment.add', note, {
        body: 'A revised internal note',
        visibility: 'public',
      }),
    ).toEqual({ ...note, body: 'A revised internal note' });
    expect(businessRevisionPayload('ticketing.comment.add', note, { body: '   ' })).toBeNull();
  });
  it('preserves all invoice lines and decimal bytes, including optional terms', () => {
    const invoice = {
      customer_ref: 'generated-customer',
      currency: 'UZS',
      due_on: '2026-12-01',
      reference: 'Generated reference',
      memo: 'Generated memo',
      lines: Array.from({ length: 200 }, (_, i) => ({
        description: 'Generated line ' + i,
        quantity: '1.000000',
        unit_price: '999999999999999999.000001',
      })),
    };
    const next = businessRevisionPayload('accounting.invoice_draft.create', invoice, {
      ...values('accounting.invoice_draft.create', invoice),
      'line.199.description': 'Changed final line',
    });
    expect(next).toEqual({
      ...invoice,
      lines: invoice.lines.map((line, i) =>
        i === 199 ? { ...line, description: 'Changed final line' } : line,
      ),
    });
    expect(
      businessRevisionPayload('accounting.invoice_draft.create', invoice, {
        ...values('accounting.invoice_draft.create', invoice),
        'line.0.quantity': 'not-a-decimal',
      }),
    ).toBeNull();
  });
  it('refuses unsupported, malformed, oversized or read-only proposals', () => {
    expect(businessRevisionFields('email.send', payload)).toBeNull();
    expect(businessRevisionFields(tool, { ...payload, changes: { name: 'Read-only' } })).toBeNull();
    expect(
      businessRevisionPayload(tool, payload, {
        ...values(tool, payload),
        'change.status': 'x'.repeat(8001),
      }),
    ).toBeNull();
    expect(businessRevisionPayload(tool, payload, {})).toBeNull();
  });
});
