// Ports for tiers and residency (ADR-035 D5 and D6). Other milestones call the gate, and supply where their
// own surface really goes. Named here so nothing in this milestone depends on their code.
import type { TenantContext } from '@ensemus/database';
import type { ResidencyDecision, ResidencySurface } from '@ensemus/domain/residency';

/**
 * Asked just before data goes somewhere: the model router before inference (M4, `MODEL-*`), the embedder
 * before embedding (M5, `KNOW-*`), support access before a session (M8, `OPS-*`), and any telemetry exporter
 * before it is configured. It refuses when this organization's requirement cannot be shown to hold, and writes
 * one audit row for a denial. It does not read the data, and it does not know about any provider.
 */
export interface ResidencyGate {
  check(
    context: TenantContext,
    request: {
      surface: ResidencySurface;
      classification: string;
      /** Where this really goes, if the caller knows. Null when it has a target that cannot say. */
      targetRegion?: string | null;
    },
  ): Promise<ResidencyDecision>;
}

/**
 * Where something connected to this tenant actually goes, for the posture page, since an operator's statement
 * cannot speak for a model a tenant added. M4 implements this for `inference` and M5 for `embeddings`. A
 * surface with no source shows only what was declared.
 */
export interface ProcessingLocationSource {
  readonly surface: ResidencySurface;
  regionsFor(context: TenantContext): Promise<readonly string[]>;
}
