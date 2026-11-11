// ADR-038's pure rules. Migrations 0560 and 0561 hold the same lists and arrows, and these tests read the
// SQL so the two cannot drift. What the triggers refuse at run time is for tests/integration.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  attemptSecretsToRevoke,
  CAPABILITY_SCOPES,
  canTransitionOAuth,
  capabilityGranted,
  deniedCodeFor,
  DIRECTORY_STALE_AFTER_MS,
  directoryFreshness,
  formatOAuthState,
  grantedScopesOf,
  IDENTITY_SCOPES,
  isOAuthErrorCode,
  isSettledOAuth,
  isValidDirectoryPage,
  OAUTH_ERROR_CODES,
  OAUTH_ORPHAN_SECRET_AFTER_MS,
  OAUTH_STATUSES,
  OAUTH_TRANSITIONS,
  oauthStateSha256,
  oauthTransitionAllowed,
  parseOAuthState,
  pkceChallenge,
  scopesFor,
  SUITE_CAPABILITIES,
  SUITE_CONNECTOR_TYPES,
  type DirectoryPage,
  type OAuthStatus,
} from './workspace-suites';

const migration = (name: string) =>
  readFileSync(new URL(`../../database/migrations/${name}`, import.meta.url), 'utf8');
const ORG = '6f1c2c6e-1111-4111-8111-111111111111';
const AUTH = '6f1c2c6e-2222-4222-8222-222222222222';
const SECRET = '6f1c2c6e-3333-4333-8333-333333333333';
const CONNECTION = '6f1c2c6e-4444-4444-8444-444444444444';

describe('the consent state machine', () => {
  it('has the same arrows as 0561', () => {
    const sql = migration('0561_workspace_suites_security.sql');
    const block = /allowed := CASE OLD\.status([\s\S]*?)ELSE false/.exec(sql)?.[1] ?? '';
    const arrows: Record<string, string[]> = {};
    for (const [, from, to] of block.matchAll(/WHEN '(\w+)' THEN NEW\.status IN \(([^)]*)\)/g))
      arrows[from!] = [...to!.matchAll(/'(\w+)'/g)].map((m) => m[1]!).sort();
    const expected = Object.fromEntries(
      Object.entries(OAUTH_TRANSITIONS)
        .filter(([, to]) => to.length > 0)
        .map(([from, to]) => [from, [...to].sort()]),
    );
    expect(arrows).toEqual(expected);
  });

  it('has the same statuses and capabilities as 0560', () => {
    const sql = migration('0560_workspace_suites.sql');
    const list = (constraint: string) =>
      [
        ...(new RegExp(`"${constraint}" CHECK \\(([^\\n]*)\\),?\\n`).exec(sql)?.[1] ?? '').matchAll(
          /'([a-z0-9_]+)'/g,
        ),
      ].map((m) => m[1]);
    expect(list('oauth_authorizations_status')).toEqual([...OAUTH_STATUSES]);
    expect(list('oauth_authorizations_capabilities')).toEqual([...SUITE_CAPABILITIES]);
    expect(list('oauth_authorizations_connector_type')).toEqual([...SUITE_CONNECTOR_TYPES]);
  });

  it('never leaves a settled attempt', () => {
    for (const status of ['connected', 'denied', 'failed', 'expired'] as const) {
      expect(isSettledOAuth(status)).toBe(true);
      for (const to of OAUTH_STATUSES) expect(canTransitionOAuth(status, to)).toBe(false);
    }
  });

  const none = { codeSecretId: null, connectionId: null };
  const received = { codeSecretId: SECRET, connectionId: null };
  const after = (
    over: Partial<{
      codeSecretId: string | null;
      connectionId: string | null;
      errorCode: string | null;
    }>,
  ) => ({
    codeSecretId: null,
    connectionId: null,
    errorCode: null,
    ...over,
  });

  it('takes the code only with code_received', () => {
    expect(
      oauthTransitionAllowed('pending', 'code_received', none, after({ codeSecretId: SECRET })),
    ).toBe(true);
    expect(oauthTransitionAllowed('pending', 'code_received', none, after({}))).toBe(false);
    expect(
      oauthTransitionAllowed(
        'pending',
        'failed',
        none,
        after({ codeSecretId: SECRET, errorCode: 'OAUTH_PROVIDER_ERROR' }),
      ),
    ).toBe(false);
  });

  it('names a connection only when connected', () => {
    expect(
      oauthTransitionAllowed(
        'exchanging',
        'connected',
        received,
        after({ codeSecretId: SECRET, connectionId: CONNECTION }),
      ),
    ).toBe(true);
    expect(
      oauthTransitionAllowed('exchanging', 'connected', received, after({ codeSecretId: SECRET })),
    ).toBe(false);
  });

  it('says why exactly when denied or failed', () => {
    expect(
      oauthTransitionAllowed('pending', 'denied', none, after({ errorCode: 'OAUTH_DENIED' })),
    ).toBe(true);
    expect(oauthTransitionAllowed('pending', 'denied', none, after({}))).toBe(false);
    expect(
      oauthTransitionAllowed('pending', 'expired', none, after({ errorCode: 'OAUTH_DENIED' })),
    ).toBe(false);
    expect(oauthTransitionAllowed('pending', 'expired', none, after({}))).toBe(true);
  });

  it.each(
    OAUTH_STATUSES.flatMap((from) =>
      OAUTH_STATUSES.filter((to) => !OAUTH_TRANSITIONS[from].includes(to)).map((to) => [from, to]),
    ) as [OAuthStatus, OAuthStatus][],
  )('refuses %s to %s whatever the row says', (from, to) => {
    expect(
      oauthTransitionAllowed(
        from,
        to,
        received,
        after({ codeSecretId: SECRET, connectionId: CONNECTION, errorCode: 'OAUTH_DENIED' }),
      ),
    ).toBe(false);
  });
});

