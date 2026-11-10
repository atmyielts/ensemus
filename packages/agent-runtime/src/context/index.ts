// Owned by the context slice (AGENT-15, ADR-028 FD-17). M5's KNOW-03 replaces this behind the same shape.
// The compiler reads through `ContextSource`, which checks the initiator's access at load, so an agent
// role that could read a row still gets nothing its initiator could not.
//
// Role separation is what keeps a poisoned document as data. Only the fixed rules and a published agent's
// `instructions` become role `policy`. Everything else stays in its own role, fenced, whatever it says.
import type { AgentContext } from '@ensemus/application/ai-ports';
import type {
  ArtifactRefusal,
  RunContextSource,
  TranscriptPart,
} from '@ensemus/application/ai-context-source';
import {
  AGENT_TURN_PURPOSE,
  strongestClassification,
  type AiClassification,
} from '@ensemus/domain/ai';
import { canonicalJson } from '@ensemus/domain/approval';
import type { CompiledTurn, ContextMessage } from '@ensemus/intelligence';
import {
  coverageText,
  evidenceText,
  policyText,
  sha256Hex,
  taskText,
  transcriptText,
  type LeftOut,
} from './template';
import { offeredTools } from './tools';

export type RunRef = {
  runId: string;
  workUnitId: string;
  agentVersionId: string;
  /** Actual current model step, supplied by runModelTurn after beginTurn. Never fabricated by retrieval. */
  modelStep?: { stepId: string; stepNumber: number; attempt: number };
  signal?: AbortSignal;
};

export type CompiledContext = CompiledTurn & {
  /** Strongest class of everything included. It only goes up across a run (FD-13). */
  classification: AiClassification;
  /** Current assembly trace only. The durable ContextSource ledger is authoritative across every
   * turn/tool and includes returned material omitted for size here; citations never replace it. */
  sources: readonly {
    type: 'work_unit' | 'artifact' | 'knowledge_package';
    id: string;
    sha256: string;
  }[];
};

export interface ContextCompiler {
  compile(context: AgentContext, run: RunRef): Promise<CompiledContext>;
}

export type ContextLimits = { maxInputChars: number; maxArtifactBytes: number };

const COMPILE_ERRORS = {
  RUN_MISMATCH: 'This context belongs to another run.',
  REQUIRED_TEXT_TOO_LONG: 'The fixed rules and the task do not fit the input limit.',
} as const;

/** Fixed messages, so a failed compile can be logged and carries nothing from a prompt. */
export class ContextCompileError extends Error {
  override name = 'ContextCompileError';
  constructor(readonly code: keyof typeof COMPILE_ERRORS) {
    super(COMPILE_ERRORS[code]);
  }
}

/** Everything a default trace may hold about a turn: no text, however it is logged. */
export function contextTrace(compiled: CompiledContext) {
  return {
    requestHash: compiled.requestHash,
    classification: compiled.classification,
    sources: compiled.sources,
  };
}

/** Each purpose a profile can allow. M4's agents all reason over work, so routing needs nothing else. */
const PURPOSE = AGENT_TURN_PURPOSE;

/**
 * Only a rough size, to hold a manifest's `max_input_tokens` as a limit on text before any model is
 * chosen. The provider's own limit is what finally counts: an adapter refuses what is too long.
 */
const CHARS_PER_TOKEN = 4;

/** A character takes at most this many bytes, so a larger file could not fit what is left of the limit. */
const MAX_BYTES_PER_CHAR = 4;

const KIND_ORDER: Record<TranscriptPart['kind'], number> = {
  completion: 0,
  tool_args: 1,
  tool_output: 2,
};

