// The restore drill's operator sequence (backup-and-restore.md, 0422): inspect, review and revoke, a bounded
// review declaration, the acknowledgment through the migrator's one-shot, and only then the reconcile. Pure
// parts only: no Docker, PostgreSQL or restore runs here. tests/stack/restore-drill.test.ts runs the commands.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { afterAll, describe, expect, it, vi } from 'vitest';
vi.mock('../../infrastructure/scripts/sovereign-backup.mjs', () => ({
  compose: vi.fn(),
  composeArguments: (values: { project?: string }) => [
    'compose',
    ...(values.project ? ['-p', values.project] : []),
    '-f',
    'compose.yaml',
  ],
  composeFailureCode: vi.fn(),
  repoRoot: '.',
  say: vi.fn(),
  stop: (code: string) => {
    throw new Error(code);
  },
  loadTool: vi.fn(),
  openStore: vi.fn(),
}));
import {
  AUTHORITY_SERVICE,
  COOLDOWN_MARGIN_MS,
  REVIEW_FIELDS,
  REVIEW_MOUNT,
  authorityArguments,
  authorityReview,
  checkReviewDirectory,
  cooldownWait,
  operatorIdentity,
  readInspection,
  refusedBeforeAcknowledgment,
} from '../../infrastructure/scripts/restore-drill.mjs';
import { parseAuthRestoreExternalReview } from '../../packages/database/src/auth-restore-operator';

const GENERATION = '0b8f5c1e-3a4d-4c2b-9e1f-7a6b5c4d3e2f';
const BACKUP = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const MANIFEST = 'a'.repeat(64);
const SECURITY = 'b'.repeat(64);
const inspection = {
  version: 1,
  generation: GENERATION,
  backupId: BACKUP,
  manifestSha256: MANIFEST,
  phase: 'invalidated',
  cutoff: '2026-11-09T14:58:05.000Z',
  notBefore: '2026-11-09T15:13:05.000Z',
  invalidation: null,
  security: { version: 1 },
  securitySha256: SECURITY,
};
const answers = {
  reviewer: 'A named reviewer',
  authorityEvidence: 'Identity provider export of 2026-11-09, ticket 41',
  inFlightEffectsEvidence: 'Relay log and payment ledger checked to the restore time',
};

const folder = mkdtempSync(join(tmpdir(), 'restore-drill-unit-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('the authority steps run as the migrator one-shot, with every body in the review folder', () => {
  it('runs auth-restore.js in `migrate`, the service whose only database login is the migrator', () => {
    expect(AUTHORITY_SERVICE).toBe('migrate');
    const compose = parse(readFileSync(resolve('infrastructure/compose/compose.yaml'), 'utf8')) as {
      services: Record<string, { environment?: Record<string, string>; secrets?: string[] }>;
    };
    const service = compose.services[AUTHORITY_SERVICE]!;
    expect(
      Object.keys(service.environment ?? {}).filter((name) => name.startsWith('DATABASE_URL')),
    ).toEqual(['DATABASE_URL_MIGRATOR_FILE']);
    const secrets = service.secrets ?? [];
    expect(secrets).toContain('db_migrator_url');
    // Not an app, auth, agent, support, secrets, eraser or dispatcher login, and no auth key.
    expect(secrets.filter((name) => /^db_.*_url$/.test(name))).toEqual(['db_migrator_url']);
    expect(secrets).not.toContain('auth_secret');
  });

  it('mounts the review folder read-only unless the step writes a snapshot, as the operator', () => {
    const values = { project: 'ensemus-drill' };
    const args = [
      'acknowledge',
      '--generation',
      GENERATION,
      '--review',
      `${REVIEW_MOUNT}/review.json`,
    ];
    expect(
      authorityArguments(
        values,
        { reviewDirectory: '/private/review', writable: false, user: '1001:118' },
        ...args,
      ),
    ).toEqual([
      'compose',
      '-p',
      'ensemus-drill',
      '-f',
      'compose.yaml',
      'run',
      '--rm',
      '--no-deps',
      '--user',
      '1001:118',
      '--volume',
      '/private/review:/review:ro',
      'migrate',
      'node',
      'dist/auth-restore.js',
      ...args,
    ]);
    const inspect = authorityArguments(
      values,
      { reviewDirectory: '/private/review', writable: true, user: null },
      'inspect',
    );
    expect(inspect).toContain('/private/review:/review');
    expect(inspect).not.toContain('--user');
  });

  it('takes the operator identity from the process, and none where there is no POSIX user', () => {
    expect(operatorIdentity({ getuid: () => 1001, getgid: () => 118 })).toBe('1001:118');
    expect(operatorIdentity({})).toBeNull();
  });
});

