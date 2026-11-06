// The corpus is the promise (ADR-030 D2). tests/fixtures/license-corpus/v1 holds documents signed once, with
// generated keys whose private halves were thrown away, as a customer would hold them. THESE FILES ARE NEVER
// REGENERATED. A release that cannot read them breaks lapsed customers, who may have no way to take a
// corrected release, so if this file fails, the code is what changed and the code is what has to go back.
//
// Below the corpus, the same reading rules run with generated keys, and then the services themselves run
// against a small database double that lives here and only here. tests/integration/licensing.test.ts is the
// real thing, on real PostgreSQL with real roles.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  advisoriesFromDocuments,
  checkSignedDocument,
  createSovereignEntitlements,
  getLicenseStatus,
  installSignedDocument,
  licenseStatusFromDocuments,
  listAdvisories,
  readVerifiedLicenseFacts,
  type StoredEnvelopes,
} from '@ensemus/application';
import {
  auditEvents,
  domainEvents,
  licenseRecords,
  memberships,
  outboxEvents,
  signedDocuments,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  evaluateUpdateRight,
  maintenanceStatus,
  type ReleaseFacts,
} from '@ensemus/domain/license';
import { parseTrustRoot } from '@ensemus/sovereign/trust-root';
import {
  generateTestSigningKey,
  signForTest,
  testLicense,
  testMaintenance,
  testTrustRoot,
} from '@ensemus/sovereign/testing';
import { verifyDocument } from '@ensemus/sovereign/verify';
import { describe, expect, it, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const corpusFile = (name: string) =>
  readFileSync(resolve(here, '../fixtures/license-corpus/v1', name), 'utf8');

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const trustRootText = corpusFile('trust-root.json');
const corpusRoot = parseTrustRoot(trustRootText);
const corpus = {
  license: corpusFile('license.dsse.json'),
  pilot: corpusFile('pilot-license.dsse.json'),
  maintenance: corpusFile('maintenance.dsse.json'),
  advisory: corpusFile('advisory.dsse.json'),
  policy: corpusFile('support-policy.dsse.json'),
};

const CORPUS_LICENSE_ID = '3f0a7c52-6a0e-4d1b-9c55-0d6f4b1e7a10';

/** What was signed when the corpus was made. A regenerated file cannot match, whatever else it does. */
const FROZEN = {
  'license.dsse.json': {
    payload: '1bfc98fcc5358a7df4529bf56f3ac7f8b909812fbb28ecca04bbe1f0ad2d6ffa',
    signature: 'b77127b81a4778d834b9434e8b7087db8c7c7afeffe7c57dd35eadad0f429d75',
  },
  'pilot-license.dsse.json': {
    payload: '5bb52f232d1d909e33c96490600ec046f3611c19b4b00bd7727040ba8444e421',
    signature: 'f04a39d17bc99d9dfd16e0476afae1efc6b05a24ebc92beae42802bdf84eb7ba',
  },
  'maintenance.dsse.json': {
    payload: 'a3df5b81fd903a511d689e11a390b83a6692990ff6f9b016e1096af3f814d566',
    signature: 'a88b1e5ae2d6eec1fb149af69bdfce074d876d3f9fe6328d52475a5a84fedb39',
  },
  'advisory.dsse.json': {
    payload: '2a5b770b727478746432e2b7e501cb4c6adc4af2b014955ac0940a676ecfbe85',
    signature: '53a1670b652a1a21611b614a055a5de1e9fc52bbfa58ec582bd604e60de2ebd0',
  },
  'support-policy.dsse.json': {
    payload: '06b03e7270e8c2ccfbdf7c08690e18cd4374be299c4be1d81f39fd44f5829418',
    signature: 'c92ef47e1902854f48c033260283517bef0dbb6cb3405c96e021c5e060c8ec08',
  },
};

const FROZEN_KEYS = {
  'corpus-v1-license': 'b681d7d7ea6f2803faa9edc04495314c313ce50302fbc08b6cf1d66736dbe498',
  'corpus-v1-pilot-license': '28e1b15c4fca667fdd0ce1e51c182dbdd479cd9e65a6c5085e6209924d1d91a4',
  'corpus-v1-maintenance': '146dbbbf29c86fbebef5c45d935cdb5fda782255b6841ea24d9af55dcc89b690',
  'corpus-v1-advisory': '04e85a3a23bd586094fe753e245202329417e64f415599111044f8fe50b234d9',
  'corpus-v1-support-policy': '93eeb9caacb8cbb74600641e01ef91d3a01a16787c3370bc2e305eadd95d2f8d',
};

const release = (overrides: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  version: '2.0.1',
  line: '2.0',
  kind: 'patch',
  security: false,
  published_on: '2027-01-15',
  ...overrides,
});

