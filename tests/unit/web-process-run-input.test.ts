import { describe, expect, it } from 'vitest';
import {
  readRunStart,
  readRunEmail,
  runFormValues,
  runVersion,
  runId,
} from '../../apps/web/src/lib/process-run-input';
import {
  runCodeText,
  runCostText,
  stepStatusText,
} from '../../apps/web/src/lib/process-run-present';
const id = 'a1000000-0000-4000-8000-00000000000b';
function form(values: Record<string, string>) {
  const value = new FormData();
  for (const [k, v] of Object.entries(values)) value.set(k, v);
  return value;
}
describe('workflow native form input and truthful copy', () => {
  it('keeps an optional due day at actual UTC midnight', () => {
    expect(
      readRunStart(form({ specId: id, title: '  Review work  ', dueAt: '2028-02-29' })),
    ).toEqual({ spec_id: id, title: 'Review work', due_at: '2028-02-29T00:00:00.000Z' });
    expect(readRunStart(form({ specId: id, title: 'Work' }))).toEqual({
      spec_id: id,
      title: 'Work',
    });
  });
  it.each(['2026-02-29', '2026-02-31', '2026-13-01', '08/11/2026'])(
    'refuses invalid calendar day %s',
    (dueAt) => {
      expect(() => readRunStart(form({ specId: id, title: 'Work', dueAt }))).toThrow();
    },
  );
  it('refuses duplicate choice values, forged identifiers and unsafe versions', () => {
    const value = form({ specId: id, title: 'Work' });
    value.append('specId', id);
    expect(() => readRunStart(value)).toThrow();
    expect(() => runId(form({ id: 'https://example.invalid' }), 'id')).toThrow();
    expect(runId(form({ id: id.toUpperCase() }), 'id')).toBe(id);
    for (const version of ['0', '1.2', '9007199254740992', '2e2'])
      expect(() => runVersion(form({ version }))).toThrow();
  });
  it('validates the exact proposed recipients and preserves the words on refusal', () => {
    const value = form({
      requestKey: id,
      to: 'one@example.invalid, two@example.invalid',
      subject: 'Generated proposal',
      textBody: 'Generated private words',
    });
    expect(readRunEmail(value)).toEqual({
      to: ['one@example.invalid', 'two@example.invalid'],
      subject: 'Generated proposal',
      textBody: 'Generated private words',
    });
    expect(runFormValues(value, 'email').textBody).toBe('Generated private words');
    expect(() =>
      readRunEmail(form({ to: 'not-an-address', subject: 'Proposal', textBody: 'Words' })),
    ).toThrow();
  });
  it('refuses an email whose encoded payload exceeds the actual M3 byte bound', () => {
    expect(() =>
      readRunEmail(
        form({
          to: 'one@example.invalid',
          subject: 'Generated proposal',
          textBody: '🙂'.repeat(70000),
        }),
      ),
    ).toThrow();
  });
  it('does not turn an unknown or private technical code into primary copy', () => {
    const privateCode = 'provider says private details';
    expect(runCodeText(privateCode)).not.toContain(privateCode);
    expect(runCodeText('ROOT_CONFIRMATION_REQUIRED')).toContain('accountable owner');
    expect(runCodeText('EXTERNAL_ACTION_UNKNOWN')).toContain('do not send');
    expect(stepStatusText('skipped')).toBe('Not performed');
  });
  it('does not turn absent measurements into free usage', () => {
    expect(runCostText(null)).toMatch(/not measured|not available/);
    expect(runCostText({ costMicros: 0, isEstimate: false })).toMatch(/Recorded cost.*USD 0/);
    expect(runCostText({ costMicros: 1234, isEstimate: true })).toContain('Estimate');
  });
});
