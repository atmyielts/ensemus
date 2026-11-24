// ADR-035 D1 and D3: the pure rules. tests/unit/federation-rules.test.ts holds them equal to the SQL.
import { describe, expect, it } from 'vitest';
import {
  buildGrantTerms,
  canTransitionGrant,
  classificationAllowed,
  directionOf,
  grantTermsHash,
  hashFederationToken,
  inboundObjectKey,
  isGrantOpen,
  itemContentHash,
  kindAllowed,
  newFederationToken,
  organizationFingerprint,
  outboundObjectKey,
} from './federation';

const ORG_A = '6f1c2c6e-1111-4111-8111-111111111111';
const ORG_B = '6f1c2c6e-2222-4222-8222-222222222222';
const ITEM = '6f1c2c6e-3333-4333-8333-333333333333';

const terms = (overrides: Partial<Parameters<typeof buildGrantTerms>[0]> = {}) =>
  buildGrantTerms({
    purpose: 'delegated_work',
    maxClassification: 'internal',
    sharingOrganizationId: ORG_A,
    sharingDisplayName: 'A test company',
    expiresAt: new Date('2027-01-01T00:00:00Z'),
    note: null,
    ...overrides,
  });

describe('the terms two owners agree to', () => {
  it('hash the same for the same terms', () => {
    expect(grantTermsHash(terms())).toBe(grantTermsHash(terms()));
  });

  it.each([
    ['the purpose', { purpose: 'document_review' as const }],
    ['the limit', { maxClassification: 'confidential' as const }],
    ['the organization', { sharingOrganizationId: ORG_B }],
    ['the name', { sharingDisplayName: 'A different company' }],
    ['the date', { expiresAt: new Date('2027-01-02T00:00:00Z') }],
    ['the note', { note: 'Something else' }],
  ])('hash differently if %s changes', (_, change) => {
    expect(grantTermsHash(terms(change))).not.toBe(grantTermsHash(terms()));
  });

  it('spell out what may go each way, so a later change cannot alter an old agreement', () => {
    expect(terms().forward_kinds).toEqual(['work_summary', 'artifact']);
    expect(terms().return_kinds).toEqual(['status_update', 'artifact']);
    expect(terms({ purpose: 'document_review' }).forward_kinds).toEqual(['artifact']);
  });
});

describe('what may cross', () => {
  it('follows the purpose and the direction', () => {
    expect(kindAllowed('delegated_work', 'forward', 'work_summary')).toBe(true);
    expect(kindAllowed('delegated_work', 'return', 'work_summary')).toBe(false);
    expect(kindAllowed('document_review', 'forward', 'work_summary')).toBe(false);
    expect(kindAllowed('document_review', 'return', 'artifact')).toBe(false);
  });

  it('stays under the grant’s limit', () => {
    expect(classificationAllowed('internal', 'public')).toBe(true);
    expect(classificationAllowed('internal', 'internal')).toBe(true);
    expect(classificationAllowed('internal', 'confidential')).toBe(false);
  });

  it.each(['restricted', 'secret', '', '__proto__', 'constructor'])(
    'treats %j as too sensitive for every grant',
    (classification) => {
      expect(classificationAllowed('confidential', classification)).toBe(false);
    },
  );

  it('knows which way something is going, and that a third tenant is neither', () => {
    const grant = { sharingOrganizationId: ORG_A, receivingOrganizationId: ORG_B };
    expect(directionOf(grant, ORG_A)).toBe('forward');
    expect(directionOf(grant, ORG_B)).toBe('return');
    expect(directionOf(grant, ITEM)).toBeNull();
    expect(
      directionOf({ sharingOrganizationId: ORG_A, receivingOrganizationId: null }, ITEM),
    ).toBeNull();
  });
});

describe('an open grant', () => {
  const later = new Date('2027-01-01T00:00:00Z');
  const now = new Date('2026-12-01T00:00:00Z');

  it('is active and before its date', () => {
    expect(isGrantOpen({ status: 'active', expiresAt: later }, now)).toBe(true);
  });

  it.each(['proposed', 'accepted', 'ended'] as const)('is not %s', (status) => {
    expect(isGrantOpen({ status, expiresAt: later }, now)).toBe(false);
  });

  it('is closed at its date, before anything sweeps it', () => {
    expect(isGrantOpen({ status: 'active', expiresAt: now }, now)).toBe(false);
  });

  it('never moves on from ended', () => {
    for (const to of ['proposed', 'accepted', 'active', 'ended'] as const) {
      expect(canTransitionGrant('ended', to)).toBe(false);
    }
  });

  it('skips no consent', () => {
    expect(canTransitionGrant('proposed', 'active')).toBe(false);
    expect(canTransitionGrant('proposed', 'accepted')).toBe(true);
    expect(canTransitionGrant('accepted', 'active')).toBe(true);
  });
});

describe('tokens and fingerprints', () => {
  it('makes a token nobody can guess, and stores only its hash', () => {
    const token = newFederationToken();
    expect(token).not.toBe(newFederationToken());
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hashFederationToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFederationToken(token)).not.toContain(token);
  });

  it('gives one fingerprint to one organization, however its ID is spelled', () => {
    expect(organizationFingerprint(ORG_A)).toBe(organizationFingerprint(ORG_A.toUpperCase()));
    expect(organizationFingerprint(ORG_A)).not.toBe(organizationFingerprint(ORG_B));
    expect(organizationFingerprint(ORG_A)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('object keys', () => {
  it('are the strings the tables insist on, in the database’s own spelling', () => {
    expect(outboundObjectKey(ORG_A.toUpperCase(), ITEM)).toBe(
      `federation/outbound/${ORG_A}/${ITEM}`,
    );
    expect(inboundObjectKey(ORG_B, ITEM.toUpperCase())).toBe(`federation/inbound/${ORG_B}/${ITEM}`);
  });
});

describe('the hash of an item', () => {
  const item = {
    kind: 'work_summary' as const,
    classification: 'internal',
    title: 'A title',
    body: { objective: 'Something', due_at: '2027-01-01T00:00:00Z' },
    fileSha256: null,
  };

  it('does not care about key order', () => {
    expect(itemContentHash(item)).toBe(
      itemContentHash({
        ...item,
        body: { due_at: '2027-01-01T00:00:00Z', objective: 'Something' },
      }),
    );
  });

  it('covers every part of it', () => {
    expect(itemContentHash({ ...item, title: 'Another' })).not.toBe(itemContentHash(item));
    expect(itemContentHash({ ...item, classification: 'public' })).not.toBe(itemContentHash(item));
    expect(itemContentHash({ ...item, fileSha256: 'a'.repeat(64) })).not.toBe(
      itemContentHash(item),
    );
  });
});
