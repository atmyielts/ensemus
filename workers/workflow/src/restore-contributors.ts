// The one list of what has to catch up after a restore (ADR-030 D11). M4's agent runs and budgets and its
// private transcripts, M5's sources and indexes, and the lifecycle's derived artifacts and archive quarantine
// each add themselves here. Each runs once per tenant, may run again, and never touches a provider.
import { createRestoreContributors, type RestoreContributor } from '@ensemus/application';
import { createLifecycleRecoveryBindings } from '@ensemus/application/saas/lifecycle-recovery';
import {
  createRuntimeRestoreRecoveryBindings,
  type RuntimeRestoreDeps,
} from '@ensemus/application/saas/restore-recovery';
import type { ErasureObjectStore } from '@ensemus/application/saas/tenant-object-erasure';

// Missing bindings still audit real SQL metadata, report attention and cannot qualify this command. There is
// no fake zero-count contributor: each runtime binding below is left out when what it needs is not given.
export const RESTORE_CONTRIBUTORS: readonly RestoreContributor[] = createRestoreContributors();
export function createLifecycleRestoreContributors(
  store: ErasureObjectStore,
  runtime: RuntimeRestoreDeps = {},
): readonly RestoreContributor[] {
  return createRestoreContributors({
    ...createRuntimeRestoreRecoveryBindings(runtime),
    ...createLifecycleRecoveryBindings(store),
  });
}