describe('the review folder', () => {
  const directory = { isDirectory: () => true, uid: 1001, mode: 0o40700 };

  it('takes a private, empty folder the operator owns', () => {
    expect(() => checkReviewDirectory(directory, [], 1001)).not.toThrow();
    expect(() => checkReviewDirectory(directory, [], undefined)).not.toThrow();
  });

  it('refuses one others can open, one someone else owns, a file, or an earlier review', () => {
    expect(() => checkReviewDirectory({ ...directory, mode: 0o40750 }, [], 1001)).toThrow(
      'REVIEW_DIRECTORY_NOT_PRIVATE',
    );
    expect(() => checkReviewDirectory({ ...directory, mode: 0o40707 }, [], 1001)).toThrow(
      'REVIEW_DIRECTORY_NOT_PRIVATE',
    );
    expect(() => checkReviewDirectory({ ...directory, uid: 0 }, [], 1001)).toThrow(
      'REVIEW_DIRECTORY_NOT_PRIVATE',
    );
    expect(() =>
      checkReviewDirectory({ ...directory, isDirectory: () => false }, [], 1001),
    ).toThrow('REVIEW_DIRECTORY_NOT_A_DIRECTORY');
    expect(() => checkReviewDirectory(directory, ['snapshot-1.json'], 1001)).toThrow(
      'REVIEW_DIRECTORY_NOT_EMPTY',
    );
  });
});

describe('the snapshot inspect wrote', () => {
  const write = (name: string, body: object) => {
    const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
    writeFileSync(join(folder, name), bytes);
    return createHash('sha256').update(bytes).digest('hex');
  };
  const printed = (sha: string) => ({
    event: 'auth_restore.inspected',
    generation: GENERATION,
    phase: 'invalidated',
    security_sha256: SECURITY,
    snapshot_sha256: sha,
  });

  it('is read when its bytes, generation and authority hash are the ones printed', () => {
    const sha = write('snapshot-ok.json', inspection);
    expect(readInspection(folder, 'snapshot-ok.json', printed(sha))).toEqual(inspection);
  });

  it('is refused when it is not the file that step wrote', () => {
    const sha = write('snapshot-changed.json', inspection);
    write('snapshot-changed.json', { ...inspection, securitySha256: 'c'.repeat(64) });
    expect(() => readInspection(folder, 'snapshot-changed.json', printed(sha))).toThrow(
      'AUTHORITY_SNAPSHOT_DOES_NOT_MATCH',
    );
    const other = write('snapshot-other.json', { ...inspection, securitySha256: 'c'.repeat(64) });
    expect(() => readInspection(folder, 'snapshot-other.json', printed(other))).toThrow(
      'AUTHORITY_SNAPSHOT_DOES_NOT_MATCH',
    );
  });
});

describe('the review declaration', () => {
  const reviewedAt = new Date('2026-11-09T15:00:00.000Z');

  it('has exactly 0422 version 1 fields, for the snapshot reviewed, and 0422 accepts it', () => {
    const bytes = authorityReview(inspection, answers, reviewedAt);
    const review = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(review)).toEqual([...REVIEW_FIELDS]);
    expect(review).toEqual({
      version: 1,
      generation: GENERATION,
      backupId: BACKUP,
      manifestSha256: MANIFEST,
      securitySha256: SECURITY,
      reviewer: answers.reviewer,
      reviewedAt: reviewedAt.toISOString(),
      authorityEvidence: answers.authorityEvidence,
      inFlightEffectsEvidence: answers.inFlightEffectsEvidence,
    });
    expect(parseAuthRestoreExternalReview(bytes, new Date('2026-11-09T15:01:00.000Z'))).toEqual(
      review,
    );
  });

  it('fills in nothing a person did not answer', () => {
    for (const field of ['reviewer', 'authorityEvidence', 'inFlightEffectsEvidence'] as const) {
      expect(() => authorityReview(inspection, { ...answers, [field]: null }, reviewedAt)).toThrow(
        'AUTHORITY_REVIEW_NOT_ANSWERED',
      );
      expect(() => authorityReview(inspection, { ...answers, [field]: '  ' }, reviewedAt)).toThrow(
        'AUTHORITY_REVIEW_NOT_ANSWERED',
      );
    }
  });
});

describe("0422's cooldown", () => {
  const notBefore = Date.parse(inspection.notBefore);

  it('is waited out in full, with a margin, and never shortened', () => {
    expect(cooldownWait(inspection.notBefore, notBefore - 60_000)).toBe(
      60_000 + COOLDOWN_MARGIN_MS,
    );
    expect(cooldownWait(inspection.notBefore, notBefore)).toBe(COOLDOWN_MARGIN_MS);
    expect(cooldownWait(inspection.notBefore, notBefore + 60_000)).toBe(0);
  });

  it('refuses a deadline it cannot read', () => {
    expect(() => cooldownWait('not a time')).toThrow('AUTHORITY_COOLDOWN_UNKNOWN');
  });
});

describe('a reconcile before the acknowledgment', () => {
  const refused = {
    exit_status: 1,
    ledger: null,
    finished: null,
    failed: { event: 'restore_reconcile.failed', errorCode: 'RESTORE_PENDING' },
    tenants: [],
    findings: [],
  };

  it("counts as refused only when 0422's fence stopped it and nothing was reported", () => {
    expect(refusedBeforeAcknowledgment(refused)).toBe(true);
  });

  it('is not refused when it ran, or failed for another reason', () => {
    expect(
      refusedBeforeAcknowledgment({
        ...refused,
        failed: null,
        ledger: { event: 'restore_reconcile.ledger' },
        finished: { event: 'restore_reconcile.finished', needsAttention: 1 },
      }),
    ).toBe(false);
    expect(refusedBeforeAcknowledgment({ ...refused, exit_status: 0, failed: null })).toBe(false);
    expect(
      refusedBeforeAcknowledgment({
        ...refused,
        failed: { event: 'restore_reconcile.failed', errorCode: 'ECONNREFUSED' },
      }),
    ).toBe(false);
  });
});
