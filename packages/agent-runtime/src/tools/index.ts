// Owned by the tools slice (AGENT-03). See docs/06-delivery/m4-slices.md and ADR-028 FD-18. The model is
// untrusted, and this is what makes that safe: allowlist, parse, principal and resource ACL, class,
// approval policy, halt check, idempotent effect, receipt, audit, in that order. This stub denies.
import type {
  AgentContext,
  ApprovalBinder,
  ExternalActionPort,
  HaltCheck,
} from '@ensemus/application/ai-ports';
import type { ContextSource } from '@ensemus/application/ai-context-source';
import type { AiReasonCode, ToolOutcome } from '@ensemus/domain/ai';

export type ToolStepRef = {
  runId: string;
  stepNumber: number;
  workUnitId: string;
  agentVersionId: string;
};

/** In memory only. The tool's output goes to `ai.step_payloads`, and never crosses Temporal. */
export type ToolHandleResult = {
  outcome: ToolOutcome;
  decisionCode: AiReasonCode | null;
  /** Set for `agent.delegate` when the workflow should start a child. */
  delegationRequested: boolean;
};

export interface ToolGateway {
  handle(context: AgentContext, step: ToolStepRef): Promise<ToolHandleResult>;
}

export function createToolGateway(_deps: {
  source: ContextSource;
  externalActions: ExternalActionPort;
  approvals: ApprovalBinder;
  halt: HaltCheck;
}): ToolGateway {
  return {
    async handle() {
      return { outcome: 'denied', decisionCode: 'POLICY_UNREADABLE', delegationRequested: false };
    },
  };
}
