// The actual M4 ledger and separately owned standing/offboarding stops meet M8 here (ADR-032 D9).
import {
  type AgentHaltPort,
  type OffboardingPorts,
  type RetentionSource,
  type UsageLedgerPort,
} from '@ensemus/application/saas/ports';
import { createUsageLedgerReader } from '@ensemus/application/saas/usage-reader';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { createRawFilesRetentionSource } from '@ensemus/application/saas/retention';
import {
  createOffboardingAgentHaltPort,
  createOffboardingExportPort,
} from '@ensemus/application/saas/offboarding-agent-port';

export function createSaasPorts(_store: unknown): {
  usage: UsageLedgerPort;
  agents: AgentHaltPort;
  retentionSources: readonly RetentionSource[];
  offboarding: OffboardingPorts;
} {
  const agents = createStandingAgentHaltPort();
  return {
    usage: createUsageLedgerReader(),
    agents,
    retentionSources: [createRawFilesRetentionSource(_store)],
    offboarding: {
      exports: createOffboardingExportPort(),
      agents,
      offboardingAgents: createOffboardingAgentHaltPort(),
      windDowns: [],
    },
  };
}
