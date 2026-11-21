// What an operator says this deployment is (ADR-035 D5 and D6). All of it is configuration, because which
// tiers are sold and which regions are offered are owner decisions. Unset means shared, no region claimed,
// and cross-organization work off, which is what a deployment was before this existed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from './index';

const REGION = /^[a-z][a-z0-9-]{1,31}$/;
const SURFACES = ['storage', 'backups', 'support', 'embeddings', 'inference', 'telemetry'] as const;

const tenancySchema = z
  .object({
    ENSEMUS_TENANCY_TIER: z.enum(['shared', 'dedicated']).default('shared'),
    ENSEMUS_DEDICATED_ORGANIZATION_ID: z.uuid().toLowerCase().optional(),
    ENSEMUS_HOME_REGION: z.string().regex(REGION).optional(),
    ENSEMUS_CROSS_ORG_ENABLED: z.enum(['true', 'false']).default('false'),
  })
  .refine(
    (env) =>
      (env.ENSEMUS_TENANCY_TIER === 'dedicated') === Boolean(env.ENSEMUS_DEDICATED_ORGANIZATION_ID),
    { path: ['ENSEMUS_DEDICATED_ORGANIZATION_ID'] },
  )
  // One organization has nobody to work with. Keeps a mistake from reading as a working setting.
  .refine(
    (env) => env.ENSEMUS_TENANCY_TIER === 'shared' || env.ENSEMUS_CROSS_ORG_ENABLED === 'false',
    { path: ['ENSEMUS_CROSS_ORG_ENABLED'] },
  );

export type TenancyConfig = {
  tier: 'shared' | 'dedicated';
  pinnedOrganizationId: string | null;
  homeRegion: string | null;
  crossOrgEnabled: boolean;
};

/** Read by the web tier and the deploy job. A config error names the setting, never its value. */
export function loadTenancyConfig(env: NodeJS.ProcessEnv = process.env): TenancyConfig {
  const parsed = tenancySchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new ConfigError(`Invalid tenancy configuration: ${fields}`);
  }
  return {
    tier: parsed.data.ENSEMUS_TENANCY_TIER,
    pinnedOrganizationId: parsed.data.ENSEMUS_DEDICATED_ORGANIZATION_ID ?? null,
    homeRegion: parsed.data.ENSEMUS_HOME_REGION ?? null,
    crossOrgEnabled: parsed.data.ENSEMUS_CROSS_ORG_ENABLED === 'true',
  };
}

/** Goes on the profile's row, so it can be seen which statement a deployment is running under. */
export function deploymentProfileHash(config: TenancyConfig): string {
  const canonical = JSON.stringify([
    config.tier,
    config.pinnedOrganizationId,
    config.homeRegion,
    config.crossOrgEnabled,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const declarationSchema = z.strictObject({
  regions: z.array(z.string().regex(REGION)).min(1).max(32),
  evidence_ref: z.string().trim().min(1).max(200),
});

const policyFileSchema = z.strictObject({
  surfaces: z.strictObject(
    Object.fromEntries(SURFACES.map((surface) => [surface, declarationSchema.optional()])),
  ),
});

export type LoadedResidencyPolicy = {
  homeRegion: string | null;
  surfaces: Partial<
    Record<(typeof SURFACES)[number], { regions: readonly string[]; evidenceRef: string }>
  >;
};

/**
 * The operator's statement of where each surface happens, from ENSEMUS_RESIDENCY_POLICY_FILE, as JSON. With
 * no file nothing is declared, so a requirement cannot be met and every in-region statement is withheld. A
 * bad file stops startup: quietly reading it as empty would turn a typing mistake into a denial with no cause.
 */
export function loadResidencyPolicy(env: NodeJS.ProcessEnv = process.env): LoadedResidencyPolicy {
  const { homeRegion } = loadTenancyConfig(env);
  const path = env.ENSEMUS_RESIDENCY_POLICY_FILE;
  if (!path) return { homeRegion, surfaces: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError('ENSEMUS_RESIDENCY_POLICY_FILE could not be read as JSON');
  }
  const parsed = policyFileSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new ConfigError(`Invalid residency policy: ${fields}`);
  }
  const surfaces: LoadedResidencyPolicy['surfaces'] = {};
  for (const surface of SURFACES) {
    const declared = parsed.data.surfaces[surface];
    if (declared) {
      surfaces[surface] = { regions: declared.regions, evidenceRef: declared.evidence_ref };
    }
  }
  return { homeRegion, surfaces };
}