describe('capabilities and scopes', () => {
  it('asks for identity and the chosen capabilities, once each', () => {
    expect(scopesFor('google_workspace', ['files'])).toEqual(
      [...IDENTITY_SCOPES.google_workspace, ...CAPABILITY_SCOPES.google_workspace.files].sort(),
    );
    const microsoft = scopesFor('microsoft_365', ['files', 'directory']);
    expect(microsoft).toContain('offline_access');
    expect(microsoft).toContain('GroupMember.Read.All');
    expect(new Set(microsoft).size).toBe(microsoft!.length);
  });

  it('refuses rather than asking for less than was chosen', () => {
    expect(scopesFor('google_workspace', [])).toBeNull();
    expect(scopesFor('google_workspace', ['files', 'files'])).toBeNull();
    expect(scopesFor('google_workspace', ['mail'])).toBeNull();
    expect(scopesFor('google_workspace', ['chat'])).toBeNull();
  });

  it('keeps only what was both granted and asked for', () => {
    expect(grantedScopesOf(['b', 'a', 'x', 'a'], ['a', 'b', 'c'])).toEqual(['a', 'b']);
  });

  it('says a capability is granted only with every scope it needs', () => {
    const files = CAPABILITY_SCOPES.microsoft_365.files;
    expect(capabilityGranted('microsoft_365', 'files', files)).toBe(true);
    expect(capabilityGranted('microsoft_365', 'files', files.slice(1))).toBe(false);
    expect(capabilityGranted('google_workspace', 'chat', [])).toBe(false);
  });
});

describe('state and PKCE', () => {
  it('reads back exactly the state it made, and nothing else', () => {
    const state = formatOAuthState(ORG, AUTH, Buffer.alloc(32, 7));
    expect(parseOAuthState(state)).toEqual({ organizationId: ORG, authorizationId: AUTH });
    expect(oauthStateSha256(state)).toMatch(/^[0-9a-f]{64}$/);
    for (const bad of [
      `${state}x`,
      state.toUpperCase(),
      `${ORG}.${AUTH}`,
      `${ORG}.${AUTH}.${'A'.repeat(42)}`,
      `${ORG}.${AUTH}.${'A'.repeat(43)}.`,
      42,
      null,
    ])
      expect(parseOAuthState(bad)).toBeNull();
    expect(() => formatOAuthState(ORG, AUTH, Buffer.alloc(16))).toThrow();
  });

  it('matches RFC 7636 appendix B', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(() => pkceChallenge('short')).toThrow();
  });
});

describe('refusal codes', () => {
  it('maps a provider error to a fixed code, and anything unknown to a plain one', () => {
    expect(deniedCodeFor('access_denied')).toBe('OAUTH_DENIED');
    expect(deniedCodeFor('invalid_scope')).toBe('OAUTH_SCOPE_REFUSED');
    expect(deniedCodeFor('<script>')).toBe('OAUTH_PROVIDER_ERROR');
    expect(deniedCodeFor(undefined)).toBe('OAUTH_PROVIDER_ERROR');
  });

  it('keeps every code to the shape 0560 stores', () => {
    for (const code of OAUTH_ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/);
      expect(isOAuthErrorCode(code)).toBe(true);
    }
    expect(isOAuthErrorCode('toString')).toBe(false);
  });
});

describe('directory pages', () => {
  const page = (over: Partial<DirectoryPage> = {}): DirectoryPage => ({
    groups: [
      {
        externalId: 'finance@example.invalid',
        displayName: 'Finance',
        members: [
          { kind: 'user', externalId: 'person@example.invalid' },
          { kind: 'group', externalId: 'audit@example.invalid' },
        ],
      },
    ],
    deletedExternalIds: [],
    nextCursor: null,
    hasMore: false,
    fullSync: true,
    ...over,
  });

  it('accepts a page a provider could have produced', () => {
    expect(isValidDirectoryPage(page())).toBe(true);
  });

  it('refuses a group twice, a group both seen and deleted, or a control character', () => {
    const [group] = page().groups;
    expect(isValidDirectoryPage(page({ groups: [group!, group!] }))).toBe(false);
    expect(isValidDirectoryPage(page({ deletedExternalIds: [group!.externalId] }))).toBe(false);
    expect(isValidDirectoryPage(page({ groups: [{ ...group!, displayName: 'Fin\nance' }] }))).toBe(
      false,
    );
    expect(
      isValidDirectoryPage(
        page({ groups: [{ ...group!, members: [{ kind: 'device' as 'user', externalId: 'x' }] }] }),
      ),
    ).toBe(false);
  });
});

