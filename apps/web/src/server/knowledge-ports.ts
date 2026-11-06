import 'server-only';
import type { AgentWorkloads, RunEgressDecisions } from '@ensemus/application/knowledge/ports';
import type { EgressPolicyPort } from '@ensemus/knowledge/ports';

/** Composition seam for the M4 join. Until its real readers/policy are bound, the response explicitly
 * reports its limited coverage and every simulation denies; this never authorizes provider traffic. */
export function getKnowledgeReadPorts(): {
  coverage: 'knowledge_only' | 'complete';
  runDecisions: RunEgressDecisions;
  agentWorkloads: AgentWorkloads;
  policy: EgressPolicyPort;
} {
  return {
    coverage: 'knowledge_only',
    runDecisions: { list: async () => [] },
    agentWorkloads: { list: async () => [] },
    policy: {
      evaluate: () => ({
        allow: false,
        reasonCode: 'POLICY_NOT_WIRED',
        policyVersion: 'unavailable',
      }),
    },
  };
}
