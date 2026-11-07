import { createHash } from 'node:crypto';
import type { ContextCompiler, RunRef, ContextLimits } from '@ensemus/agent-runtime/context';
import { compileEvidence, type CompileDeps } from '@ensemus/application/knowledge/compiler';
import type { KnowledgeModelPrincipal } from '@ensemus/application/ai-knowledge-ports';
import { AppError } from '@ensemus/application';
import { loadAgentReadScope } from '@ensemus/application/ai-context-source';
import type { AgentContext, AppDatabase } from '@ensemus/database';
import { strongestClassification } from '@ensemus/domain/ai';
import { canonicalJson } from '@ensemus/domain/approval';
import { MAX_EVIDENCE_TOKENS, MAX_QUESTION_CHARS } from '@ensemus/domain/knowledge';
import type { ContextMessage } from '@ensemus/intelligence';

/** Actual lexical/semantic Knowledge context over the exhaustive ContextSource read ledger. */
export function createKnowledgeContextCompiler(deps: {
  database: AppDatabase;
  base: ContextCompiler;
  limits: ContextLimits;
  forPrincipal: (principal: KnowledgeModelPrincipal) => CompileDeps;
  authorizeAgentContext?: (
    context: AgentContext,
    run: RunRef,
    input: {
      task: import('@ensemus/intelligence').InferenceTask;
      classification: Parameters<
        NonNullable<CompileDeps['authorizeAgentContext']>
      >[1]['classification'];
    },
  ) => Promise<boolean>;
}): ContextCompiler {
  return {
    async compile(context, run) {
      const scope = await loadAgentReadScope(deps.database, context, run);
      const base = await deps.base.compile(context, run);
      // An old Activity cannot claim a new paid auxiliary principal. It may still assemble the existing
      // M4-only context; the joined new Activity supplies this exact identity before Knowledge is used.
      if (!run.modelStep || !run.signal || scope.sourceIds.length === 0) return base;
      const { modelStep } = run;
      const principal: KnowledgeModelPrincipal = {
        kind: 'agent_run',
        context,
        step: {
          runId: run.runId,
          workUnitId: run.workUnitId,
          agentVersionId: run.agentVersionId,
          ...modelStep,
        },
      };
      const model = deps.forPrincipal(principal);
      // Retrieval uses a bounded prefix of the already captured task. The full Work prompt remains in
      // the base context, and its complete actual-read hash stays in the durable run inventory.
      const question = base.messages
        .filter((message) => message.role === 'task')
        .map((message) => message.text)
        .join('\n')
        .slice(0, MAX_QUESTION_CHARS);
      if (!question) throw new AppError('POLICY_DENIED');
      const room =
        deps.limits.maxInputChars -
        base.messages.reduce((sum, message) => sum + message.text.length, 0);
      const compiled = await compileEvidence(
        deps.database,
        context,
        {
          ...model,
          ...(deps.authorizeAgentContext
            ? {
                authorizeAgentContext: (
                  ctx: AgentContext,
                  input: Parameters<NonNullable<CompileDeps['authorizeAgentContext']>>[1],
                ) => deps.authorizeAgentContext!(ctx, run, { ...input, task: base.task }),
              }
            : {}),
        },
        {
          purpose: 'agent_turn',
          question,
          queryClassification: base.classification,
          workUnitId: run.workUnitId,
          runId: run.runId,
          budgetTokens: Math.max(1, Math.min(MAX_EVIDENCE_TOKENS, room)),
          sourceIds: scope.sourceIds,
          ...(scope.ceiling ? { maxClassification: scope.ceiling } : {}),
          signal: run.signal,
        },
      );
      if (!compiled.ok) throw new AppError('POLICY_DENIED');
      const additions: ContextMessage[] = [
        ...compiled.items.map((item) => ({
          role: 'evidence' as const,
          partId: `knowledge:${compiled.packageId}:${item.citationKey}`,
          text: `[${item.citationKey}]\n${item.text}`,
          classification: item.classification,
        })),
        ...compiled.verifiedFacts.map((fact) => ({
          role: 'evidence' as const,
          partId: `verified-fact:${fact.factId}`,
          text: JSON.stringify({
            trust: 'verified',
            subject: fact.subjectRef,
            predicate: fact.predicate,
            claim: fact.claim,
          }),
          classification: compiled.strongestClassification,
        })),
      ];
      const kept: ContextMessage[] = [];
      let remaining = Math.max(0, room);
      for (const message of additions) {
        if (message.text.length <= remaining) {
          kept.push(message);
          remaining -= message.text.length;
        }
      }
      const classification = strongestClassification(
        base.classification,
        compiled.strongestClassification,
      );
      const messages = [...base.messages, ...kept];
      return {
        ...base,
        messages,
        classification,
        task: { ...base.task, classification },
        requestHash: createHash('sha256')
          .update(
            canonicalJson(
              messages.map((message) => ({
                role: message.role,
                partId: message.partId,
                classification: message.classification,
                text: message.text,
              })),
            ),
          )
          .digest('hex'),
        sources: [
          ...base.sources,
          { type: 'knowledge_package', id: compiled.packageId, sha256: compiled.packageSha256 },
        ],
      };
    },
  };
}
