import { describe, expect, it } from 'vitest';
import {
  compareReleaseVersions,
  evaluateUpdateRight,
  isDateOnly,
  licenseNotices,
  maintenanceStatus,
  type ReleaseFacts,
  type UpdateRights,
} from './license';

const rights: UpdateRights = {
  security_patches_after_lapse: 'none',
  major_versions_with_maintenance: 'separate_purchase',
  releases_published_during_maintenance: 'kept_after_lapse',
  outside_rights_on_install: 'warn',
};
const license = { licensed_release: { line: '2.0', version: '2.0.0' }, update_rights: rights };
const agreement = { starts_on: '2027-01-01', ends_on: '2027-12-31' };
const release = (facts: Partial<ReleaseFacts>): ReleaseFacts => ({
  version: '2.0.1',
  line: '2.0',
  kind: 'patch',
  security: false,
  published_on: '2027-06-01',
  ...facts,
});
const verdict = (
  facts: Partial<ReleaseFacts>,
  extra: Partial<Parameters<typeof evaluateUpdateRight>[0]> = {},
) =>
  evaluateUpdateRight({
    license,
    agreements: [agreement],
    policies: [],
    release: release(facts),
    today: '2028-06-01',
    ...extra,
  });

describe('release versions', () => {
  it('orders by number, so 2.10 is newer than 2.9', () => {
    expect(compareReleaseVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareReleaseVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('refuses what is not a plain version, and does not guess', () => {
    expect(() => compareReleaseVersions('2.0', '2.0.0')).toThrow();
    expect(() => compareReleaseVersions('2.0.0-rc1', '2.0.0')).toThrow();
  });
});

describe('maintenance status (SOV-02)', () => {
  it('says what the dates say, and the last covered day counts as covered', () => {
    expect(maintenanceStatus([], '2027-06-01').status).toBe('no_agreement');
    expect(maintenanceStatus([agreement], '2026-12-31').status).toBe('not_started');
    expect(maintenanceStatus([agreement], '2027-12-31').status).toBe('active');
    expect(maintenanceStatus([agreement], '2028-01-01')).toEqual({
      status: 'lapsed',
      lastCoveredOn: '2027-12-31',
    });
  });

  it('takes the latest of several agreements, in any order', () => {
    const renewal = { starts_on: '2028-01-01', ends_on: '2028-12-31' };
    expect(maintenanceStatus([renewal, agreement], '2028-06-01').status).toBe('active');
    expect(maintenanceStatus([agreement, renewal], '2029-01-01').lastCoveredOn).toBe('2028-12-31');
  });
});

describe('update rights (OPS-11, SOV-05)', () => {
  it('always covers what was bought and anything older, with no agreement at all', () => {
    expect(verdict({ version: '2.0.0' }, { agreements: [] }).basis).toBe('licensed_release');
    expect(verdict({ version: '1.9.0', line: '1.9' }, { agreements: [] }).covered).toBe(true);
  });

  it('keeps a release published during maintenance after the lapse, on the signed dates', () => {
    expect(verdict({}).basis).toBe('maintenance');
    expect(verdict({ published_on: '2028-01-01' }).covered).toBe(false);
  });

  it('asks today only where the license says rights are not kept', () => {
    const notKept = {
      ...license,
      update_rights: { ...rights, releases_published_during_maintenance: 'not_kept' as const },
    };
    expect(verdict({}, { license: notKept }).covered).toBe(false);
    expect(verdict({}, { license: notKept, today: '2027-12-31' }).basis).toBe('maintenance');
  });

  it('does not let moving the clock grant a release published after the lapse', () => {
    expect(verdict({ published_on: '2028-03-01' }, { today: '2027-06-01' }).covered).toBe(false);
  });

  it('reaches a new major version only if the license says so', () => {
    const major = { version: '3.0.0', line: '3.0', kind: 'major' as const };
    expect(verdict(major).covered).toBe(false);
    const included = {
      ...license,
      update_rights: { ...rights, major_versions_with_maintenance: 'included' as const },
    };
    expect(verdict(major, { license: included }).basis).toBe('maintenance');
  });

  it('gives security patches after a lapse only where the license or a policy grants them', () => {
    const late = { published_on: '2028-03-01', security: true };
    expect(verdict(late).covered).toBe(false);
    const granted = {
      ...license,
      update_rights: { ...rights, security_patches_after_lapse: 'licensed_line' as const },
    };
    expect(verdict(late, { license: granted }).basis).toBe('security_after_lapse');
    expect(verdict({ ...late, security: false }, { license: granted }).covered).toBe(false);
    expect(verdict({ ...late, line: '2.1', version: '2.1.1' }, { license: granted }).covered).toBe(
      false,
    );
  });

  it('lets a later policy add to a license that granted nothing, with no new license', () => {
    const late = { published_on: '2028-03-01', security: true };
    const policy = (grant: 'none' | 'licensed_line' | 'any_supported_line') => ({
      branches: [{ line: '2.1', status: 'supported' as const }],
      security_patches_after_lapse_grant: grant,
    });
    expect(verdict(late, { policies: [policy('none')] }).covered).toBe(false);
    expect(verdict(late, { policies: [policy('licensed_line')] }).basis).toBe(
      'support_policy_grant',
    );
    expect(
      verdict(
        { ...late, line: '2.1', version: '2.1.1' },
        { policies: [policy('any_supported_line')] },
      ).covered,
    ).toBe(true);
  });

  it('gives no policy a way to take back what a license granted', () => {
    const granted = {
      ...license,
      update_rights: { ...rights, security_patches_after_lapse: 'licensed_line' as const },
    };
    const none = {
      branches: [{ line: '2.0', status: 'end_of_support' as const }],
      security_patches_after_lapse_grant: 'none' as const,
    };
    expect(
      verdict(
        { published_on: '2028-03-01', security: true },
        { license: granted, policies: [none] },
      ).covered,
    ).toBe(true);
  });

  it('says what the license says about the rest, and only about a new install', () => {
    const late = { published_on: '2028-03-01' };
    expect(verdict(late).onInstall).toBe('warn');
    const refuses = {
      ...license,
      update_rights: { ...rights, outside_rights_on_install: 'refuse' as const },
    };
    expect(verdict(late, { license: refuses }).onInstall).toBe('refuse');
  });
});

describe('what an administrator is told', () => {
  const base = {
    standing: 'licensed' as const,
    license: {
      term: { kind: 'perpetual' as const },
      issued_at: '2027-01-01T00:00:00.000Z',
      footprint: {
        organizations: null,
        seats: 10,
        production_deployments: null,
        nonproduction_deployments: null,
      },
    },
    maintenance: { status: 'active' as const, lastCoveredOn: '2027-12-31' },
    today: '2027-06-01',
    signedWithTestKey: false,
    signedWithRetiredKey: false,
    runningReleaseCovered: true,
    seatsInUse: 3,
  };

  it('says nothing when there is nothing to say', () => {
    expect(licenseNotices(base)).toEqual([]);
  });

  it('turns a lapse into one notice (QA-021)', () => {
    expect(
      licenseNotices({
        ...base,
        maintenance: { status: 'lapsed', lastCoveredOn: '2027-12-31' },
        today: '2031-01-01',
      }),
    ).toEqual(['maintenance_lapsed']);
  });

  it('notes a pilot review date, a test key, a stopped clock and too many seats', () => {
    expect(
      licenseNotices({
        ...base,
        license: {
          ...base.license,
          term: { kind: 'pilot', review_on: '2027-03-01' },
        },
        signedWithTestKey: true,
        seatsInUse: 11,
      }),
    ).toEqual(['pilot_review_due', 'signed_with_test_key', 'seats_above_footprint']);
    expect(licenseNotices({ ...base, today: '2020-01-01' })).toContain('clock_before_issue');
  });

  it('has no output a caller could refuse a request with', () => {
    const notices = licenseNotices({ ...base, standing: 'unverifiable', license: null });
    expect(notices).toEqual(['license_unverifiable']);
    expect(licenseNotices({ ...base, standing: 'unlicensed', license: null })).toEqual([
      'no_license',
    ]);
  });
});

describe('dates', () => {
  it('reads a real day and refuses the rest', () => {
    expect(isDateOnly('2027-01-31')).toBe(true);
    expect(isDateOnly('2027-13-01')).toBe(false);
    expect(isDateOnly('tomorrow')).toBe(false);
  });
});
