// Owned by the compile slice (KNOW-03). See docs/06-delivery/m5-slices.md and 05-context-compiler. Takes a
// context with a membership, never a service context, so what it can gather is what that person can read.
// M4's agent runtime calls this at the final merge, in place of its minimal compiler (M4 FD-17).
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { Classification } from '@ensemus/domain/policy';
import type { SelectedEvidence } from '@ensemus/knowledge/evidence';
import type { KnowledgeModelPort, ModelRoute } from '@ensemus/knowledge/ports';

export type CompileDeps = { model: KnowledgeModelPort };

export type CompileInput = {
  purpose: 'answer' | 'agent_turn';
  /** What is being asked or worked on. Hashed for the record, and never stored here. */
  question: string;
  workUnitId?: string;
  runId?: string;
  /** Capped by `MAX_EVIDENCE_TOKENS`. */
  budgetTokens: number;
  sourceIds?: readonly string[];
  signal: AbortSignal;
};

export type CompiledEvidence =
  | {
      ok: true;
      packageId: string;
      policyVersion: string;
      items: readonly SelectedEvidence[];
      /** Only verified facts, marked as such. A model's unverified guess never appears here (Gate C). */
      verifiedFacts: readonly {
        factId: string;
        subjectRef: string;
        predicate: string;
        claim: unknown;
      }[];
      usedTokens: number;
      strongestClassification: Classification;
      /** A model every included class may reach, by `purpose`. Null only for an empty package. */
      route: ModelRoute | null;
    }
  | { ok: false; code: 'NO_APPROVED_MODEL' | 'EGRESS_DENIED' | 'MODEL_UNAVAILABLE' };

/**
 * Retrieve, rerank if allowed, dedupe, trim to budget, then check egress against every included class. If
 * the strongest class has no route, it drops to the classes that have one only when `purpose` is `answer`
 * and that leaves evidence, and otherwise stops. Writes one append-only package row with hashes and IDs.
 */
export function compileEvidence(
  _database: AppDatabase,
  _context: TenantContext,
  _deps: CompileDeps,
  _input: CompileInput,
): Promise<CompiledEvidence> {
  throw new Error('NOT_IMPLEMENTED');
}
