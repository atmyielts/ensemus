// SEC-01, threat SEC-004. Whether data may leave, proved over the whole table: every class against every
// destination, then each way a profile can fall short, then properties no input may break.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BILLING_OWNERS,
  CLASSIFICATIONS,
  EGRESS_DESTINATIONS,
  MODEL_PURPOSES,
  RETENTION_BASES,
  type AiClassification,
  type EgressDestination,
} from '@ensemus/domain/ai';
import { describe, expect, it } from 'vitest';
import { strongest } from './classification';
import { decideEgress, EGRESS_MATRIX_SOURCE, matrixCell } from './egress';
import type { EgressInput, EgressProfileFacts, TenantPolicyBundle } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(here, '..', '..', '..', 'docs', 'specifications', 'data-egress-matrix.csv');

/** The facts of a profile that passes every rule at every class, so each test can take one thing away. */
function fullyApproved(
  destination: EgressDestination,
  overrides: Partial<EgressProfileFacts> = {},
): EgressProfileFacts {
  const isPrivate = destination === 'customer_private_inference';
  return {
    id: 'profile-1',
    version: 1,
    active: true,
    destination,
    destinationHost: 'model.example.invalid',
    billingOwner: destination === 'ensemus_cloud_managed_model' ? 'ensemus' : 'customer',
    region: 'eu',
    allowedClasses: CLASSIFICATIONS,
    allowedPurposes: MODEL_PURPOSES,
    retentionBasis: isPrivate ? 'self_hosted' : 'contract_recorded',
    contractRef: 'contract-record-1',
    ...overrides,
  };
}

function input(overrides: Partial<EgressInput> = {}): EgressInput {
  return {
    dataClass: 'public',
    purpose: 'reason',
    requiredRegion: null,
    bundle: null,
    now: new Date('2026-11-06T00:00:00Z'),
    profile: fullyApproved('customer_byom_public_api'),
    ...overrides,
  };
}

const EXTERNAL: readonly EgressDestination[] = [
  'ensemus_cloud_managed_model',
  'customer_byom_public_api',
];

describe('the table', () => {
  it('is the CSV, as source text', () => {
    const csv = readFileSync(CSV_PATH, 'utf8').replace(/\r\n/g, '\n').trim();
    expect(EGRESS_MATRIX_SOURCE.trim()).toBe(csv);
  });

  it('names a rule for every class and destination', () => {
    for (const dataClass of CLASSIFICATIONS) {
      for (const destination of EGRESS_DESTINATIONS) {
        expect(matrixCell(dataClass, destination), `${dataClass}/${destination}`).toBeDefined();
      }
    }
  });

  it('has no rule for a class or destination it does not know', () => {
    expect(matrixCell('secret' as AiClassification, 'customer_byom_public_api')).toBeUndefined();
    expect(matrixCell('public', 'someone_else' as EgressDestination)).toBeUndefined();
    expect(matrixCell('__proto__' as AiClassification, 'customer_byom_public_api')).toBeUndefined();
  });
});

describe('the full matrix, with a profile that has everything', () => {
  const expected: Record<AiClassification, Record<EgressDestination, 'allow' | 'deny'>> = {
    public: {
      ensemus_cloud_managed_model: 'allow',
      customer_byom_public_api: 'allow',
      customer_private_inference: 'allow',
    },
    internal: {
      ensemus_cloud_managed_model: 'allow',
      customer_byom_public_api: 'allow',
      customer_private_inference: 'allow',
    },
    confidential: {
      ensemus_cloud_managed_model: 'allow',
      customer_byom_public_api: 'allow',
      customer_private_inference: 'allow',
    },
    restricted: {
      ensemus_cloud_managed_model: 'deny',
      customer_byom_public_api: 'deny',
      customer_private_inference: 'allow',
    },
  };

  for (const dataClass of CLASSIFICATIONS) {
    for (const destination of EGRESS_DESTINATIONS) {
      it(`${dataClass} to ${destination}: ${expected[dataClass][destination]}`, () => {
        const decision = decideEgress(input({ dataClass, profile: fullyApproved(destination) }));
        expect(decision.decision).toBe(expected[dataClass][destination]);
      });
    }
  }
});

