// The bundled workflows from docs/01-product/04-capability-catalog.md (AGENT-13). Owned by the process slice.
// Each is data: a graph that compiles like any drawn one, so it gets no special way past the compiler.
import type { ProcessGraph, ProcessSpec } from '@ensemus/domain/process-spec';
import type { SimulationScenario } from '@ensemus/domain/simulation';

export type BundledWorkflow = {
  key: string;
  version: number;
  name: string;
  description: string;
  classification: ProcessSpec['classification'];
  graph: ProcessGraph;
  scenario: SimulationScenario;
  /** Words that bring this to mind in the outcome composer. */
  keywords: readonly string[];
  /**
   * What has to exist for this to reach its end. An unmet need is shown on the page, and the step that needs
   * it stops honestly: nothing pretends an accounting system or a meeting service is connected.
   */
  needs: readonly ('email_connector' | 'accounting_connector' | 'meeting_notes')[];
};

/** Empty until the process slice lands, so nothing is offered that cannot run. */
export const BUNDLED_WORKFLOWS: readonly BundledWorkflow[] = [];

export const findBundledWorkflow = (key: string): BundledWorkflow | null =>
  BUNDLED_WORKFLOWS.find((workflow) => workflow.key === key) ?? null;
