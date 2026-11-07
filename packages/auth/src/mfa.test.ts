import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createMfaOperations, mfaPlugins, MFA_PRIVATE_PATHS, type MfaDependencies } from './mfa';
import { mfaReplayRows } from './mfa-admission';

const code = '123456';
function fixture() {
  const session = { sessionId: randomUUID(), userId: randomUUID() };
  const factorId = randomUUID();
  const requests: Request[] = [];
  const controls = {
    status: 200,
    enrolled: true,
    expired: false,
    malformed: false,
    actualUser: session.userId,
    actualSession: session.sessionId,
  };
  const record = vi.fn(async () => {}),
    admit = vi.fn(async () => true);
  const handler = async (request: Request) => {
    requests.push(request);
    if (new URL(request.url).pathname.endsWith('/get-session'))
      return Response.json({
        session: {
          id: controls.actualSession,
          userId: controls.actualUser,
          expiresAt: new Date(Date.now() + (controls.expired ? -60000 : 60000)).toISOString(),
        },
        user: { id: controls.actualUser, twoFactorEnabled: controls.enrolled },
      });
    return Response.json(
      controls.malformed
        ? {}
        : {
            user: { id: controls.actualUser, twoFactorEnabled: controls.enrolled },
            token: 'not-an-assurance',
          },
      { status: controls.status },
    );
  };
  const deps: MfaDependencies = {
    baseURL: 'https://ensemus.example.invalid',
    enrollmentState: vi.fn(async () => 'pending' as const),
    handler,
    managementHandler: handler,
    record,
    reserveAttempt: vi.fn(async () => ({ outcome: 'reserved' as const, factorId })),
    admit,
    revoke: vi.fn(async () => {}),
    prepareEnrollment: vi.fn(async () => 'opaque-primary-binding'),
    recordEnrollment: vi.fn(async () => true),
    enrollmentCurrent: vi.fn(async () => true),
    enrollmentCurrentAfterRotation: vi.fn(async () => true),
    completePrimaryAfterFactor: vi.fn(async () => true),
  };
  return {
    session,
    factorId,
    requests,
    controls,
    record,
    admit,
    deps,
    operations: createMfaOperations(deps),
    headers: new Headers({
      cookie: 'auth=opaque',
      'x-forwarded-for': '192.0.2.1',
      'user-agent': 'Synthetic test',
      authorization: 'never forward',
      'x-session-id': 'forged',
    }),
  };
}
describe('MFA router boundary and session-bound recent proof', () => {
  it('requires the protected IdP bridge after actual factor and replay admission before forwarding a new session', async () => {
    const f = fixture(),
      original = f.deps.handler;
    let authenticated = false;
    f.deps.handler = async (request) => {
      if (new URL(request.url).pathname.endsWith('/get-session') && !authenticated)
        return Response.json(null);
      if (request.method === 'POST') {
        authenticated = true;
        return Response.json(
          { user: { id: f.session.userId } },
          { headers: { 'set-cookie': 'auth=actual-new-session; HttpOnly' } },
        );
      }
      return original(request);
    };
    f.deps.completePrimaryAfterFactor = vi.fn(async () => false);
    const result = await createMfaOperations(f.deps).completeSignIn(
      { kind: 'totp', code },
      f.headers,
    );
    expect(result).toMatchObject({ outcome: 'primary_required', setCookie: null });
    expect(f.admit).toHaveBeenCalledOnce();
    expect(f.deps.completePrimaryAfterFactor).toHaveBeenCalledWith({
      ...f.session,
      headers: f.headers,
    });
    expect(f.record).not.toHaveBeenCalled();
  });
  it('rechecks enrollment authority against the actual rotated session before forwarding its cookie or minting proof', async () => {
    const f = fixture(),
      rotated = randomUUID();
    f.controls.enrolled = false;
    const original = f.deps.handler;
    f.deps.handler = async (request) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/verify-totp')) {
        f.controls.actualSession = rotated;
        f.controls.enrolled = true;
        return Response.json(
          { user: { id: f.session.userId } },
          { headers: { 'set-cookie': 'auth=rotated; HttpOnly' } },
        );
      }
      return original(request);
    };
    f.deps.enrollmentCurrentAfterRotation = vi.fn(async () => false);
    const result = await createMfaOperations(f.deps).confirmEnrollment(
      { code, maxAgeSeconds: 60 },
      f.session,
      f.headers,
    );
    expect(result).toMatchObject({ outcome: 'primary_required', setCookie: null });
    expect(f.deps.enrollmentCurrentAfterRotation).toHaveBeenCalledWith({
      ...f.session,
      resultingSessionId: rotated,
      maxAgeSeconds: 60,
    });
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
  it('installs confirmed TOTP with encrypted recovery codes and closes factor mutation routes publicly', () => {
    expect(mfaPlugins().some((plugin) => plugin.id === 'two-factor')).toBe(true);
    expect(MFA_PRIVATE_PATHS).toEqual(
      expect.arrayContaining([
        '/two-factor/disable',
        '/two-factor/generate-backup-codes',
        '/two-factor/get-totp-uri',
        '/two-factor/view-backup-codes',
      ]),
    );
  });
  it('refuses malformed codes without contacting auth or admitting a replay row', async () => {
    const value = fixture();
    for (const bad of ['', '12345', '1234567', '123456\n', '<script>'])
      expect(
        await value.operations.verifyStepUp(
          { kind: 'totp', code: bad },
          value.session,
          value.headers,
        ),
      ).toBe('refused');
    expect(value.requests).toHaveLength(0);
    expect(value.admit).not.toHaveBeenCalled();
    expect(value.record).not.toHaveBeenCalled();
  });
  it('verifies through the router, forwards only own-origin/cookie/limit headers and records the actual session', async () => {
    const value = fixture();
    expect(
      await value.operations.verifyStepUp({ kind: 'totp', code }, value.session, value.headers),
    ).toBe('verified');
    const request = value.requests.find((request) => request.method === 'POST')!;
    expect(request.url).toBe('https://ensemus.example.invalid/api/auth/two-factor/verify-totp');
    expect(await request.json()).toEqual({ code, trustDevice: false });
    expect(request.headers.get('cookie')).toBe('auth=opaque');
    expect(request.headers.get('origin')).toBe('https://ensemus.example.invalid');
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('x-session-id')).toBe(false);
    expect(value.admit).toHaveBeenCalledWith({
      userId: value.session.userId,
      kind: 'mfa_totp',
      code,
    });
    expect(value.record).toHaveBeenCalledExactlyOnceWith({
      ...value.session,
      kind: 'mfa_totp',
      factorId: value.factorId,
    });
  });
  it('uses backup-code router verification with no trusted-device/session-suppression shortcut', async () => {
    const value = fixture();
    expect(
      await value.operations.verifyStepUp(
        { kind: 'backup_code', code: 'abcde-12345' },
        value.session,
        value.headers,
      ),
    ).toBe('verified');
    const request = value.requests.find((request) => request.method === 'POST')!;
    expect(request.url).toContain('/verify-backup-code');
    expect(await request.json()).toEqual({ code: 'abcde-12345', trustDevice: false });
    expect(value.record).toHaveBeenCalledWith({
      ...value.session,
      kind: 'mfa_backup_code',
      factorId: value.factorId,
    });
  });
  it.each([400, 401, 403, 429, 500])(
    'does not admit or record a rejected code (HTTP %i)',
    async (status) => {
      const value = fixture();
      value.controls.status = status;
      expect(
        await value.operations.verifyStepUp({ kind: 'totp', code }, value.session, value.headers),
      ).toBe(status === 429 ? 'rate_limited' : 'refused');
      expect(value.admit).not.toHaveBeenCalled();
      expect(value.record).not.toHaveBeenCalled();
    },
  );
  it('does not accept a success status without the verified identity response', async () => {
    const value = fixture();
    value.controls.malformed = true;
    expect(
      await value.operations.verifyStepUp({ kind: 'totp', code }, value.session, value.headers),
    ).toBe('refused');
    expect(value.record).not.toHaveBeenCalled();
  });
  it.each(['person', 'session', 'expired', 'disabled'] as const)(
    'refuses another/invalid current %s before checking the code',
    async (kind) => {
      const value = fixture();
      if (kind === 'person') value.controls.actualUser = randomUUID();
      if (kind === 'session') value.controls.actualSession = randomUUID();
      if (kind === 'expired') value.controls.expired = true;
      if (kind === 'disabled') value.controls.enrolled = false;
      expect(
        await value.operations.verifyStepUp({ kind: 'totp', code }, value.session, value.headers),
      ).not.toBe('verified');
      expect(value.requests.some((request) => request.method === 'POST')).toBe(false);
      expect(value.record).not.toHaveBeenCalled();
    },
  );
  it('refuses a code already admitted by another session or replica', async () => {
    const value = fixture();
    value.admit.mockResolvedValue(false);
    expect(
      await value.operations.verifyStepUp({ kind: 'totp', code }, value.session, value.headers),
    ).toBe('refused');
    expect(value.record).not.toHaveBeenCalled();
  });
  it.each(['locked', 'not_enrolled'] as const)(
    'refuses account attempt admission %s before opening the verification router',
    async (outcome) => {
      const value = fixture();
      vi.spyOn(value.deps, 'reserveAttempt').mockResolvedValue({ outcome });
      expect(
        await value.operations.verifyStepUp({ kind: 'totp', code }, value.session, value.headers),
      ).toBe(outcome === 'locked' ? 'rate_limited' : 'not_enrolled');
      expect(value.requests.some((request) => request.method === 'POST')).toBe(false);
      expect(value.record).not.toHaveBeenCalled();
    },
  );
  it('fails closed if writing trusted proof fails', async () => {
    const value = fixture();
    value.record.mockRejectedValue(new Error('SYNTHETIC_AUTH_UNAVAILABLE'));
    await expect(
      value.operations.verifyStepUp({ kind: 'totp', code }, value.session, value.headers),
    ).rejects.toThrow('SYNTHETIC_AUTH_UNAVAILABLE');
  });
  it('revokes old factor proofs before confirming a replacement, even if its code is refused', async () => {
    const value = fixture();
    value.controls.enrolled = false;
    value.controls.status = 401;
    expect(
      (await value.operations.confirmEnrollment({ code }, value.session, value.headers)).outcome,
    ).toBe('refused');
    expect(value.deps.revoke).toHaveBeenCalledExactlyOnceWith(value.session.userId);
    expect(value.record).not.toHaveBeenCalled();
  });
  it.each([
    { status: 500, problem: 'INTERNAL_SERVER_ERROR', outcome: 'setup_conflict' },
    { status: 400, problem: 'TOTP_ALREADY_ENABLED', outcome: 'already_enrolled' },
    { status: 400, problem: 'INVALID_PASSWORD', outcome: 'refused' },
  ] as const)(
    'classifies setup refusal $problem without returning secret material',
    async ({ status, problem, outcome }) => {
      const value = fixture();
      value.deps.managementHandler = async () => Response.json({ code: problem }, { status });
      const result = await value.operations.enable(
        { password: 'generated-primary-password' },
        value.session,
        value.headers,
      );
      expect(result).toEqual({ outcome, setCookie: null });
      expect(value.deps.recordEnrollment).not.toHaveBeenCalled();
    },
  );
  it('allows only one concurrent admission to produce a proof in the explicit atomic-admission double', async () => {
    const value = fixture();
    let used = false;
    value.admit.mockImplementation(async () => {
      if (used) return false;
      used = true;
      return true;
    });
    expect(
      (
        await Promise.all(
          Array.from({ length: 8 }, () =>
            value.operations.verifyStepUp({ kind: 'totp', code }, value.session, value.headers),
          ),
        )
      ).filter((outcome) => outcome === 'verified'),
    ).toHaveLength(1);
    expect(value.record).toHaveBeenCalledTimes(1);
  });
});
describe('opaque replay admission rows (not a SQL atomicity claim)', () => {
  const now = new Date('2026-11-07T00:00:35Z'),
    userId = randomUUID(),
    key = 'generated-unit-auth-key-12345678901234567890';
  const rows = (person = userId, time = now) =>
    mfaReplayRows(key, { userId: person, kind: 'mfa_totp', code }, time);
  it('stores only opaque keyed IDs/digests and bounded expiry, without user IDs, factors or codes', () => {
    const result = rows();
    expect(result).toHaveLength(3);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(userId);
    expect(serialized).not.toContain(code);
    for (const row of result) {
      expect(row.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(row.identifier).toMatch(/^ensemus-mfa-admit:v1:[a-f0-9]{64}$/);
      expect(row.value).toBe('consumed');
      expect(row.expiresAt.getTime()).toBeGreaterThan(now.getTime() + 60000);
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(now.getTime() + 120000);
    }
  });
  it('overlaps adjacent accepted TOTP windows across sessions/replicas and isolates actual accounts', () => {
    const first = new Set(rows().map((row) => row.id));
    expect(rows(userId, new Date(now.getTime() + 60000)).some((row) => first.has(row.id))).toBe(
      true,
    );
    expect(rows(randomUUID()).some((row) => first.has(row.id))).toBe(false);
    expect(rows(userId, new Date(now.getTime() + 180000)).some((row) => first.has(row.id))).toBe(
      false,
    );
  });
});