describe('what each cell asks for', () => {
  it('public needs only an approved class and purpose, not a region or a contract', () => {
    for (const destination of EGRESS_DESTINATIONS) {
      const decision = decideEgress(
        input({
          profile: fullyApproved(destination, {
            region: null,
            contractRef: null,
            retentionBasis: 'unreviewed',
            allowedClasses: ['public'],
          }),
        }),
      );
      expect(decision.decision, destination).toBe('allow');
    }
  });

  it('internal to an outside provider needs a known region', () => {
    for (const destination of EXTERNAL) {
      const decision = decideEgress(
        input({ dataClass: 'internal', profile: fullyApproved(destination, { region: null }) }),
      );
      expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'REGION_REQUIRED' });
    }
  });

  it('internal to private inference needs no region, but does need the purpose', () => {
    const noRegion = decideEgress(
      input({
        dataClass: 'internal',
        profile: fullyApproved('customer_private_inference', { region: null }),
      }),
    );
    expect(noRegion.decision).toBe('allow');
    // 04-security/02 says "policy + approved purpose" where the CSV says only "approved profile". G7.
    const noPurpose = decideEgress(
      input({
        dataClass: 'internal',
        profile: fullyApproved('customer_private_inference', { allowedPurposes: ['classify'] }),
      }),
    );
    expect(noPurpose).toMatchObject({ decision: 'deny', reasonCode: 'PURPOSE_NOT_ON_PROFILE' });
  });

  it('confidential to an outside provider needs a recorded contract', () => {
    for (const destination of EXTERNAL) {
      for (const lacking of [
        { contractRef: null },
        { contractRef: '   ' },
        { retentionBasis: 'unreviewed' as const },
        { retentionBasis: 'self_hosted' as const },
      ]) {
        const decision = decideEgress(
          input({ dataClass: 'confidential', profile: fullyApproved(destination, lacking) }),
        );
        expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'CONTRACT_MISSING' });
      }
    }
  });

  it('confidential to an outside provider is never easier than internal: it needs a region too', () => {
    const decision = decideEgress(
      input({
        dataClass: 'confidential',
        profile: fullyApproved('customer_byom_public_api', { region: null }),
      }),
    );
    expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'REGION_REQUIRED' });
  });

  it('confidential to private inference needs a reviewed basis, and no outside contract', () => {
    const selfHosted = decideEgress(
      input({
        dataClass: 'confidential',
        profile: fullyApproved('customer_private_inference', { contractRef: null }),
      }),
    );
    expect(selfHosted.decision).toBe('allow');
    const unreviewed = decideEgress(
      input({
        dataClass: 'confidential',
        profile: fullyApproved('customer_private_inference', { retentionBasis: 'unreviewed' }),
      }),
    );
    expect(unreviewed).toMatchObject({ decision: 'deny', reasonCode: 'CONTRACT_MISSING' });
  });

  it('restricted reaches only a self-hosted model that lists it', () => {
    const listed = decideEgress(
      input({ dataClass: 'restricted', profile: fullyApproved('customer_private_inference') }),
    );
    expect(listed.decision).toBe('allow');

    const contractOnly = decideEgress(
      input({
        dataClass: 'restricted',
        profile: fullyApproved('customer_private_inference', {
          retentionBasis: 'contract_recorded',
        }),
      }),
    );
    expect(contractOnly).toMatchObject({ decision: 'deny', reasonCode: 'CLASS_DENIED' });

    const notListed = decideEgress(
      input({
        dataClass: 'restricted',
        profile: fullyApproved('customer_private_inference', {
          allowedClasses: ['public', 'internal', 'confidential'],
        }),
      }),
    );
    expect(notListed).toMatchObject({ decision: 'deny', reasonCode: 'CLASS_NOT_ON_PROFILE' });
  });
});

describe('deny beats allow', () => {
  it('restricted denies an outside provider, even when the profile lists it and has a contract', () => {
    for (const destination of EXTERNAL) {
      const decision = decideEgress(
        input({
          dataClass: 'restricted',
          profile: fullyApproved(destination, { allowedClasses: ['restricted'] }),
        }),
      );
      expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'CLASS_DENIED' });
    }
  });

  it('a class the profile does not list is denied, whatever the matrix would allow', () => {
    const decision = decideEgress(
      input({
        dataClass: 'internal',
        profile: fullyApproved('customer_byom_public_api', { allowedClasses: ['public'] }),
      }),
    );
    expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'CLASS_NOT_ON_PROFILE' });
  });

  it('a profile that is not active is denied at every class', () => {
    for (const dataClass of CLASSIFICATIONS) {
      for (const destination of EGRESS_DESTINATIONS) {
        const decision = decideEgress(
          input({ dataClass, profile: fullyApproved(destination, { active: false }) }),
        );
        expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'PROFILE_NOT_ACTIVE' });
      }
    }
  });
});

