// Residency (ADR-035 D6, data lifecycle doc section 7). Whether any region is offered, and what is promised
// about it, is an owner decision, so this holds no region and no promise. It reads an operator's statement
// and a tenant's requirement, and it fails closed: a requirement nobody can show is met is treated as unmet.

/** Every place a restriction has to reach, and not only primary PostgreSQL. */
export const RESIDENCY_SURFACES = [
  'storage',
  'backups',
  'support',
  'embeddings',
  'inference',
  'telemetry',
] as const;
export type ResidencySurface = (typeof RESIDENCY_SURFACES)[number];

export const RESIDENCY_SCOPES = [
  'all',
  'public',
  'internal',
  'confidential',
  'restricted',
] as const;
export type ResidencyScope = (typeof RESIDENCY_SCOPES)[number];

export const REGION_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * An operator's statement of where one surface happens, and what they would show to back it up. A reference,
 * such as a document's name in their own records. This code cannot verify it, so it says "declared" wherever
 * it is repeated, and it never says certified.
 */
export type SurfaceDeclaration = { regions: readonly string[]; evidenceRef: string };

/** The whole statement for this deployment, loaded from configuration. */
export type ResidencyPolicy = {
  homeRegion: string | null;
  surfaces: Partial<Record<ResidencySurface, SurfaceDeclaration>>;
};

export const NO_RESIDENCY_POLICY: ResidencyPolicy = { homeRegion: null, surfaces: {} };

export type ResidencyRequirement = { scope: ResidencyScope; region: string };

/** The most specific requirement that applies, or null if this data class has none. */
export function requiredRegionFor(
  requirements: readonly ResidencyRequirement[],
  classification: string,
): string | null {
  const exact = requirements.find((requirement) => requirement.scope === classification);
  if (exact) return exact.region;
  return requirements.find((requirement) => requirement.scope === 'all')?.region ?? null;
}

export const RESIDENCY_DENIAL_CODES = [
  /** This surface has no statement, so nobody can say where it happens. */
  'SURFACE_UNDECLARED',
  /** The statement names a region outside the requirement. */
  'SURFACE_OUTSIDE_REGION',
  /** The caller knows the target, and it is elsewhere, whatever the statement says. */
  'TARGET_OUTSIDE_REGION',
  /** The target could not say where it is, such as a model profile with no region. */
  'TARGET_REGION_UNKNOWN',
] as const;
export type ResidencyDenialCode = (typeof RESIDENCY_DENIAL_CODES)[number];

export type ResidencyDecision =
  | { allowed: true; requiredRegion: string | null }
  | { allowed: false; requiredRegion: string; code: ResidencyDenialCode };

/**
 * May this data go to this surface? With no requirement it may, and this claims nothing about where it goes.
 * With one, the surface must be declared wholly inside the region, and if the caller knows a concrete target,
 * such as a model profile's region, that has to be inside it as well. `targetRegion` is `undefined` when the
 * surface has no such target, and `null` when it has one that cannot say where it is.
 */
export function checkResidency(input: {
  policy: ResidencyPolicy;
  requirements: readonly ResidencyRequirement[];
  surface: ResidencySurface;
  classification: string;
  targetRegion?: string | null;
}): ResidencyDecision {
  const requiredRegion = requiredRegionFor(input.requirements, input.classification);
  if (requiredRegion === null) return { allowed: true, requiredRegion };
  const declaration = input.policy.surfaces[input.surface];
  if (!declaration || declaration.regions.length === 0) {
    return { allowed: false, requiredRegion, code: 'SURFACE_UNDECLARED' };
  }
  if (declaration.regions.some((region) => region !== requiredRegion)) {
    return { allowed: false, requiredRegion, code: 'SURFACE_OUTSIDE_REGION' };
  }
  if (input.targetRegion === null) {
    return { allowed: false, requiredRegion, code: 'TARGET_REGION_UNKNOWN' };
  }
  if (input.targetRegion !== undefined && input.targetRegion !== requiredRegion) {
    return { allowed: false, requiredRegion, code: 'TARGET_OUTSIDE_REGION' };
  }
  return { allowed: true, requiredRegion };
}

export type SurfacePosture = {
  surface: ResidencySurface;
  /** Declared wholly in this region, declared with somewhere else in it, or not declared at all. */
  state: 'declared_in_region' | 'declared_elsewhere' | 'undeclared';
  regions: readonly string[];
  evidenceRef: string | null;
  /** Other regions something connected actually uses, such as a provider profile. */
  observedElsewhere: readonly string[];
};

export type ResidencyPosture = {
  homeRegion: string | null;
  surfaces: readonly SurfacePosture[];
  /**
   * True only when every surface is declared wholly in the home region and nothing connected is seen going
   * elsewhere. This is the only thing the product may base an in-region statement on (data lifecycle doc,
   * section 7: do not claim an all-in-region product if a connected model sends content elsewhere).
   */
  allInRegion: boolean;
};

export function residencyPosture(
  policy: ResidencyPolicy,
  observed: Partial<Record<ResidencySurface, readonly string[]>> = {},
): ResidencyPosture {
  const surfaces = RESIDENCY_SURFACES.map((surface): SurfacePosture => {
    const declaration = policy.surfaces[surface];
    const elsewhere = (observed[surface] ?? []).filter((region) => region !== policy.homeRegion);
    if (!declaration || declaration.regions.length === 0 || policy.homeRegion === null) {
      return {
        surface,
        state: 'undeclared',
        regions: declaration?.regions ?? [],
        evidenceRef: declaration?.evidenceRef ?? null,
        observedElsewhere: elsewhere,
      };
    }
    return {
      surface,
      state: declaration.regions.every((region) => region === policy.homeRegion)
        ? 'declared_in_region'
        : 'declared_elsewhere',
      regions: declaration.regions,
      evidenceRef: declaration.evidenceRef,
      observedElsewhere: elsewhere,
    };
  });
  return {
    homeRegion: policy.homeRegion,
    surfaces,
    allInRegion:
      policy.homeRegion !== null &&
      surfaces.every(
        (surface) =>
          surface.state === 'declared_in_region' && surface.observedElsewhere.length === 0,
      ),
  };
}
