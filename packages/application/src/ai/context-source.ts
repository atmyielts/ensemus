// Owned by the context slice (AGENT-15). What an agent can read, loaded under its initiator's context, so
// every read goes through the same Work Unit access rules a person gets. The tool gateway reads through
// this as well. Only agent-worker uses it. Every stub refuses.
import type { AppDatabase, AgentContext } from '@ensemus/database';
import type { AiClassification } from '@ensemus/domain/ai';

export type LoadedWork = {
  id: string;
  title: string;
  objective: string | null;
  classification: AiClassification;
  clientClassification: AiClassification | null;
  artifactIds: readonly string[];
};

export type LoadedArtifact = {
  id: string;
  classification: AiClassification;
  sha256: string;
  text: string;
};

export type ArtifactRefusal = 'NOT_PERMITTED' | 'NOT_TEXT' | 'TOO_LARGE' | 'DELETED';

export interface ContextSource {
  /** Throws NOT_FOUND when the initiator cannot read this work, whatever the agent role could. */
  loadWork(context: AgentContext, workUnitId: string): Promise<LoadedWork>;
  /** Rechecks access now. Text files only, up to `maxBytes`. */
  loadArtifactText(
    context: AgentContext,
    input: { workUnitId: string; artifactId: string; maxBytes: number },
  ): Promise<LoadedArtifact | { refused: ArtifactRefusal }>;
}

/** `readObject` comes from @ensemus/storage in agent-main.ts, so this file reaches no store directly. */
export function createContextSource(_deps: {
  database: AppDatabase;
  readObject: (objectKey: string, maxBytes: number) => Promise<Buffer>;
}): ContextSource {
  throw new Error('NOT_IMPLEMENTED');
}