describe('regions', () => {
  it('denies the wrong region, at every class, for every destination', () => {
    for (const dataClass of CLASSIFICATIONS) {
      for (const destination of EGRESS_DESTINATIONS) {
        const decision = decideEgress(
          input({ dataClass, requiredRegion: 'us', profile: fullyApproved(destination) }),
        );
        expect(decision.decision).toBe('deny');
      }
    }
  });

  it('names wrong region as the reason', () => {
    const decision = decideEgress(input({ requiredRegion: 'us' }));
    expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'WRONG_REGION' });
  });

  it('denies a profile whose region is unknown when one is required', () => {
    const decision = decideEgress(
      input({
        requiredRegion: 'eu',
        profile: fullyApproved('customer_byom_public_api', { region: null }),
      }),
    );
    expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'WRONG_REGION' });
  });

  it('allows the right region', () => {
    expect(decideEgress(input({ requiredRegion: 'eu' })).decision).toBe('allow');
  });
});

describe('a tenant bundle only tightens', () => {
  it('denies a class on a destination', () => {
    const bundle: TenantPolicyBundle = {
      version: '3',
      denyClasses: { customer_byom_public_api: ['internal'] },
    };
    const decision = decideEgress(input({ dataClass: 'internal', bundle }));
    expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'CLASS_DENIED' });
  });

  it('denying a class denies every stronger one too, so a stronger class is never easier', () => {
    const bundle: TenantPolicyBundle = {
      version: '3',
      denyClasses: { customer_byom_public_api: ['internal'] },
    };
    const decision = decideEgress(input({ dataClass: 'confidential', bundle }));
    expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'CLASS_DENIED' });
    expect(decideEgress(input({ dataClass: 'public', bundle })).decision).toBe('allow');
  });

  it('leaves other destinations alone', () => {
    const bundle: TenantPolicyBundle = {
      version: '3',
      denyClasses: { ensemus_cloud_managed_model: ['public'] },
    };
    expect(decideEgress(input({ bundle })).decision).toBe('allow');
  });

  it('limits regions', () => {
    const decision = decideEgress(input({ bundle: { version: '3', allowedRegions: ['us'] } }));
    expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'WRONG_REGION' });
    const empty = decideEgress(input({ bundle: { version: '3', allowedRegions: [] } }));
    expect(empty).toMatchObject({ decision: 'deny', reasonCode: 'WRONG_REGION' });
  });

  it('a profile with no region cannot meet a region list', () => {
    const decision = decideEgress(
      input({
        bundle: { version: '3', allowedRegions: ['eu'] },
        profile: fullyApproved('customer_byom_public_api', { region: null }),
      }),
    );
    expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'WRONG_REGION' });
  });

  it('cannot allow restricted to an outside provider, whatever the document says', () => {
    const loosening = {
      version: '3',
      allow: { customer_byom_public_api: ['restricted'] },
      allowClasses: { customer_byom_public_api: ['restricted'] },
      denyClasses: {},
      default: 'allow',
      decision: 'allow',
    } as unknown as TenantPolicyBundle;
    const decision = decideEgress(input({ dataClass: 'restricted', bundle: loosening }));
    expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'CLASS_DENIED' });
  });

  it('cannot waive a missing contract or a region or a class on the profile', () => {
    const loosening = {
      version: '3',
      waive: ['contract', 'region'],
      contractRef: 'made-up',
      allowedClasses: ['confidential'],
    } as unknown as TenantPolicyBundle;
    const missingContract = decideEgress(
      input({
        dataClass: 'confidential',
        bundle: loosening,
        profile: fullyApproved('customer_byom_public_api', { contractRef: null }),
      }),
    );
    expect(missingContract).toMatchObject({ decision: 'deny', reasonCode: 'CONTRACT_MISSING' });
  });

  it('a malformed bundle denies, because a tightening we cannot read may be a tightening we skip', () => {
    for (const bundle of [
      { version: 3 },
      { version: '3', denyClasses: 'everything' },
      { version: '3', denyClasses: { customer_byom_public_api: 'internal' } },
      { version: '3', allowedRegions: 'eu' },
      'not an object',
    ]) {
      const decision = decideEgress(input({ bundle: bundle as unknown as TenantPolicyBundle }));
      expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'POLICY_UNREADABLE' });
    }
  });

  it('names the bundle in the policy version, so a decision can be traced to what was in force', () => {
    const without = decideEgress(input()).policyVersion;
    const withBundle = decideEgress(input({ bundle: { version: '3' } })).policyVersion;
    expect(withBundle).not.toBe(without);
    expect(withBundle).toContain('3');
  });
});

