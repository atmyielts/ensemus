// Owned by the spine slice (AGENT-02, AI-13). See docs/06-delivery/m4-slices.md and ADR-028. These run on
// AGENT_TASK_QUEUE, in agent-worker only: lint keeps this module from the web tier and from the base
// worker. Nothing here holds a transaction open across a model call. Every stub fails closed.
import type { AppDatabase } from '@ensemus/database';
import type {
  ClaimInput,
  ClaimResult,
  CreateChildRunInput,
  FinishRunInput,
  ModelTurnResult,
  RunDirective,
  RunRef,
  StepInput,
  ToolCallResult,
  ToolWaitState,
} from './agent-schemas';

/**
 * What agent-worker hands these Activities. The wiring slice builds the real objects in agent-main.ts.
 * Each field is typed where its slice owns it, so tests can give a double for any one of them.
 */
export type AgentActivityDeps = {
  database: AppDatabase;
  gateway: import('@ensemus/intelligence').InferenceGateway;
  tools: import('@ensemus/agent-runtime/tools').ToolGateway;
  context: import('@ensemus/agent-runtime/context').ContextCompiler;
};

export interface AgentActivities {
  /** Finds the queued run in PostgreSQL, moves it to preparing and claims the Work Unit. */
  claimAgentRun(input: ClaimInput): Promise<ClaimResult>;
  /** Reads run_controls and kill switches. The answer for this step comes from here, never a signal. */
  readRunDirective(input: RunRef): Promise<RunDirective>;
  /** One model turn: compile, route, reserve, send, validate, record. */
  runModelTurn(input: StepInput): Promise<ModelTurnResult>;
  /** One tool call, from the proposal the last turn stored. */
  runToolCall(input: StepInput): Promise<ToolCallResult>;
  /** Where a waiting tool step has got to. Reads PostgreSQL only, so it is safe to retry. */
  readToolWait(input: StepInput): Promise<ToolWaitState>;
  /** Moves the run to a waiting or running status with a recorded reason. */
  setRunStatus(
    input: RunRef & {
      status: 'running' | 'paused' | 'waiting_for_approval' | 'waiting_for_child' | 'verifying';
    },
  ): Promise<void>;
  /** Filled in by the delegation slice, in @ensemus/application/ai-delegation. */
  createChildRun(input: CreateChildRunInput): Promise<ToolCallResult>;
  /** Checks a final output against its criteria. `outcome_unverified` is an honest answer. */
  verifyRunOutput(input: RunRef): Promise<'completed' | 'outcome_unverified'>;
  /** The run's terminal status, settling reservations and purging payloads. Safe to repeat. */
  finishAgentRun(input: FinishRunInput): Promise<void>;
}

const notBuilt = () => new Error('NOT_IMPLEMENTED');

/** Fails closed until the spine slice fills it in, so nothing can run half-built. */
export function createAgentActivities(_deps: AgentActivityDeps): AgentActivities {
  return {
    async claimAgentRun() {
      throw notBuilt();
    },
    async readRunDirective() {
      return 'stop';
    },
    async runModelTurn() {
      throw notBuilt();
    },
    async runToolCall() {
      throw notBuilt();
    },
    async readToolWait() {
      throw notBuilt();
    },
    async setRunStatus() {
      throw notBuilt();
    },
    async createChildRun() {
      throw notBuilt();
    },
    async verifyRunOutput() {
      return 'outcome_unverified';
    },
    async finishAgentRun() {
      throw notBuilt();
    },
  };
}
