// ADR-035 D5 and D6: unset means what a deployment has always been, and a mistake stops startup.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  deploymentProfileHash,
  loadExplicitTenancyConfig,
  loadResidencyPolicy,
  loadTenancyConfig,
} from './index';

const ORG = '6F1C2C6E-1111-4111-8111-111111111111';

describe('tenancy configuration', () => {
  it('is shared, unclaimed and off when unset', () => {
    expect(loadTenancyConfig({})).toEqual({
      tier: 'shared',
      pinnedOrganizationId: null,
      homeRegion: null,
      crossOrgEnabled: false,
    });
  });

  it('applies a configured pin or region without enabling federation', () => {
    expect(loadExplicitTenancyConfig({ ENSEMUS_CROSS_ORG_ENABLED: '' })).toBeUndefined();
    expect(
      loadExplicitTenancyConfig({
        ENSEMUS_TENANCY_TIER: 'dedicated',
        ENSEMUS_DEDICATED_ORGANIZATION_ID: ORG,
        ENSEMUS_CROSS_ORG_ENABLED: '',
      }),
    ).toMatchObject({
      tier: 'dedicated',
      pinnedOrganizationId: ORG.toLowerCase(),
      crossOrgEnabled: false,
    });
    expect(loadExplicitTenancyConfig({ ENSEMUS_HOME_REGION: 'test-region-a' })).toMatchObject({
      tier: 'shared',
      homeRegion: 'test-region-a',
      crossOrgEnabled: false,
    });
    expect(() => loadExplicitTenancyConfig({ ENSEMUS_TENANCY_TIER: 'dedicated' })).toThrow(
      ConfigError,
    );
  });

  it('turns on only when told exactly', () => {
    expect(loadTenancyConfig({ ENSEMUS_CROSS_ORG_ENABLED: 'true' }).crossOrgEnabled).toBe(true);
    expect(() => loadTenancyConfig({ ENSEMUS_CROSS_ORG_ENABLED: 'yes' })).toThrow(ConfigError);
  });

  it('puts a pinned ID in the database’s own spelling', () => {
    expect(
      loadTenancyConfig({
        ENSEMUS_TENANCY_TIER: 'dedicated',
        ENSEMUS_DEDICATED_ORGANIZATION_ID: ORG,
      }).pinnedOrganizationId,
    ).toBe(ORG.toLowerCase());
  });

  it.each([
    ['dedicated with no pin', { ENSEMUS_TENANCY_TIER: 'dedicated' }],
    ['a pin on shared', { ENSEMUS_DEDICATED_ORGANIZATION_ID: ORG }],
    [
      'dedicated with cross-org on',
      {
        ENSEMUS_TENANCY_TIER: 'dedicated',
        ENSEMUS_DEDICATED_ORGANIZATION_ID: ORG,
        ENSEMUS_CROSS_ORG_ENABLED: 'true',
      },
    ],
    ['a bad region', { ENSEMUS_HOME_REGION: 'Not A Region' }],
    ['an unknown tier', { ENSEMUS_TENANCY_TIER: 'gold' }],
  ])('refuses %s', (_, env) => {
    expect(() => loadTenancyConfig(env)).toThrow(ConfigError);
  });

  it('names the setting and never its value', () => {
    expect(() => loadTenancyConfig({ ENSEMUS_HOME_REGION: 'CANARY VALUE' })).toThrow(
      /ENSEMUS_HOME_REGION/,
    );
    expect(() => loadTenancyConfig({ ENSEMUS_HOME_REGION: 'CANARY VALUE' })).not.toThrow(/CANARY/);
  });

  it('hashes the same statement the same way, and a different one differently', () => {
    const base = loadTenancyConfig({ ENSEMUS_HOME_REGION: 'test-region-a' });
    expect(deploymentProfileHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(deploymentProfileHash(base)).toBe(deploymentProfileHash({ ...base }));
    expect(deploymentProfileHash(base)).not.toBe(
      deploymentProfileHash({ ...base, crossOrgEnabled: true }),
    );
  });
});

describe('the residency statement', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensemus-residency-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  const file = (name: string, content: string) => {
    const path = join(directory, name);
    writeFileSync(path, content);
    return path;
  };

  it('declares nothing with no file', () => {
    expect(loadResidencyPolicy({ ENSEMUS_HOME_REGION: 'test-region-a' })).toEqual({
      homeRegion: 'test-region-a',
      surfaces: {},
    });
  });

  it('reads what is declared and leaves the rest undeclared', () => {
    const path = file(
      'good.json',
      JSON.stringify({
        surfaces: { storage: { regions: ['test-region-a'], evidence_ref: 'a record' } },
      }),
    );
    expect(loadResidencyPolicy({ ENSEMUS_RESIDENCY_POLICY_FILE: path })).toEqual({
      homeRegion: null,
      surfaces: { storage: { regions: ['test-region-a'], evidenceRef: 'a record' } },
    });
  });

  it.each([
    ['not JSON', 'nope'],
    [
      'an unknown surface',
      JSON.stringify({ surfaces: { payments: { regions: ['x-1'], evidence_ref: 'r' } } }),
    ],
    ['no evidence reference', JSON.stringify({ surfaces: { storage: { regions: ['x-1'] } } })],
    ['no regions', JSON.stringify({ surfaces: { storage: { regions: [], evidence_ref: 'r' } } })],
    [
      'a bad region',
      JSON.stringify({ surfaces: { storage: { regions: ['NO'], evidence_ref: 'r' } } }),
    ],
    ['an extra field', JSON.stringify({ surfaces: {}, certified: true })],
  ])('stops startup on %s', (name, content) => {
    const path = file(`${name.replaceAll(' ', '-')}.json`, content);
    expect(() => loadResidencyPolicy({ ENSEMUS_RESIDENCY_POLICY_FILE: path })).toThrow(ConfigError);
  });
});
