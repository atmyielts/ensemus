// Addresses are untrusted, and the error code in one reaches the page. Run here, because the web app
// has no test runner of its own.
import { describe, expect, it } from 'vitest';
import { messageFor } from '../../apps/web/src/lib/messages';
import { AppError } from '@ensemus/application';
import { OAUTH_ERROR_CODES } from '@ensemus/domain/workspace-suites';

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
  it('tells a busy tenant to try again, in the same words as the API, and never as a conflict', () => {
    const message = messageFor('TENANT_BUSY');
    expect(message).toBe(new AppError('TENANT_BUSY').message);
    expect(message).toContain('nothing was changed');
    expect(message).toContain('Try again');
    expect(message).not.toBe(messageFor('VERSION_CONFLICT'));
    expect(message).not.toContain('Someone else changed');
  });
  it('explains revoked exports consistently for source and permission changes', () => {
    const message = messageFor('EXPORT_SUPERSEDED');
    expect(message).toBe(new AppError('EXPORT_SUPERSEDED').message);
    expect(message.toLowerCase()).toContain('data or access changed');
    expect(message).toContain('new export');
  });
  it.each(OAUTH_ERROR_CODES)('words %s plainly, saying nothing was connected', (code) => {
    // A consent attempt shows these on the connections page and after the callback's redirect.
    const message = messageFor(code);
    expect(message).not.toBe(GENERIC);
    expect(message).toContain('nothing was connected');
    expect(message).not.toContain(code);
  });
});
