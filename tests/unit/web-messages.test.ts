// Addresses are untrusted, and the error code in one reaches the page. Run here, because the web app
// has no test runner of its own.
import { describe, expect, it } from 'vitest';
import { messageFor } from '../../apps/web/src/lib/messages';

const GENERIC = 'Something went wrong. Please try again.';

describe('wording for an error code from the address bar', () => {
  it('knows the codes it knows', () => {
    expect(messageFor('VERSION_CONFLICT')).toContain('Someone else changed this first');
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'treats inherited key %s as unknown, with text React can render',
    (code) => {
      expect(messageFor(code)).toBe(GENERIC);
    },
  );

  it('echoes nothing from an unknown code', () => {
    expect(messageFor('<b>pwned</b>')).toBe(GENERIC);
  });
});
