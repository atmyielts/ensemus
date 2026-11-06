// Owned by the composer-onboarding slice (UX-21). See docs/06-delivery/m7-slices.md and ADR-031 D5.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { OnboardingStatus, OnboardingStepKey } from '@ensemus/domain/onboarding';
import type { ProductPorts } from './ports';
import type { SimulationView } from './simulations';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

/** Needs `onboarding.manage`. Each step reads the real records. A port that is unavailable is `null`. */
export async function getOnboarding(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'knowledge' | 'modelReadiness'>,
): Promise<OnboardingStatus> {
  throw NOT_BUILT();
}

/**
 * Records what cannot be read from a record: an acknowledgement or a skip. Skipping a required step is
 * refused. Emits ONBOARDING_FINISHED the first time the status comes out finished.
 */
export async function decideOnboardingStep(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'knowledge' | 'modelReadiness'>,
  _input: { step: OnboardingStepKey; decision: 'acknowledged' | 'skipped' },
): Promise<OnboardingStatus> {
  throw NOT_BUILT();
}

/** Asks for the zero-side-effect simulation of the first catalog workflow, through `requestSimulation`. */
export async function startFirstSimulation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { processKey: string },
): Promise<SimulationView> {
  throw NOT_BUILT();
}
