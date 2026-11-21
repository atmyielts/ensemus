import { beforeEach, describe, expect, it, vi } from 'vitest';

const queued: Record<string, unknown>[] = [];
let failNext = false;
vi.mock('@ensemus/database/auth', () => ({
  queueAccountMail: async (_db: unknown, input: Record<string, unknown>) => {
    if (failNext) {
      failNext = false;
      throw new Error('relation does not exist: ada@example.com');
    }
    queued.push(input);
  },
  clearMailSuppression: async () => undefined,
  reserveReauthentication: async () => true,
  revokeSessionAssurances: async () => undefined,
}));

const { accountMailSettings, verificationPurposeOf, ACCOUNT_MAIL_LINK_SCOPE } =
  await import('./account-mail');

const BASE = 'https://ensemus.example.com';
const sealedWith: { plaintext: string; secretId: string; organizationId: string }[] = [];
const settings = accountMailSettings({} as never, BASE, {
  seal: (input) => {
    sealedWith.push(input);
    return {
      keyId: 'k',
      wrappedKey: Buffer.alloc(1),
      iv: Buffer.alloc(1),
      ciphertext: Buffer.alloc(1),
      authTag: Buffer.alloc(1),
    };
  },
});
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'ada@example.com', name: 'Ada' };
const jwt = (payload: object) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`;

beforeEach(() => {
  queued.length = 0;
  sealedWith.length = 0;
});

describe('account mail settings', () => {
  it('queues a reset with its link sealed to the row, never the bare token', async () => {
    await settings.emailAndPassword.sendResetPassword({ user, token: 'reset-token-abc' });
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    expect(queued[0]).toMatchObject({
      kind: 'password_reset',
      userId: user.id,
      address: user.email,
    });
    expect(queued[0]!.idempotencyKey).toMatch(/^password_reset:[0-9a-f]{64}$/);
    expect(String(queued[0]!.idempotencyKey)).not.toContain('reset-token-abc');
    expect(sealedWith[0]).toMatchObject({
      organizationId: ACCOUNT_MAIL_LINK_SCOPE,
      secretId: queued[0]!.id,
      purpose: 'mail.link',
    });
    expect(JSON.parse(sealedWith[0]!.plaintext)).toEqual({
      link: `${BASE}/reset-password/reset-token-abc`,
    });
  });

  it('tells a new address apart from a first one', async () => {
    const moving = jwt({ email: 'old@example.com', requestType: 'change-email-verification' });
    await settings.emailVerification.sendVerificationEmail({
      user: { ...user, email: 'new@example.com' },
      token: moving,
    });
    await settings.emailVerification.sendVerificationEmail({
      user,
      token: jwt({ email: user.email }),
    });
    expect(queued.map((row) => [row.kind, row.address])).toEqual([
      ['email_change_verify', 'new@example.com'],
      ['email_verification', user.email],
    ]);
  });

  it('asks the old address first, naming the new one only inside the seal', async () => {
    await settings.changeEmail.sendChangeEmailConfirmation({
      user,
      newEmail: 'new@example.com',
      token: jwt({ requestType: 'change-email-confirmation' }),
    });
    expect(queued[0]).toMatchObject({ kind: 'email_change_confirm', address: user.email });
    expect(JSON.stringify(queued[0])).not.toContain('new@example.com');
    expect(JSON.parse(sealedWith[0]!.plaintext).newAddress).toBe('new@example.com');
  });

  it('never lets a queue failure change the answer, and never logs the address', async () => {
    failNext = true;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(
      settings.emailVerification.sendVerificationEmail({ user, token: jwt({}) }),
    ).resolves.toBeUndefined();
    const logged = write.mock.calls.map((call) => String(call[0])).join('');
    write.mockRestore();
    expect(logged).toContain('auth.mail_queue_failed');
    expect(logged).not.toContain('ada@example.com');
  });

  it('ends every session on a reset', () => {
    expect(settings.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
    expect(settings.emailAndPassword.resetPasswordTokenExpiresIn).toBe(30 * 60);
  });
});

describe('verification links', () => {
  it('say what they are for, for the words on the page', () => {
    expect(verificationPurposeOf(jwt({ requestType: 'change-email-confirmation' }))).toBe(
      'approve_change',
    );
    expect(verificationPurposeOf(jwt({ requestType: 'change-email-verification' }))).toBe(
      'finish_change',
    );
    expect(verificationPurposeOf(jwt({}))).toBe('verify');
    expect(verificationPurposeOf('not-a-jwt')).toBe('verify');
  });
});
