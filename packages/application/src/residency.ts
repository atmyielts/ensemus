// Owned by the residency slice (EXP-09). See docs/06-delivery/m11c-slices.md and ADR-035 D6. A requirement is a
// tenant's own, and setting one takes an owner. The statement about where things happen is the operator's.
import {
  modelProfiles,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import {
  residencyPosture,
  type ResidencyPolicy,
  type ResidencyPosture,
  type ResidencyScope,
  type ResidencySurface,
} from '@ensemus/domain/residency';
import { and, eq } from 'drizzle-orm';
import { requireTenancyViewer } from './tenancy';
import type { ProcessingLocationSource, ResidencyGate } from './tenancy-ports';

export type ResidencyRequirementView = {
  scope: ResidencyScope;
  region: string;
  version: number;
  updatedAt: Date;
};

export function listResidencyRequirements(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly ResidencyRequirementView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Sets one scope, or removes it with a null region, as an owner, with an audit row. A region this deployment
 * is not in is refused with RESIDENCY_REGION_NOT_OFFERED, by the trigger and by this.
 */
export function setResidencyRequirement(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { scope: ResidencyScope; region: string | null; expectedVersion: number },
): Promise<readonly ResidencyRequirementView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The real gate. Reads this tenant's requirements under its own binding and asks `checkResidency`. A denial
 * writes one audit row, with a code and no data. An error reading them is a denial: this fails closed.
 */
export function createResidencyGate(_deps: {
  database: AppDatabase;
  policy: ResidencyPolicy;
}): ResidencyGate {
  throw new Error('NOT_IMPLEMENTED');
}

/** What this deployment states, with what each source says is really connected. Nothing more. */
export async function getResidencyPosture(
  database: AppDatabase,
  context: TenantContext,
  input: { policy: ResidencyPolicy; sources: readonly ProcessingLocationSource[] },
): Promise<ResidencyPosture> {
  const profiles = await withTenantTx(database, context, async (tx) => {
    await requireTenancyViewer(tx, context);
    return tx
      .selectDistinct({ region: modelProfiles.region, purposes: modelProfiles.allowedPurposes })
      .from(modelProfiles)
      .where(
        and(
          eq(modelProfiles.organizationId, context.organizationId),
          eq(modelProfiles.status, 'active'),
        ),
      );
  });
  const observed: Partial<Record<ResidencySurface, Set<string>>> = {};
  const add = (surface: ResidencySurface, region: string | null) => {
    // Invalid values and unavailable observations cannot match even a configured region named "unknown".
    (observed[surface] ??= new Set()).add(
      region && /^[a-z][a-z0-9-]{1,31}$/.test(region) ? region : 'Unknown',
    );
  };
  for (const profile of profiles) {
    if (profile.purposes.includes('embed')) add('embeddings', profile.region);
    if (profile.purposes.some((purpose) => purpose !== 'embed')) add('inference', profile.region);
  }
  await Promise.all(
    input.sources.map(async (source) => {
      try {
        for (const region of await source.regionsFor(context)) add(source.surface, region);
      } catch {
        add(source.surface, null);
      }
    }),
  );
  const regions = Object.fromEntries(
    Object.entries(observed).map(([surface, values]) => [surface, [...values].sort()]),
  );
  return residencyPosture(input.policy, regions);
}
