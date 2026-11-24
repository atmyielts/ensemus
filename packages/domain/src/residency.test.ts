// ADR-035 D5 and D6: what can honestly be said. Regions here are made up on purpose. Fails closed throughout.
import { describe, expect, it } from 'vitest';
import {
  checkResidency,
  NO_RESIDENCY_POLICY,
  requiredRegionFor,
  RESIDENCY_SURFACES,
  residencyPosture,
  type ResidencyPolicy,
} from './residency';
import { ISOLATION_ASPECTS, isolationPosture, type IsolationRecord } from './tenancy';

const HOME = 'test-region-a';
const ELSEWHERE = 'test-region-b';

const fullPolicy = (): ResidencyPolicy => ({
  homeRegion: HOME,
  surfaces: Object.fromEntries(
    RESIDENCY_SURFACES.map((surface) => [
      surface,
      { regions: [HOME], evidenceRef: `record-${surface}` },
    ]),
  ),
});

describe('a residency requirement', () => {
  it('prefers the data class’s own over the general one', () => {
    const requirements = [
      { scope: 'all' as const, region: HOME },
      { scope: 'confidential' as const, region: ELSEWHERE },
    ];
    expect(requiredRegionFor(requirements, 'confidential')).toBe(ELSEWHERE);
    expect(requiredRegionFor(requirements, 'internal')).toBe(HOME);
    expect(requiredRegionFor([], 'internal')).toBeNull();
  });
});

describe('the gate', () => {
  const required = [{ scope: 'all' as const, region: HOME }];

  it('allows with no requirement, and claims nothing', () => {
    expect(
      checkResidency({
        policy: NO_RESIDENCY_POLICY,
        requirements: [],
        surface: 'inference',
        classification: 'internal',
      }),
    ).toEqual({ allowed: true, requiredRegion: null });
  });

  it.each(RESIDENCY_SURFACES)('denies %s when nobody has declared it', (surface) => {
    expect(
      checkResidency({
        policy: NO_RESIDENCY_POLICY,
        requirements: required,
        surface,
        classification: 'internal',
      }),
    ).toEqual({ allowed: false, requiredRegion: HOME, code: 'SURFACE_UNDECLARED' });
  });

  it.each(RESIDENCY_SURFACES)('denies %s when any of it is elsewhere', (surface) => {
    const policy = fullPolicy();
    policy.surfaces = {
      ...policy.surfaces,
      [surface]: { regions: [HOME, ELSEWHERE], evidenceRef: 'x' },
    };
    expect(
      checkResidency({ policy, requirements: required, surface, classification: 'internal' }),
    ).toEqual({ allowed: false, requiredRegion: HOME, code: 'SURFACE_OUTSIDE_REGION' });
  });

  it.each(RESIDENCY_SURFACES)('allows %s when it is all declared in the region', (surface) => {
    expect(
      checkResidency({
        policy: fullPolicy(),
        requirements: required,
        surface,
        classification: 'internal',
      }).allowed,
    ).toBe(true);
  });

  it('believes a concrete target over the statement', () => {
    const base = {
      policy: fullPolicy(),
      requirements: required,
      surface: 'inference' as const,
      classification: 'internal',
    };
    expect(checkResidency({ ...base, targetRegion: HOME }).allowed).toBe(true);
    expect(checkResidency({ ...base, targetRegion: ELSEWHERE })).toEqual({
      allowed: false,
      requiredRegion: HOME,
      code: 'TARGET_OUTSIDE_REGION',
    });
  });

  it('denies a target that cannot say where it is', () => {
    expect(
      checkResidency({
        policy: fullPolicy(),
        requirements: required,
        surface: 'embeddings',
        classification: 'internal',
        targetRegion: null,
      }),
    ).toEqual({ allowed: false, requiredRegion: HOME, code: 'TARGET_REGION_UNKNOWN' });
  });

  it('applies a data class’s requirement only to that class', () => {
    const requirements = [{ scope: 'confidential' as const, region: HOME }];
    const base = { policy: NO_RESIDENCY_POLICY, requirements, surface: 'telemetry' as const };
    expect(checkResidency({ ...base, classification: 'internal' }).allowed).toBe(true);
    expect(checkResidency({ ...base, classification: 'confidential' }).allowed).toBe(false);
  });
});

