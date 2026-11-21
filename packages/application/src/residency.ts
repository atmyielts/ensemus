// Owned by the residency slice (EXP-09). See docs/06-delivery/m11c-slices.md and ADR-035 D6. A requirement is a
// tenant's own, and setting one takes an owner. The statement about where things happen is the operator's.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ResidencyPolicy, ResidencyPosture, ResidencyScope } from '@ensemus/domain/residency';
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
export function getResidencyPosture(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { policy: ResidencyPolicy; sources: readonly ProcessingLocationSource[] },
): Promise<ResidencyPosture> {
  throw new Error('NOT_IMPLEMENTED');
}
