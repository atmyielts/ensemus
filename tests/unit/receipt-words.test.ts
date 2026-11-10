// CONNECT-06: unknown never looks like success or failure, in any word a person can be shown. These are
// the words themselves, so a page cannot pick up a softer sentence somewhere else.
import { EXTERNAL_ACTION_CODES, EXTERNAL_ACTION_STATUSES } from '@ensemus/domain/external-action';
import { describe, expect, it } from 'vitest';
import {
  basisWords,
  messageIdHint,
  outcomeWords,
  REASON_CODES,
  reasonWords,
  statusExplanation,
  statusWords,
  UNKNOWN_LABEL,
} from '../../apps/web/src/components/receipt-words';

describe('how an external action is described', () => {
  it('has its own label and tone for unknown, shared with nothing else', () => {
    const unknown = statusWords({ status: 'unknown' });
    expect(unknown.label).toBe("We don't know whether this was sent");
    expect(unknown.tone).toBe('unknown');
    for (const status of EXTERNAL_ACTION_STATUSES.filter((s) => s !== 'unknown')) {
      const other = statusWords({ status });
      expect(other.label).not.toBe(unknown.label);
      expect(other.tone).not.toBe('unknown');
    }
  });

  it('keeps the success and failure tones away from unknown, whatever its reason says', () => {
    for (const code of EXTERNAL_ACTION_CODES) {
      const words = statusWords({ status: 'unknown', statusReason: code, resolvedByName: 'Ana' });
      expect(words.label).toBe(UNKNOWN_LABEL);
      expect(['done', 'bad']).not.toContain(words.tone);
    }
  });

  it('says what to do next for unknown, and offers no sending', () => {
    const sentence = statusExplanation({ status: 'unknown' });
    expect(sentence).toContain('Message-ID');
    expect(sentence).toContain('say what you found');
    expect(sentence).toContain('will not try again by itself');
    expect(sentence).not.toMatch(/\b(retry|resend|send again)\b/i);
  });

  it('says plainly that sent is not delivered', () => {
    expect(statusExplanation({ status: 'sent' })).toContain('not the same as reaching an inbox');
    expect(statusWords({ status: 'sent' }).label).toBe('Sent');
  });

  it('names whose word it was when a person decided, in both directions', () => {
    const sent = { status: 'sent', statusReason: 'PERSON_CONFIRMED_SENT', resolvedByName: 'Ana' };
    expect(statusWords(sent).label).toBe('Sent: confirmed by Ana');
    expect(statusExplanation(sent)).toContain('rests on what Ana said');
    const notSent = {
      status: 'failed',
      statusReason: 'PERSON_CONFIRMED_NOT_SENT',
      resolvedByName: 'Ana',
    };
    expect(statusWords(notSent).label).toBe('Not sent: confirmed by Ana');
    expect(statusExplanation(notSent)).toContain('new approval');
  });

  it('says only "a person" in a list that does not carry the name', () => {
    expect(statusWords({ status: 'sent', statusReason: 'PERSON_CONFIRMED_SENT' }).label).toBe(
      'Sent: confirmed by a person',
    );
  });

  it('gives a failure its reason in words, and asks for a new approval', () => {
    const sentence = statusExplanation({ status: 'failed', statusReason: 'RECIPIENT_REFUSED' });
    expect(sentence).toContain('refused a recipient');
    expect(sentence).toContain('new approval');
    expect(sentence).not.toContain('  ');
  });

  it('has words for every reason code, and for none that do not exist', () => {
    expect([...REASON_CODES].sort()).toEqual([...EXTERNAL_ACTION_CODES].sort());
  });

  it('does not answer for keys that are not reasons', () => {
    expect(reasonWords('constructor')).toBe('No more detail was recorded.');
    expect(reasonWords(null)).toBeNull();
  });

  it('says on whose word each receipt rests', () => {
    expect(basisWords('person', 'Ana')).toContain('Ana');
    expect(basisWords('provider', null)).toContain('mail server');
    expect(basisWords('reconciliation', null)).toContain('asked afterwards');
    expect(basisWords('system', null)).toContain('nothing was sent');
    expect(outcomeWords('unknown')).toBe(UNKNOWN_LABEL);
  });

  it('never shows an unrecognized status as settled', () => {
    expect(statusWords({ status: 'nearly' }).tone).toBe('attention');
    expect(statusExplanation({ status: 'nearly' })).toContain('Do not rely');
  });

  it('gives the Message-ID to search for, or the part of it that is always known', () => {
    const id = '6f1c2c6e-1111-4111-8111-111111111111';
    expect(messageIdHint({ id, externalId: `<${id}@mail.example.invalid>` })).toEqual({
      value: `<${id}@mail.example.invalid>`,
      whole: true,
    });
    expect(messageIdHint({ id, externalId: null })).toEqual({ value: `<${id}@`, whole: false });
  });
});
