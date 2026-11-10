import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createVerifiedInteractiveIdentity,
  isVerifiedInteractiveIdentity,
} from './interactive-identity';

describe('native interactive identity handoff', () => {
  it('admits only the issued, frozen object', () => {
    const input = { userId: randomUUID(), sessionId: randomUUID() },
      identity = createVerifiedInteractiveIdentity(input);
    expect(identity).toMatchObject(input);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(isVerifiedInteractiveIdentity(identity)).toBe(true);
  });
  it('refuses JSON, object spread and caller-supplied symbol copies', () => {
    const identity = createVerifiedInteractiveIdentity({
      userId: randomUUID(),
      sessionId: randomUUID(),
    });
    for (const forged of [
      JSON.parse(JSON.stringify(identity)),
      { ...identity },
      Object.assign({}, identity),
      null,
      undefined,
    ])
      expect(isVerifiedInteractiveIdentity(forged)).toBe(false);
  });
  it('canonicalizes IDs and refuses an unbound or malformed session', () => {
    const userId = randomUUID().toUpperCase(),
      sessionId = randomUUID().toUpperCase();
    expect(createVerifiedInteractiveIdentity({ userId, sessionId })).toMatchObject({
      userId: userId.toLowerCase(),
      sessionId: sessionId.toLowerCase(),
    });
    expect(() => createVerifiedInteractiveIdentity({ userId, sessionId: 'body-session' })).toThrow(
      'INVALID_VERIFIED_SESSION_IDENTITY',
    );
    expect(() => createVerifiedInteractiveIdentity({ userId: '', sessionId })).toThrow(
      'INVALID_VERIFIED_SESSION_IDENTITY',
    );
  });
});