describe('the in-region statement', () => {
  it('is withheld with nothing configured', () => {
    const posture = residencyPosture(NO_RESIDENCY_POLICY);
    expect(posture.allInRegion).toBe(false);
    expect(posture.surfaces.every((surface) => surface.state === 'undeclared')).toBe(true);
  });

  it('is made when every surface is declared in the region', () => {
    expect(residencyPosture(fullPolicy()).allInRegion).toBe(true);
  });

  it.each(RESIDENCY_SURFACES)('is withheld when %s is missing', (surface) => {
    const policy = fullPolicy();
    const { [surface]: _gone, ...rest } = policy.surfaces;
    expect(residencyPosture({ ...policy, surfaces: rest }).allInRegion).toBe(false);
  });

  it('is withheld when a connected model goes elsewhere, whatever was declared', () => {
    const posture = residencyPosture(fullPolicy(), { inference: [HOME, ELSEWHERE] });
    expect(posture.allInRegion).toBe(false);
    expect(posture.surfaces.find((surface) => surface.surface === 'inference')).toMatchObject({
      state: 'declared_in_region',
      observedElsewhere: [ELSEWHERE],
    });
  });

  it('is withheld with no home region, even if every surface names one', () => {
    const posture = residencyPosture({ ...fullPolicy(), homeRegion: null });
    expect(posture.allInRegion).toBe(false);
  });
});

describe('the isolated statement', () => {
  const RELEASE = 'test-release-1';
  const record = (
    aspect: IsolationRecord['aspect'],
    result: IsolationRecord['result'],
    releaseVersion = RELEASE,
    checkedAt = new Date('2026-11-01T00:00:00Z'),
  ): IsolationRecord => ({ aspect, result, code: null, releaseVersion, checkedAt });
  const PROBED = [
    'database',
    'network',
    'worker_pool',
    'temporal_namespace',
    'object_store',
  ] as const;
  const STATED = ['backups', 'embeddings', 'telemetry', 'key_encryption_key'] as const;
  const complete = () => [
    ...PROBED.map((aspect) => record(aspect, 'passed')),
    ...STATED.map((aspect) => record(aspect, 'declared')),
  ];

  it('is true only with everything recorded on this release', () => {
    expect(isolationPosture('dedicated', complete(), RELEASE).isolated).toBe(true);
  });

  it('is never true for a shared deployment', () => {
    expect(isolationPosture('shared', complete(), RELEASE).isolated).toBe(false);
  });

  it('is false with nothing recorded, and says each is unchecked', () => {
    const posture = isolationPosture('dedicated', [], RELEASE);
    expect(posture.isolated).toBe(false);
    expect(posture.aspects.map((aspect) => aspect.state)).toEqual(
      ISOLATION_ASPECTS.map(() => 'unchecked'),
    );
  });

  it.each(PROBED)('will not take a statement in place of a probe for %s', (aspect) => {
    const records = [...complete(), record(aspect, 'declared', RELEASE, new Date('2026-11-02'))];
    expect(isolationPosture('dedicated', records, RELEASE).isolated).toBe(false);
  });

  it.each(ISOLATION_ASPECTS)('is false after %s fails, whatever came before', (aspect) => {
    const records = [...complete(), record(aspect, 'failed', RELEASE, new Date('2026-11-02'))];
    expect(isolationPosture('dedicated', records, RELEASE).isolated).toBe(false);
  });

  it('goes stale on a new release, so nothing old stands in for a check', () => {
    const posture = isolationPosture('dedicated', complete(), 'test-release-2');
    expect(posture.isolated).toBe(false);
    expect(posture.aspects.every((aspect) => aspect.state === 'stale')).toBe(true);
  });
});
