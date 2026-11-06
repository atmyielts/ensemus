// Owned by the policy-router slice (MODEL-03, SEC-01, COMM-02). The order of FD-8 lives in this one
// function, so it can be read top to bottom and a test can stop it at each stage. This stub denies.
import type {
  EgressLog,
  Entitlements,
  HaltCheck,
  TurnStore,
  UsageLedger,
} from '@ensemus/application/ai-ports';
import type {
  CredentialLender,
  EndpointGuard,
  InferenceGateway,
  ModelAdapter,
  ModelRouter,
} from './types';

export type GatewayDeps = {
  entitlements: Entitlements;
  ledger: UsageLedger;
  /** Runs its own short transaction for each reservation and settlement. */
  withTx: <T>(
    context: import('@ensemus/application/ai-ports').AgentContext,
    fn: (tx: import('@ensemus/application/ai-ports').Tx) => Promise<T>,
  ) => Promise<T>;
  router: ModelRouter;
  egress: EgressLog;
  guard: EndpointGuard;
  credentials: CredentialLender;
  adapter: ModelAdapter;
  turns: TurnStore;
  halt: HaltCheck;
  /** The operator's list, read by the caller. */
  privateEndpoints: readonly string[];
  /** Strings no output or prompt may hold, for this tenant. Empty is fine. */
  canaries: () => Promise<readonly string[]>;
};

export function createInferenceGateway(_deps: GatewayDeps): InferenceGateway {
  return {
    async turn() {
      return {
        outcome: 'policy_denied',
        stopCode: 'POLICY_DENIED',
        decisionCode: 'POLICY_UNREADABLE',
        usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
        profile: null,
        text: null,
        toolCall: null,
      };
    },
  };
}