/** Sorted here as well, so the same rows give the same bytes whatever order a source hands them over. */
const inRunOrder = (parts: readonly TranscriptPart[]) =>
  [...parts].sort((a, b) => a.stepNumber - b.stepNumber || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

function countRefusal(leftOut: LeftOut, refusal: ArtifactRefusal) {
  if (refusal === 'TOO_LARGE') leftOut.tooLarge += 1;
  else if (refusal === 'NOT_TEXT') leftOut.notText += 1;
  else leftOut.unavailable += 1;
}

function hashMessages(messages: readonly ContextMessage[]) {
  return sha256Hex(
    canonicalJson(
      messages.map((message) => ({
        role: message.role,
        partId: message.partId,
        classification: message.classification,
        text: message.text,
      })),
    ),
  );
}

export function createMinimalContextCompiler(deps: {
  /** What `createContextSource` returns: the reads a tool uses, and the run's own instructions. */
  source: RunContextSource;
  limits: ContextLimits;
}): ContextCompiler {
  const { source, limits } = deps;
  if (!(limits.maxInputChars > 0) || !(limits.maxArtifactBytes > 0)) {
    throw new RangeError('Context limits must be positive');
  }
  return {
    async compile(context, run) {
      if (context.agentRunId !== run.runId.toLowerCase()) {
        throw new ContextCompileError('RUN_MISMATCH');
      }
      const brief = await source.loadRunBrief(context, run);
      const work = await source.loadWork(context, run.workUnitId);
      const transcript = inRunOrder(await source.loadTranscript(context, run.runId));
      const artifactIds = [...new Set(work.artifactIds)].sort();

      const taskClass = work.clientClassification
        ? strongestClassification(work.classification, work.clientClassification)
        : work.classification;
      // All of the transcript counts, even a part with no room below: this run's later answers were
      // shaped by it, so leaving out its words does not take back what it was told.
      let classification = transcript.reduce(
        (strongest, part) => strongestClassification(strongest, part.classification),
        strongestClassification(
          'internal',
          strongestClassification(brief.classification, taskClass),
        ),
      );

      const task = (coverage: string) =>
        taskText({
          agentObjective: brief.objective,
          workUnitId: work.id,
          title: work.title,
          objective: work.objective,
          coverage,
        });
      const policy = policyText(brief.instructions);
      // Room for the counts at their largest, since they are only known once the files have been read.
      const most = artifactIds.length + transcript.length;
      const largestCoverage = coverageText(most, {
        tooLarge: most,
        notText: most,
        unavailable: most,
        earlierSteps: most,
      });
      const limit =
        brief.maxInputTokens === null
          ? limits.maxInputChars
          : Math.min(limits.maxInputChars, brief.maxInputTokens * CHARS_PER_TOKEN);
      let room = limit - policy.length - task(largestCoverage).length;
      if (room < 0) throw new ContextCompileError('REQUIRED_TEXT_TOO_LONG');

      // Newest first, and stopping at the first that does not fit, so what is kept has no gaps in it.
      const kept: ContextMessage[] = [];
      for (let index = transcript.length - 1; index >= 0; index -= 1) {
        const part = transcript[index] as TranscriptPart;
        const text = transcriptText(part.stepNumber, part.kind, part.text);
        if (text.length > room) break;
        room -= text.length;
        kept.unshift({
          role: 'tool_output',
          partId: `step:${part.stepNumber}:${part.kind}:${index}`,
          text,
          classification: part.classification,
        });
      }

      const leftOut: LeftOut = {
        tooLarge: 0,
        notText: 0,
        unavailable: 0,
        earlierSteps: transcript.length - kept.length,
      };
      const evidence: ContextMessage[] = [];
      const sources: { type: 'work_unit' | 'artifact'; id: string; sha256: string }[] = [
        {
          type: 'work_unit',
          id: work.id,
          sha256: sha256Hex(canonicalJson({ title: work.title, objective: work.objective })),
        },
      ];

      // One at a time, asking for no more than could still fit, so an enormous file is never read. Once
      // a file was read and had no room, or nothing could fit, reading stops: the bytes read stay within
      // the limit however many files are attached, and the later ones count as left out for size.
      let full = false;
      for (const artifactId of artifactIds) {
        const overhead = evidenceText(artifactId, '').length;
        if (full || room <= overhead) {
          leftOut.tooLarge += 1;
          continue;
        }
        const maxBytes = Math.min(limits.maxArtifactBytes, (room - overhead) * MAX_BYTES_PER_CHAR);
        const loaded = await source.loadArtifactText(context, {
          workUnitId: run.workUnitId,
          artifactId,
          maxBytes,
        });
        if ('refused' in loaded) {
          countRefusal(leftOut, loaded.refused);
          continue;
        }
        const text = evidenceText(loaded.id, loaded.text);
        if (text.length > room) {
          leftOut.tooLarge += 1;
          full = true;
          continue;
        }
        room -= text.length;
        evidence.push({
          role: 'evidence',
          partId: `artifact:${loaded.id}`,
          text,
          classification: loaded.classification,
        });
        sources.push({ type: 'artifact', id: loaded.id, sha256: loaded.sha256 });
        classification = strongestClassification(classification, loaded.classification);
      }

      const messages: readonly ContextMessage[] = [
        // Carries the run's class, so it neither raises the class nor claims to be less than the rest.
        { role: 'policy', partId: 'policy', text: policy, classification },
        {
          role: 'task',
          partId: `work:${work.id}`,
          text: task(coverageText(evidence.length, leftOut)),
          // The task also contains the published manifest's objective, which is never unlabeled public data.
          classification: strongestClassification('internal', taskClass),
        },
        ...evidence,
        ...kept,
      ];

      return {
        messages,
        tools: offeredTools(brief),
        // `output.schema_ref` names a file that nothing can load in M4, so answers are plain text and
        // verification happens after the model, not by asking it for a shape.
        responseSchema: null,
        task: {
          runId: run.runId,
          purpose: PURPOSE,
          quality: brief.qualityTier,
          required: brief.requiredCapabilities,
          classification,
          // A tenant's allowed regions are the router's to apply. A run has no region of its own.
          requiredRegion: null,
          allowFallback: brief.allowFallback,
          pinned: brief.pinned,
        },
        requestHash: hashMessages(messages),
        // What is left of the run's own limits. The gateway holds these to the chosen profile's limits,
        // since no profile has been chosen yet. Never zero: the reducer stops a spent run before this.
        maxOutputTokens: Math.max(1, brief.remaining.tokens),
        timeoutMs: Math.max(1, brief.remaining.activeMs),
        classification,
        sources,
      };
    },
  };
}