describe('unknown input denies', () => {
  const cases: [string, Partial<EgressInput> | Record<string, unknown>][] = [
    ['an unknown class', { dataClass: 'top-secret' }],
    ['a class that names a prototype member', { dataClass: 'constructor' }],
    ['an unknown purpose', { purpose: 'anything' }],
    ['no required region given', { requiredRegion: undefined }],
    ['a required region of the wrong type', { requiredRegion: 7 }],
    ['an invalid clock', { now: new Date('not a date') }],
    ['no clock', { now: undefined }],
    ['no profile', { profile: null }],
    [
      'an unknown destination',
      {
        profile: fullyApproved('customer_byom_public_api', {
          destination: 'x' as EgressDestination,
        }),
      },
    ],
    [
      'an unknown billing owner',
      { profile: fullyApproved('customer_byom_public_api', { billingOwner: 'x' as 'customer' }) },
    ],
    [
      'an unknown retention basis',
      {
        profile: fullyApproved('customer_byom_public_api', { retentionBasis: 'x' as 'unreviewed' }),
      },
    ],
    [
      'classes that are not a list',
      {
        profile: fullyApproved('customer_byom_public_api', {
          allowedClasses: 'public' as unknown as readonly AiClassification[],
        }),
      },
    ],
    [
      'purposes that are not a list',
      {
        profile: fullyApproved('customer_byom_public_api', {
          allowedPurposes: null as unknown as readonly 'reason'[],
        }),
      },
    ],
    [
      'a profile with no host',
      { profile: fullyApproved('customer_byom_public_api', { destinationHost: '' }) },
    ],
    ['a profile with no ID', { profile: fullyApproved('customer_byom_public_api', { id: '' }) }],
    [
      'a profile with a bad version',
      { profile: fullyApproved('customer_byom_public_api', { version: 0 }) },
    ],
    [
      'an active flag that is only truthy',
      {
        profile: fullyApproved('customer_byom_public_api', { active: 'yes' as unknown as boolean }),
      },
    ],
    [
      'a managed destination billed to the customer',
      { profile: fullyApproved('ensemus_cloud_managed_model', { billingOwner: 'customer' }) },
    ],
    [
      'a customer destination billed to Ensemus',
      { profile: fullyApproved('customer_byom_public_api', { billingOwner: 'ensemus' }) },
    ],
  ];

  for (const [name, overrides] of cases) {
    it(name, () => {
      const decision = decideEgress({ ...input(), ...overrides } as EgressInput);
      expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'UNKNOWN_INPUT' });
    });
  }

  it('no input at all', () => {
    for (const nothing of [null, undefined, 'public', 7]) {
      const decision = decideEgress(nothing as unknown as EgressInput);
      expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'UNKNOWN_INPUT' });
    }
  });

  it('a profile that throws when read denies rather than throws', () => {
    const profile = new Proxy(fullyApproved('customer_byom_public_api'), {
      get() {
        throw new Error('unreadable');
      },
    });
    const decision = decideEgress(input({ profile }));
    expect(decision).toMatchObject({ decision: 'deny', reasonCode: 'POLICY_UNREADABLE' });
  });
});

describe('what an allow carries', () => {
  it('obliges a scan before anything is sent, and says the policy version', () => {
    const decision = decideEgress(input());
    expect(decision).toMatchObject({
      decision: 'allow',
      reasonCode: 'ALLOWED',
      obligations: ['scan_before_send'],
    });
    expect(decision.policyVersion).toMatch(/^egress-/);
  });

  it('a deny carries no obligations, because nothing is going anywhere', () => {
    expect(decideEgress(input({ dataClass: 'restricted' })).obligations).toEqual([]);
  });

  it('holds for one turn and carries no expiry to reuse it by: each turn decides again (FD-13)', () => {
    expect(decideEgress(input()).expiresAt).toBeNull();
  });
});