describe('how long a directory is believed (ADR-038 D4)', () => {
  const now = new Date('2026-11-11T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const hour = 60 * 60 * 1000;

  it('believes a directory whose last full pass completed inside the bound', () => {
    for (const state of ['idle', 'running', 'resync_required']) {
      expect(
        directoryFreshness({ lastFullPassAt: ago(hour), state, stateAt: ago(1), now }),
      ).toEqual({ fresh: true });
    }
    expect(
      directoryFreshness({
        lastFullPassAt: ago(DIRECTORY_STALE_AFTER_MS),
        state: 'idle',
        stateAt: ago(1),
        now,
      }),
    ).toEqual({ fresh: true });
  });

  it('stops believing one past the bound, or that never completed a full pass', () => {
    for (const lastFullPassAt of [ago(DIRECTORY_STALE_AFTER_MS + 1), ago(7 * 24 * hour), null]) {
      expect(directoryFreshness({ lastFullPassAt, state: 'idle', stateAt: ago(1), now })).toEqual({
        fresh: false,
        // Members a pass read inside the bound came from the provider since, so they stay.
        emptyThrough: ago(DIRECTORY_STALE_AFTER_MS),
        restart: false,
      });
    }
  });

  it('stops believing one whose last pass failed, however recent its last full pass', () => {
    const failedAt = ago(5 * 60_000);
    expect(
      directoryFreshness({ lastFullPassAt: ago(hour), state: 'failed', stateAt: failedAt, now }),
    ).toEqual({ fresh: false, emptyThrough: failedAt, restart: true });
  });

  it('empties everything past the bound too when the failure itself is older', () => {
    expect(
      directoryFreshness({
        lastFullPassAt: null,
        state: 'failed',
        stateAt: ago(3 * 24 * hour),
        now,
      }),
    ).toEqual({ fresh: false, emptyThrough: ago(DIRECTORY_STALE_AFTER_MS), restart: true });
  });
});

describe('which sealed attempt values the sweep revokes (ADR-038 D1)', () => {
  const now = new Date('2026-11-11T12:00:00.000Z');
  const secret = (id: string, purpose: string, ageMs: number) => ({
    id,
    purpose,
    createdAt: new Date(now.getTime() - ageMs),
  });

  it('revokes what a settled attempt names, whichever way it ended, and however young', () => {
    const settled: OAuthStatus[] = ['connected', 'denied', 'failed', 'expired'];
    const live = settled.map((_, index) => secret(`s${index}`, 'oauth_pkce_verifier', 1));
    const namedBy = new Map(settled.map((status, index) => [`s${index}`, status]));
    expect(attemptSecretsToRevoke({ live, namedBy, now })).toEqual(['s0', 's1', 's2', 's3']);
  });

  it('leaves what an attempt under way names, however old', () => {
    const live = (['pending', 'code_received', 'exchanging'] as const).map((_, index) =>
      secret(`s${index}`, 'oauth_authorization_code', 3 * OAUTH_ORPHAN_SECRET_AFTER_MS),
    );
    const namedBy = new Map<string, OAuthStatus>([
      ['s0', 'pending'],
      ['s1', 'code_received'],
      ['s2', 'exchanging'],
    ]);
    expect(attemptSecretsToRevoke({ live, namedBy, now })).toEqual([]);
  });

  it('revokes an orphan from a refused start once it is past the bound, and not before', () => {
    const live = [
      secret('old-verifier', 'oauth_pkce_verifier', OAUTH_ORPHAN_SECRET_AFTER_MS),
      secret('old-client', 'oauth_customer_client', OAUTH_ORPHAN_SECRET_AFTER_MS + 1),
      secret('young-verifier', 'oauth_pkce_verifier', OAUTH_ORPHAN_SECRET_AFTER_MS - 1),
    ];
    expect(attemptSecretsToRevoke({ live, namedBy: new Map(), now })).toEqual([
      'old-verifier',
      'old-client',
    ]);
  });

  it('never touches a value of any other purpose, such as a connection credential', () => {
    const live = [secret('credential', 'connector_credential', 10 * OAUTH_ORPHAN_SECRET_AFTER_MS)];
    expect(
      attemptSecretsToRevoke({ live, namedBy: new Map([['credential', 'connected']]), now }),
    ).toEqual([]);
  });
});
