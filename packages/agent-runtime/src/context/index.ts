// Owned by the context slice (AGENT-15, ADR-028 FD-17). M5's KNOW-03 replaces this behind the same shape.
// The compiler reads through `ContextSource`, which checks the initiator's access at load, so an agent
// role that could read a row still gets nothing its initiator could not.
import type { AgentContext } from '@ensemus/application/ai-ports';
import type { ContextSource } from '@ensemus/application/ai-context-source';
import type { AiClassification } from '@ensemus/domain/ai';
import type { CompiledTurn } from '@ensemus/intelligence';

export type RunRef = {
  runId: string;
  workUnitId: string;
  agentVersionId: string;
};

export type CompiledContext = CompiledTurn & {
  /** Strongest class of everything included. It only goes up across a run (FD-13). */
  classification: AiClassification;
  /** Source IDs and hashes, which is all a default trace may hold. */
  sources: readonly { type: 'work_unit' | 'artifact'; id: string; sha256: string }[];
};

export interface ContextCompiler {
  compile(context: AgentContext, run: RunRef): Promise<CompiledContext>;
}

export function createMinimalContextCompiler(_deps: {
  source: ContextSource;
  limits: { maxInputChars: number; maxArtifactBytes: number };
}): ContextCompiler {
  return {
    compile() {
      return Promise.reject(new Error('NOT_IMPLEMENTED'));
    },
  };
}