describe('the frozen corpus', () => {
  it('is the files that were signed, and not a later copy', () => {
    for (const [name, frozen] of Object.entries(FROZEN)) {
      const envelope = JSON.parse(corpusFile(name)) as {
        payload: string;
        signatures: { sig: string }[];
      };
      expect(envelope.signatures, name).toHaveLength(1);
      expect(sha256(Buffer.from(envelope.payload, 'base64')), name).toBe(frozen.payload);
      expect(sha256(Buffer.from(envelope.signatures[0]?.sig ?? '', 'base64')), name).toBe(
        frozen.signature,
      );
    }
    const { keys } = JSON.parse(trustRootText) as {
      keys: { key_id: string; public_key: string }[];
    };
    expect(
      Object.fromEntries(
        keys.map(({ key_id: id, public_key: key }) => [id, sha256(Buffer.from(key, 'base64'))]),
      ),
    ).toEqual(FROZEN_KEYS);
  });

  it('marks every key as a test key, with one purpose each', () => {
    expect(corpusRoot.keys).toHaveLength(5);
    for (const key of corpusRoot.keys) {
      expect(key.test_only).toBe(true);
      expect(key.purposes).toHaveLength(1);
    }
  });

  it('verifies a license', () => {
    const verdict = verifyDocument('license', corpus.license, corpusRoot);
    expect(verdict).toMatchObject({
      ok: true,
      keyIds: ['corpus-v1-license'],
      testKey: true,
      retiredKey: false,
    });
    if (!verdict.ok) throw new Error(verdict.code);
    expect(verdict.document).toMatchObject({
      license_id: CORPUS_LICENSE_ID,
      term: { kind: 'perpetual' },
      licensed_release: { line: '2.0', version: '2.0.0' },
    });
  });

  it('verifies a pilot license with its review date', () => {
    const verdict = verifyDocument('license', corpus.pilot, corpusRoot);
    if (!verdict.ok) throw new Error(verdict.code);
    expect(verdict.document.term).toEqual({ kind: 'pilot', review_on: '2027-05-01' });
  });

  it('verifies a maintenance statement for that license', () => {
    const verdict = verifyDocument('maintenance', corpus.maintenance, corpusRoot);
    if (!verdict.ok) throw new Error(verdict.code);
    expect(verdict.document).toMatchObject({
      license_id: CORPUS_LICENSE_ID,
      starts_on: '2026-11-06',
      ends_on: '2027-11-05',
    });
  });

  it('verifies an advisory and a support policy', () => {
    const advisory = verifyDocument('advisory', corpus.advisory, corpusRoot);
    if (!advisory.ok) throw new Error(advisory.code);
    expect(advisory.document).toMatchObject({
      advisory_id: 'CORPUS-ADV-1',
      severity: 'moderate',
      affected_versions: ['2.0.0'],
      fixed_in_versions: ['2.0.1'],
    });
    const policy = verifyDocument('support_policy', corpus.policy, corpusRoot);
    if (!policy.ok) throw new Error(policy.code);
    expect(policy.document).toMatchObject({
      branches: [{ line: '2.0', status: 'supported' }],
      security_patches_after_lapse_grant: 'none',
    });
  });

  it.each(Object.entries(corpus))('works out what %s is from its payload type alone', (_n, text) => {
    expect(checkSignedDocument(text, corpusRoot).ok).toBe(true);
  });

  it('holds its keys to one purpose, so a document cannot pass as another kind', () => {
    expect(verifyDocument('license', corpus.maintenance, corpusRoot)).toEqual({
      ok: false,
      code: 'WRONG_TYPE',
    });
    expect(verifyDocument('bundle', corpus.license, corpusRoot)).toEqual({
      ok: false,
      code: 'WRONG_TYPE',
    });
  });

  describe('evaluated for rights', () => {
    const licenseVerdict = verifyDocument('license', corpus.license, corpusRoot);
    const maintenanceVerdict = verifyDocument('maintenance', corpus.maintenance, corpusRoot);
    const policyVerdict = verifyDocument('support_policy', corpus.policy, corpusRoot);
    if (!licenseVerdict.ok || !maintenanceVerdict.ok || !policyVerdict.ok) {
      throw new Error('The corpus did not verify');
    }
    const evaluate = (facts: Partial<ReleaseFacts>, today = '2040-01-01') =>
      evaluateUpdateRight({
        license: licenseVerdict.document,
        agreements: [maintenanceVerdict.document],
        policies: [policyVerdict.document],
        release: release(facts),
        today,
      });

    it.each([
      ['what was bought', { version: '2.0.0' }, true, 'licensed_release'],
      ['anything older', { version: '1.9.0', line: '1.9' }, true, 'licensed_release'],
      ['a release published while maintained', {}, true, 'maintenance'],
      [
        'a minor published while maintained',
        { version: '2.1.0', line: '2.1', kind: 'minor' as const },
        true,
        'maintenance',
      ],
      [
        'a release published after the last covered day',
        { version: '2.1.0', line: '2.1', published_on: '2028-01-01' },
        false,
        null,
      ],
      [
        'a new major, which these rights keep separate',
        { version: '3.0.0', line: '3.0', kind: 'major' as const },
        false,
        null,
      ],
      [
        'a security fix after the lapse, which these rights leave out',
        { version: '2.0.9', security: true, published_on: '2028-06-01' },
        false,
        null,
      ],
    ])('answers for %s', (_name, facts, covered, basis) => {
      expect(evaluate(facts)).toEqual({
        covered,
        basis,
        onInstall: covered ? 'proceed' : 'warn',
      });
    });

    it('cannot be talked into a release by moving the clock', () => {
      const late = { version: '2.1.0', line: '2.1', published_on: '2028-01-01' };
      expect(evaluate(late, '2027-01-01').covered).toBe(false);
      expect(evaluate(late, '2001-01-01').covered).toBe(false);
    });

    it('reads the support status from the dates', () => {
      const agreements = [maintenanceVerdict.document];
      expect(maintenanceStatus(agreements, '2027-01-01').status).toBe('active');
      expect(maintenanceStatus(agreements, '2026-01-01').status).toBe('not_started');
      expect(maintenanceStatus(agreements, '2040-01-01')).toEqual({
        status: 'lapsed',
        lastCoveredOn: '2027-11-05',
      });
    });
  });

  it('gives a standing and notices, however long after the last covered day', () => {
    const stored = { licenses: [corpus.license], documents: [corpus.maintenance, corpus.policy] };
    for (const at of ['2028-01-01', '2038-01-01', '2126-01-01']) {
      const status = licenseStatusFromDocuments(stored, 1, {
        trustRoot: corpusRoot,
        runningRelease: null,
        now: () => new Date(`${at}T00:00:00.000Z`),
      });
      expect(status).toMatchObject({
        standing: 'licensed',
        maintenance: { status: 'lapsed', lastCoveredOn: '2027-11-05' },
        notices: ['maintenance_lapsed', 'signed_with_test_key'],
      });
      expect(status.license).toMatchObject({
        licenseId: CORPUS_LICENSE_ID,
        licensee: { displayName: 'Corpus Licensee', contractReference: 'CORPUS-CONTRACT-1' },
        testKey: true,
      });
    }
  });

  it('shows a pilot review date as a notice, and the standing does not move', () => {
    const status = licenseStatusFromDocuments({ licenses: [corpus.pilot], documents: [] }, 1, {
      trustRoot: corpusRoot,
      runningRelease: null,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(status.standing).toBe('licensed');
    expect(status.notices).toEqual(['no_maintenance', 'pilot_review_due', 'signed_with_test_key']);
  });

  it('lists the advisory, and knows whether this release is the one it names', () => {
    const [named] = advisoriesFromDocuments([corpus.advisory], {
      trustRoot: corpusRoot,
      runningRelease: release({ version: '2.0.0' }),
    });
    expect(named).toMatchObject({
      advisoryId: 'CORPUS-ADV-1',
      affectsThisRelease: true,
      testKey: true,
    });
  });
});

// Generated from here on. This key is not marked as a test key in its trust root, so that the one notice a
// lapse gives can be seen by itself, and the tests that care about a test key ask for one.
const key = generateTestSigningKey('real-looking-key');
const root = testTrustRoot([{ ...key, testOnly: false }]);
const stranger = generateTestSigningKey('stranger-key');
const strangersRoot = testTrustRoot([{ ...stranger, testOnly: false }]);

const LICENSE_ID = testLicense().license_id;
const signedLicense = signForTest('license', testLicense(), [key]);
const lapsedStatement = signForTest('maintenance', testMaintenance(), [key]);
const stored: StoredEnvelopes = { licenses: [signedLicense], documents: [lapsedStatement] };
const at = (day: string) => () => new Date(`${day}T12:00:00.000Z`);

describe('QA-021 and SOV-TS-02: what a lapse changes', () => {
  it('says licensed and lapsed, with one notice', () => {
    expect(
      licenseStatusFromDocuments(stored, 3, {
        trustRoot: root,
        runningRelease: null,
        now: at('2030-01-01'),
      }),
    ).toMatchObject({
      standing: 'licensed',
      maintenance: { status: 'lapsed', lastCoveredOn: '2027-12-31' },
      seatsInUse: 3,
      notices: ['maintenance_lapsed'],
    });
  });

  it('says the same ten years on', () => {
    const status = licenseStatusFromDocuments(stored, 3, {
      trustRoot: root,
      runningRelease: null,
      now: at('2040-01-01'),
    });
    expect(status.standing).toBe('licensed');
    expect(status.notices).toEqual(['maintenance_lapsed']);
  });

  it('answers with no trust root at all', () => {
    const status = licenseStatusFromDocuments(stored, 3, {
      trustRoot: null,
      runningRelease: null,
      now: at('2030-01-01'),
    });
    expect(status).toMatchObject({
      standing: 'unverifiable',
      license: null,
      maintenance: { status: 'no_agreement', lastCoveredOn: null },
      notices: ['license_unverifiable'],
    });
  });

  it('answers with every row failing, for instance after a key is removed', () => {
    const status = licenseStatusFromDocuments(stored, 3, {
      trustRoot: strangersRoot,
      runningRelease: null,
      now: at('2030-01-01'),
    });
    expect(status.standing).toBe('unverifiable');
    expect(status.license).toBeNull();
    expect(status.notices).toEqual(['license_unverifiable']);
  });

  it('takes nothing from a column, because it is never given one', () => {
    expect(
      licenseStatusFromDocuments({ licenses: ['not a document', '', 'null'], documents: ['{'] }, 0, {
        trustRoot: root,
        runningRelease: null,
      }),
    ).toMatchObject({ standing: 'unverifiable', license: null });
  });

  it('says unlicensed when nothing is installed, with or without a trust root', () => {
    for (const trustRoot of [root, null]) {
      expect(
        licenseStatusFromDocuments({ licenses: [], documents: [] }, 0, {
          trustRoot,
          runningRelease: null,
        }),
      ).toMatchObject({ standing: 'unlicensed', license: null, notices: ['no_license'] });
    }
  });

  it('skips a row that fails, and uses the one that verifies', () => {
    const status = licenseStatusFromDocuments(
      { licenses: ['garbage', signedLicense, signForTest('license', testLicense(), [stranger])], documents: [] },
      0,
      { trustRoot: root, runningRelease: null, now: at('2030-01-01') },
    );
    expect(status.standing).toBe('licensed');
    expect(status.license?.licenseId).toBe(LICENSE_ID);
  });

  it('never has a way to say stop', async () => {
    await expect(
      createSovereignEntitlements().check(createServiceContext(randomUUID()), 'anything'),
    ).resolves.toEqual({ ok: true, billable: false, commercialMode: 'sovereign' });
  });
});

describe('a stopped clock', () => {
  it('gives clock_before_issue, and the standing does not change', () => {
    const status = licenseStatusFromDocuments(stored, 3, {
      trustRoot: root,
      runningRelease: null,
      now: at('2001-01-01'),
    });
    expect(status.standing).toBe('licensed');
    expect(status.license?.licenseId).toBe(LICENSE_ID);
    expect(status.notices).toContain('clock_before_issue');
    expect(status.maintenance.status).toBe('not_started');
  });
});

describe('which documents count', () => {
  const secondId = randomUUID();

  it('takes the latest license that verifies, from what the documents themselves say', () => {
    const later = signForTest(
      'license',
      testLicense({ license_id: secondId, issued_at: '2028-01-01T00:00:00.000Z' }),
      [key],
    );
    const status = licenseStatusFromDocuments({ licenses: [signedLicense, later], documents: [] }, 0, {
      trustRoot: root,
      runningRelease: null,
    });
    expect(status.license?.licenseId).toBe(secondId);
    expect(status.license?.issuedAt).toEqual(new Date('2028-01-01T00:00:00.000Z'));
  });

  it('counts maintenance only for the license it says it is for', () => {
    const otherLicense = signForTest('maintenance', testMaintenance({ license_id: secondId }), [key]);
    const status = licenseStatusFromDocuments({ licenses: [signedLicense], documents: [otherLicense] }, 0, {
      trustRoot: root,
      runningRelease: null,
      now: at('2027-06-01'),
    });
    expect(status.maintenance.status).toBe('no_agreement');
  });

  it('does not count a statement filed as a license, which leaves that row failing', () => {
    const status = licenseStatusFromDocuments({ licenses: [lapsedStatement], documents: [] }, 0, {
      trustRoot: root,
      runningRelease: null,
    });
    expect(status.standing).toBe('unverifiable');
  });

  it('shows a test key on the license, and says so', () => {
    const testRoot = testTrustRoot([key]);
    const status = licenseStatusFromDocuments(stored, 0, {
      trustRoot: testRoot,
      runningRelease: null,
      now: at('2030-01-01'),
    });
    expect(status.license?.testKey).toBe(true);
    expect(status.notices).toContain('signed_with_test_key');
  });

  it('says so too when only a statement it rests on was signed with a test key', () => {
    const testSigner = generateTestSigningKey('test-signer');
    const mixedRoot = testTrustRoot([{ ...key, testOnly: false }, testSigner]);
    const status = licenseStatusFromDocuments(
      {
        licenses: [signedLicense],
        documents: [signForTest('maintenance', testMaintenance(), [testSigner])],
      },
      0,
      { trustRoot: mixedRoot, runningRelease: null, now: at('2030-01-01') },
    );
    expect(status.license?.testKey).toBe(false);
    expect(status.notices).toContain('signed_with_test_key');
  });

  it('says so of a retired key, and the license stays good', () => {
    const status = licenseStatusFromDocuments(stored, 0, {
      trustRoot: testTrustRoot([{ ...key, testOnly: false, retiredOn: '2029-01-01' }]),
      runningRelease: null,
      now: at('2030-01-01'),
    });
    expect(status.standing).toBe('licensed');
    expect(status.license?.retiredKey).toBe(true);
    expect(status.notices).toContain('signed_with_retired_key');
  });

  it('refuses what a retired key signed after it retired, without throwing', () => {
    const status = licenseStatusFromDocuments(stored, 0, {
      trustRoot: testTrustRoot([{ ...key, testOnly: false, retiredOn: '2026-01-01' }]),
      runningRelease: null,
    });
    expect(status.standing).toBe('unverifiable');
  });

  it('reads a running release, and a verdict changes a notice and nothing else', () => {
    const status = licenseStatusFromDocuments(stored, 0, {
      trustRoot: root,
      runningRelease: release({ version: '2.1.0', line: '2.1', published_on: '2029-01-01' }),
      now: at('2030-01-01'),
    });
    expect(status.standing).toBe('licensed');
    expect(status.runningRelease).toEqual({
      version: '2.1.0',
      verdict: { covered: false, basis: null, onInstall: 'warn' },
    });
    expect(status.notices).toContain('running_release_outside_rights');
  });

  it('has no verdict on a build whose version cannot be compared, and does not throw', () => {
    const status = licenseStatusFromDocuments(stored, 0, {
      trustRoot: root,
      runningRelease: release({ version: 'unreleased' }),
    });
    expect(status.runningRelease).toEqual({ version: 'unreleased', verdict: null });
    expect(status.notices).not.toContain('running_release_outside_rights');
  });

  it('notes seats above the footprint, and enforces nothing', () => {
    const counted = signForTest(
      'license',
      testLicense({ footprint: { ...testLicense().footprint, seats: 2 } }),
      [key],
    );
    const status = licenseStatusFromDocuments({ licenses: [counted], documents: [] }, 3, {
      trustRoot: root,
      runningRelease: null,
      now: at('2030-01-01'),
    });
    expect(status.standing).toBe('licensed');
    expect(status.notices).toContain('seats_above_footprint');
  });
});

describe('advisories', () => {
  const advisory = (overrides: Record<string, unknown> = {}) => ({
    format: 'ensemus.advisory',
    format_version: 1,
    advisory_id: 'TEST-ADV-1',
    issued_at: '2027-02-01T00:00:00.000Z',
    severity: 'high',
    title: 'A generated advisory',
    summary: 'Generated for a test.',
    affected_versions: ['2.0.0'],
    fixed_in_versions: ['2.0.1'],
    ...overrides,
  });

  it('are newest first, and a reissue replaces what it reissues', () => {
    const envelopes = [
      signForTest('advisory', advisory(), [key]),
      signForTest('advisory', advisory({ advisory_id: 'TEST-ADV-2', issued_at: '2028-01-01T00:00:00.000Z' }), [key]),
      signForTest('advisory', advisory({ issued_at: '2027-03-01T00:00:00.000Z', title: 'Reissued' }), [key]),
    ];
    const views = advisoriesFromDocuments(envelopes, { trustRoot: root, runningRelease: null });
    expect(views.map(({ advisoryId }) => advisoryId)).toEqual(['TEST-ADV-2', 'TEST-ADV-1']);
    expect(views[1]?.title).toBe('Reissued');
  });

  it('skip what does not verify, and what is not an advisory', () => {
    expect(
      advisoriesFromDocuments(
        ['nonsense', lapsedStatement, signForTest('advisory', advisory(), [stranger])],
        { trustRoot: root, runningRelease: null },
      ),
    ).toEqual([]);
    expect(
      advisoriesFromDocuments([signForTest('advisory', advisory(), [key])], {
        trustRoot: null,
        runningRelease: null,
      }),
    ).toEqual([]);
  });

  it('say null for whether they affect this release when that is not known', () => {
    const [view] = advisoriesFromDocuments([signForTest('advisory', advisory(), [key])], {
      trustRoot: root,
      runningRelease: null,
    });
    expect(view?.affectsThisRelease).toBeNull();
  });
});

describe('working out what a file is', () => {
  const signedAs = (text: string, payloadType: string) =>
    JSON.stringify({ ...(JSON.parse(text) as object), payloadType });

  it.each([
    ['text that is not JSON', 'not a document', 'MALFORMED'],
    ['empty text', '', 'MALFORMED'],
    ['the word null', 'null', 'WRONG_TYPE'],
    ['a number', '5', 'WRONG_TYPE'],
    ['an object with no type', '{}', 'WRONG_TYPE'],
    ['a bundle manifest', signForTest('bundle', {}, [key]), 'WRONG_TYPE'],
    ['a type named after an object method', '{"payloadType":"constructor"}', 'WRONG_TYPE'],
    ['an oversized file', 'x'.repeat(1024 * 1024 + 1), 'TOO_LARGE'],
    ['nonsense signed by a good key', signForTest('license', Buffer.from('nonsense'), [key]), 'CONTENT_INVALID'],
    ['a signature from nobody here', signForTest('license', testLicense(), [stranger]), 'UNKNOWN_KEY'],
    [
      'a maintenance statement relabelled as a license',
      signedAs(lapsedStatement, 'application/vnd.ensemus.license+json'),
      'BAD_SIGNATURE',
    ],
  ])('refuses %s, without throwing', (_name, text, code) => {
    expect(checkSignedDocument(text, root)).toEqual({ ok: false, code });
  });

  it('does not let a key for one purpose sign another', () => {
    const narrowRoot = testTrustRoot([{ ...key, testOnly: false, purposes: ['maintenance'] }]);
    expect(checkSignedDocument(signedLicense, narrowRoot)).toEqual({
      ok: false,
      code: 'WRONG_PURPOSE',
    });
  });
});

/**
 * PostgreSQL's job, in as few lines as the services need: rows by table for the tenant the transaction is
 * bound to, undone if the transaction throws. It stands in so that these rules run with no container. It says
 * nothing about row-level security itself, which tests/integration/licensing.test.ts checks on real roles.
 */
function databaseDouble(seats = 1) {
  type Row = Record<string, unknown>;
  const tenants = new Map<string, Map<unknown, Row[]>>();
  const transaction = vi.fn(
    async (bindings: Record<string, string>, work: (tx: unknown) => Promise<unknown>) => {
      const tenant = bindings['app.organization_id'] ?? '';
      const before = tenants.get(tenant) ?? new Map<unknown, Row[]>();
      const current = new Map([...before].map(([table, rows]) => [table, [...rows]]));
      const rowsOf = (table: unknown) => {
        const rows = current.get(table) ?? [];
        current.set(table, rows);
        return rows;
      };
      const tx = {
        insert: (table: unknown) => ({
          values: (values: Row) => {
            const row = { id: randomUUID(), ...values };
            const add = () => {
              rowsOf(table).push(row);
              return [row];
            };
            const conflicting = () =>
              rowsOf(table).some(
                ({ envelopeSha256 }) =>
                  envelopeSha256 !== undefined && envelopeSha256 === values.envelopeSha256,
              );
            return {
              then: (resolve: (value: Row[]) => void) => resolve(add()),
              onConflictDoNothing: () => ({
                returning: async () => (conflicting() ? [] : add()),
              }),
            };
          },
        }),
        select: (fields: Record<string, unknown>) => ({
          from: (table: unknown) => {
            const answer = async () =>
              table === memberships
                ? [{ n: seats }]
                : rowsOf(table).map((row) =>
                    Object.fromEntries(Object.keys(fields).map((name) => [name, row[name]])),
                  );
            const chain = {
              where: () => chain,
              orderBy: () => chain,
              limit: () => chain,
              then: (
                resolve: (value: Row[]) => unknown,
                reject: (reason: unknown) => unknown,
              ) => answer().then(resolve, reject),
            };
            return chain;
          },
        }),
      };
      const result = await work(tx);
      tenants.set(tenant, current);
      return result;
    },
  );
  return {
    database: { transaction } as unknown as AppDatabase,
    transaction,
    rows: (context: TenantContext, table: unknown) =>
      tenants.get(context.organizationId)?.get(table) ?? [],
  };
}

const asRole = (role: string, organizationId = randomUUID()): TenantContext => ({
  ...createServiceContext(organizationId),
  userId: randomUUID(),
  membershipId: randomUUID(),
  role,
  actorType: 'user',
});

describe('installing, on a database double', () => {
  const deps = { trustRoot: root };

  it('stores a license with who installed it, an audit row and an event, in one transaction', async () => {
    const { database, rows, transaction } = databaseDouble();
    const owner = asRole('owner');
    const installed = await installSignedDocument(database, owner, { envelope: signedLicense }, deps);
    expect(installed).toMatchObject({ type: 'license', created: true, testKey: false });
    expect(transaction).toHaveBeenCalledOnce();
    expect(rows(owner, licenseRecords)).toHaveLength(1);
    expect(rows(owner, licenseRecords)[0]).toMatchObject({
      id: installed.id,
      licenseId: LICENSE_ID,
      edition: 'sovereign',
      licensedVersion: '2.0.0',
      termKind: 'perpetual',
      keyIds: ['real-looking-key'],
      envelope: signedLicense,
      envelopeSha256: sha256(Buffer.from(signedLicense)),
      installedByMembershipId: owner.membershipId,
      issuedAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(rows(owner, auditEvents)[0]).toMatchObject({
      action: 'license.document_installed',
      targetRef: `license:${installed.id}`,
      actorType: 'user',
      actorId: owner.membershipId,
      decision: 'allow',
    });
    expect(rows(owner, domainEvents)[0]).toMatchObject({
      eventType: 'license.document_installed',
      aggregateType: 'license',
      aggregateId: installed.id,
      payload: { documentType: 'license', documentId: LICENSE_ID, testKey: false },
    });
    expect(rows(owner, outboxEvents)).toHaveLength(1);
  });

  it('puts nothing from the file in an event or an audit row', async () => {
    const { database, rows } = databaseDouble();
    const owner = asRole('owner');
    await installSignedDocument(database, owner, { envelope: signedLicense }, deps);
    const written = JSON.stringify([rows(owner, auditEvents), rows(owner, domainEvents)]);
    expect(written).not.toContain('Test Licensee');
    expect(written).not.toContain('TEST-CONTRACT-1');
    expect(written).not.toContain((JSON.parse(signedLicense) as { payload: string }).payload);
  });

  it('lets a service context install, for the operator, and records no person', async () => {
    const { database, rows } = databaseDouble();
    const service = createServiceContext(randomUUID());
    await installSignedDocument(database, service, { envelope: signedLicense }, deps);
    expect(rows(service, licenseRecords)[0]?.installedByMembershipId).toBeNull();
    expect(rows(service, auditEvents)[0]).toMatchObject({ actorType: 'service' });
    expect(rows(service, auditEvents)[0]?.actorId).toBeUndefined();
    expect(rows(service, domainEvents)[0]).toMatchObject({ actorType: 'system', actorId: null });
  });

  it('makes one row of the same bytes installed twice, and says so', async () => {
    const { database, rows } = databaseDouble();
    const owner = asRole('owner');
    const first = await installSignedDocument(database, owner, { envelope: signedLicense }, deps);
    const second = await installSignedDocument(database, owner, { envelope: signedLicense }, deps);
    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(rows(owner, licenseRecords)).toHaveLength(1);
    expect(rows(owner, auditEvents)).toHaveLength(1);
    expect(rows(owner, domainEvents)).toHaveLength(1);
  });

  it('stores a maintenance statement once its license is here, under what it says it is', async () => {
    const { database, rows } = databaseDouble();
    const owner = asRole('owner');
    await installSignedDocument(database, owner, { envelope: signedLicense }, deps);
    const installed = await installSignedDocument(database, owner, { envelope: lapsedStatement }, deps);
    expect(installed.type).toBe('maintenance');
    expect(rows(owner, signedDocuments)[0]).toMatchObject({
      id: installed.id,
      documentType: 'maintenance',
      documentId: testMaintenance().maintenance_id,
      subjectLicenseId: LICENSE_ID,
    });
  });

  it('refuses a maintenance statement for a license not installed here, and stores nothing', async () => {
    const { database, rows } = databaseDouble();
    const owner = asRole('owner');
    await expect(
      installSignedDocument(database, owner, { envelope: lapsedStatement }, deps),
    ).rejects.toMatchObject({ code: 'LICENSE_NOT_VALID' });
    expect(rows(owner, signedDocuments)).toEqual([]);
    expect(rows(owner, auditEvents)).toEqual([]);
    expect(rows(owner, domainEvents)).toEqual([]);
  });

  it('refuses a maintenance statement whose license is here but no longer verifies', async () => {
    const { database, rows } = databaseDouble();
    const owner = asRole('owner');
    const otherSigner = generateTestSigningKey('other-signer');
    const bothRoot = testTrustRoot([{ ...key, testOnly: false }, otherSigner]);
    await installSignedDocument(database, owner, { envelope: signedLicense }, { trustRoot: bothRoot });
    const statementByOther = signForTest('maintenance', testMaintenance(), [otherSigner]);
    await expect(
      installSignedDocument(
        database,
        owner,
        { envelope: statementByOther },
        { trustRoot: testTrustRoot([otherSigner]) },
      ),
    ).rejects.toMatchObject({ code: 'LICENSE_NOT_VALID' });
    expect(rows(owner, signedDocuments)).toEqual([]);
  });

  it.each([
    ['a forged envelope', JSON.stringify({ ...(JSON.parse(signedLicense) as object), payload: Buffer.from(JSON.stringify(testLicense({ components: ['more'] }))).toString('base64') })],
    ['a signature from a stranger', signForTest('license', testLicense(), [stranger])],
    ['text that is not a document', 'not a document'],
    ['a wrong kind, a bundle manifest', signForTest('bundle', {}, [key])],
    ['a wrong kind, a statement relabelled', JSON.stringify({ ...(JSON.parse(lapsedStatement) as object), payloadType: 'application/vnd.ensemus.license+json' })],
  ])('refuses %s, and never opens a transaction', async (_name, envelope) => {
    const { database, transaction } = databaseDouble();
    await expect(
      installSignedDocument(database, asRole('owner'), { envelope }, deps),
    ).rejects.toMatchObject({ code: 'LICENSE_NOT_VALID' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses everything with no trust root, and does not throw anything else', async () => {
    const { database, transaction } = databaseDouble();
    await expect(
      installSignedDocument(database, asRole('owner'), { envelope: signedLicense }, { trustRoot: null }),
    ).rejects.toMatchObject({ code: 'LICENSE_NOT_VALID' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['admin', 'member', 'nonsense'])('gives %s FORBIDDEN, before looking at the file', async (role) => {
    const { database, transaction } = databaseDouble();
    await expect(
      installSignedDocument(database, asRole(role), { envelope: 'not even a document' }, deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('reading, on a database double', () => {
  const status = (now: () => Date, trustRoot = root as typeof root | null) => ({
    trustRoot,
    runningRelease: null,
    now,
  });

  it.each(['member', 'nonsense'])('gives %s FORBIDDEN on every read', async (role) => {
    const { database, transaction } = databaseDouble();
    const context = asRole(role);
    await expect(getLicenseStatus(database, context, status(at('2030-01-01')))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(listAdvisories(database, context, status(at('2030-01-01')))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('lets an owner and an admin read', async () => {
    const { database } = databaseDouble(4);
    for (const role of ['owner', 'admin']) {
      const view = await getLicenseStatus(database, asRole(role), status(at('2030-01-01')));
      expect(view).toMatchObject({ standing: 'unlicensed', seatsInUse: 4 });
    }
  });

  it('lets the operator read where things stand, and not the advisories', async () => {
    const { database } = databaseDouble();
    const service = createServiceContext(randomUUID());
    await expect(getLicenseStatus(database, service, status(at('2030-01-01')))).resolves.toMatchObject({
      standing: 'unlicensed',
    });
    await expect(listAdvisories(database, service, status(at('2030-01-01')))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not show one tenant what another installed', async () => {
    const { database } = databaseDouble();
    const organizationId = randomUUID();
    await installSignedDocument(database, asRole('owner', organizationId), { envelope: signedLicense }, { trustRoot: root });
    const other = asRole('owner');
    await expect(getLicenseStatus(database, other, status(at('2030-01-01')))).resolves.toMatchObject({
      standing: 'unlicensed',
      license: null,
    });
    await expect(readVerifiedLicenseFacts(database, other, { trustRoot: root })).resolves.toBeNull();
    await expect(
      installSignedDocument(database, other, { envelope: lapsedStatement }, { trustRoot: root }),
    ).rejects.toMatchObject({ code: 'LICENSE_NOT_VALID' });
  });

  it('answers QA-021 from what was installed, every time', async () => {
    const { database } = databaseDouble(3);
    const owner = asRole('owner');
    await installSignedDocument(database, owner, { envelope: signedLicense }, { trustRoot: root });
    await installSignedDocument(database, owner, { envelope: lapsedStatement }, { trustRoot: root });

    const lapsed = { standing: 'licensed', notices: ['maintenance_lapsed'] };
    await expect(getLicenseStatus(database, owner, status(at('2030-01-01')))).resolves.toMatchObject(lapsed);
    await expect(getLicenseStatus(database, owner, status(at('2040-01-01')))).resolves.toMatchObject(lapsed);
    const unverifiable = { standing: 'unverifiable', license: null, notices: ['license_unverifiable'] };
    await expect(
      getLicenseStatus(database, owner, status(at('2030-01-01'), null)),
    ).resolves.toMatchObject(unverifiable);
    await expect(
      getLicenseStatus(database, owner, status(at('2030-01-01'), strangersRoot)),
    ).resolves.toMatchObject(unverifiable);
  });

  it('gives facts from the envelope, with no permission and no way to say stop', async () => {
    const { database } = databaseDouble();
    const owner = asRole('owner');
    await installSignedDocument(database, owner, { envelope: signedLicense }, { trustRoot: root });
    await expect(readVerifiedLicenseFacts(database, asRole('member', owner.organizationId), { trustRoot: root })).resolves.toEqual({
      licenseId: LICENSE_ID,
      components: ['web', 'worker'],
      footprint: testLicense().footprint,
    });
    await expect(readVerifiedLicenseFacts(database, owner, { trustRoot: null })).resolves.toBeNull();
    await expect(readVerifiedLicenseFacts(database, owner, { trustRoot: strangersRoot })).resolves.toBeNull();
  });

  it('lists an installed advisory for someone who may read', async () => {
    const { database } = databaseDouble();
    const owner = asRole('owner');
    const advisory = signForTest(
      'advisory',
      {
        format: 'ensemus.advisory',
        format_version: 1,
        advisory_id: 'TEST-ADV-9',
        issued_at: '2027-02-01T00:00:00.000Z',
        severity: 'low',
        title: 'A generated advisory',
        summary: 'Generated for a test.',
        affected_versions: ['2.0.0'],
        fixed_in_versions: [],
      },
      [key],
    );
    const installed = await installSignedDocument(database, owner, { envelope: advisory }, { trustRoot: root });
    expect(installed.type).toBe('advisory');
    const views = await listAdvisories(database, asRole('admin', owner.organizationId), {
      trustRoot: root,
      runningRelease: release({ version: '2.0.0' }),
    });
    expect(views).toMatchObject([{ advisoryId: 'TEST-ADV-9', affectsThisRelease: true }]);
  });
});
