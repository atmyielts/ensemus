// The one place M8's ports meet other milestones' code (ADR-032 D9). Each refuses until its sibling is wired in
// here at the final merge, so a deployment stops and says so rather than billing nothing or skipping a step.
import {
  usageNotWiredIn,
  type AgentHaltPort,
  type OffboardingPorts,
  type RetentionSource,
  type TenantExportPort,
} from '@ensemus/application/saas/ports';

/** The code a refusal carries, so an operator can tell what is missing from the log alone. */
class PortNotWiredIn extends Error {
  override name = 'PortNotWiredIn';
  constructor(port: string) {
    super(`PORT_NOT_WIRED_IN_${port}`);
  }
}

const agentsNotWiredIn: AgentHaltPort = {
  haltTenantAgents() {
    throw new PortNotWiredIn('AGENTS');
  },
  releaseTenantAgents() {
    throw new PortNotWiredIn('AGENTS');
  },
};

const exportsNotWiredIn: TenantExportPort = {
  latestExport() {
    throw new PortNotWiredIn('EXPORT');
  },
};

export function createSaasPorts(_store: unknown): {
  usage: typeof usageNotWiredIn;
  agents: AgentHaltPort;
  retentionSources: readonly RetentionSource[];
  offboarding: OffboardingPorts;
} {
  return {
    usage: usageNotWiredIn,
    agents: agentsNotWiredIn,
    // The retention slice adds `raw_files` from createRawFilesRetentionSource, over `_store`.
    retentionSources: [],
    offboarding: { exports: exportsNotWiredIn, agents: agentsNotWiredIn, windDowns: [] },
  };
}
