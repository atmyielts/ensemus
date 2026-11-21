// Owned by the tier slice (EXP-08). See docs/06-delivery/m11c-slices.md and ADR-035 D5. Reading what this
// deployment is. Nothing a request reaches can change it: only the deploy job writes the profile.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { IsolationPosture, TenancyTier } from '@ensemus/domain/tenancy';

export type DeploymentProfileView = {
  tier: TenancyTier;
  homeRegion: string | null;
  crossOrgEnabled: boolean;
  /** Whether a deploy job has ever written one. Without one, everything above is its default. */
  profiled: boolean;
};

/** Everything defaults when there is no row, and this never throws for that. Takes tenancy.view. */
export function getDeploymentProfile(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<DeploymentProfileView> {
  throw new Error('NOT_IMPLEMENTED');
}

/** What was found, by aspect, against this release. Takes tenancy.view. Says nothing it was not told. */
export function getIsolationPosture(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { releaseVersion: string },
): Promise<IsolationPosture> {
  throw new Error('NOT_IMPLEMENTED');
}