/** Every way of filling in the facts that a test can reach in a reasonable time. */
function* everyInput(): Generator<EgressInput> {
  const classLists: readonly (readonly AiClassification[])[] = [
    [],
    ['public'],
    ['public', 'internal'],
    ['confidential'],
    ['restricted'],
    CLASSIFICATIONS,
  ];
  for (const dataClass of CLASSIFICATIONS) {
    for (const destination of EGRESS_DESTINATIONS) {
      for (const billingOwner of BILLING_OWNERS) {
        for (const retentionBasis of RETENTION_BASES) {
          for (const active of [true, false]) {
            for (const allowedClasses of classLists) {
              for (const allowedPurposes of [[], ['reason'], ['classify']] as const) {
                for (const contractRef of [null, 'contract-record-1']) {
                  for (const region of [null, 'eu']) {
                    for (const requiredRegion of [null, 'eu', 'us']) {
                      yield {
                        dataClass,
                        purpose: 'reason',
                        requiredRegion,
                        bundle: null,
                        now: new Date(0),
                        profile: {
                          id: 'profile-1',
                          version: 1,
                          active,
                          destination,
                          destinationHost: 'model.example.invalid',
                          billingOwner,
                          region,
                          allowedClasses,
                          allowedPurposes,
                          retentionBasis,
                          contractRef,
                        },
                      };
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

describe('properties, over every combination of facts', () => {
  it('no input yields allow without an approved, active profile', () => {
    let allowed = 0;
    let checked = 0;
    for (const each of everyInput()) {
      checked += 1;
      const decision = decideEgress(each);
      if (decision.decision !== 'allow') continue;
      allowed += 1;
      expect(each.profile.active).toBe(true);
      expect(each.profile.allowedClasses).toContain(each.dataClass);
      expect(each.profile.allowedPurposes).toContain(each.purpose);
      expect(decision.obligations).toContain('scan_before_send');
    }
    // A control, so a table that denied everything could not pass this by accident.
    expect(checked).toBeGreaterThan(10_000);
    expect(allowed).toBeGreaterThan(0);
  });

  it('restricted never reaches an outside provider', () => {
    for (const each of everyInput()) {
      if (each.dataClass !== 'restricted') continue;
      if (each.profile.destination === 'customer_private_inference') continue;
      expect(decideEgress(each).decision).toBe('deny');
    }
  });

  it('confidential never reaches an outside provider without a contract', () => {
    for (const each of everyInput()) {
      if (each.dataClass !== 'confidential') continue;
      if (each.profile.destination === 'customer_private_inference') continue;
      if (each.profile.contractRef !== null) continue;
      expect(decideEgress(each).decision).toBe('deny');
    }
  });

  it('a required region is never crossed', () => {
    for (const each of everyInput()) {
      if (each.requiredRegion === null || each.requiredRegion === each.profile.region) continue;
      expect(decideEgress(each).decision).toBe('deny');
    }
  });

  it('a stronger class is never easier, for a profile that lists both', () => {
    for (const each of everyInput()) {
      const decision = decideEgress(each);
      if (decision.decision !== 'allow') continue;
      for (const weaker of CLASSIFICATIONS) {
        if (strongest(weaker, each.dataClass) !== each.dataClass) continue;
        const easier = decideEgress({
          ...each,
          dataClass: weaker,
          profile: { ...each.profile, allowedClasses: CLASSIFICATIONS },
        });
        expect(easier.decision, `${each.dataClass} allowed but ${weaker} was not`).toBe('allow');
      }
    }
  });

  it('adding a bundle never turns a deny into an allow', () => {
    const bundles: readonly TenantPolicyBundle[] = [
      { version: '1' },
      { version: '1', allowedRegions: ['eu'] },
      { version: '1', denyClasses: { customer_byom_public_api: ['public'] } },
      { version: '1', denyClasses: { customer_private_inference: ['restricted'] } },
    ];
    for (const each of everyInput()) {
      const without = decideEgress(each);
      if (without.decision === 'allow') continue;
      for (const bundle of bundles) {
        expect(decideEgress({ ...each, bundle }).decision).toBe('deny');
      }
    }
  });
});
