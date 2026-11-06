// Owned by the model-profiles slice (MODEL-01). See docs/06-delivery/m4-slices.md and ADR-028 FD-23. Runs on
// AGENT_TASK_QUEUE, in agent-worker only. This stub fails every probe, so nothing can go active.
import type { ProfileProber } from '@ensemus/intelligence';
import type { AppDatabase } from '@ensemus/database';
import type { ModelProbeInput, ModelProbeOutcome } from './agent-schemas';

export type ModelProbeDeps = {
  database: AppDatabase;
  probe: ProfileProber;
};

export interface ModelProbeActivities {
  runModelProbe(input: ModelProbeInput): Promise<ModelProbeOutcome>;
}

export function createModelProbeActivities(_deps: ModelProbeDeps): ModelProbeActivities {
  return {
    async runModelProbe() {
      return 'failed';
    },
  };
}
