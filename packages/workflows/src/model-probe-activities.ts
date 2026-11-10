// Owned by the model-profiles slice (MODEL-01). See docs/06-delivery/m4-slices.md and ADR-028 FD-23. Runs on
// AGENT_TASK_QUEUE, in agent-worker only. No transaction stays open across the model call: the load and
// the write are each their own, and the write checks the version it was given.
import { loadProfileForProbe, recordProbeResult } from '@ensemus/application/ai-model-probe-store';
import type { AppDatabase } from '@ensemus/database';
import type { ProfileProber } from '@ensemus/intelligence';
import {
  modelProbeInputSchema,
  type ModelProbeInput,
  type ModelProbeOutcome,
} from './agent-schemas';

export type ModelProbeDeps = {
  database: AppDatabase;
  probe: ProfileProber;
};

export interface ModelProbeActivities {
  runModelProbe(input: ModelProbeInput): Promise<ModelProbeOutcome>;
}

export function createModelProbeActivities(deps: ModelProbeDeps): ModelProbeActivities {
  return {
    async runModelProbe(input) {
      const parsed = modelProbeInputSchema.parse(input);
      const target = { organizationId: parsed.organizationId, profileId: parsed.modelProfileId };
      // The version read here is the one the result is about. If someone changes the profile from now
      // on, its version moves, the write below finds nothing, and they are not told a stale answer.
      const profile = await loadProfileForProbe(deps.database, target);
      if (!profile) return 'skipped';

      // A prober never throws for what a provider did. If it throws anyway, that is a bug, and a bug
      // must not let a profile through, so anything but an exact pass is a failure. The error itself
      // goes nowhere: it could quote what the provider said.
      const outcome = await deps.probe.probe(target).catch(() => 'failed' as const);
      const passed = outcome === 'passed';
      await recordProbeResult(deps.database, {
        ...target,
        profileVersion: profile.version,
        passed,
      });
      return passed ? 'passed' : 'failed';
    },
  };
}
