import type { RunRef } from '@ensemus/agent-runtime/context';
import { currentRunInputClass } from '@ensemus/application/ai-model-admission';
import { readRunFacts } from '@ensemus/application/ai-runs';
import type { CompileDeps } from '@ensemus/application/knowledge/compiler';
import type { AgentContext, AppDatabase } from '@ensemus/database';
import { AGENT_TURN_PURPOSE, strongestClassification } from '@ensemus/domain/ai';
import type { InferenceTask, ModelRouter } from '@ensemus/intelligence';

/** What `compileEvidence` asks about, with the turn's own task as the runtime compiled it. */
export type AgentContextRequest = Parameters<
  NonNullable<CompileDeps['authorizeAgentContext']>
>[1] & {
  task: InferenceTask;
};

export type AuthorizeAgentContext = (
  context: AgentContext,
  run: RunRef,
  input: AgentContextRequest,
) => Promise<boolean>;

/**
 * The runtime's egress decision for Knowledge evidence an agent turn would carry to its main model. Only the
 * run's own current model step may ask, for its own running run and Work, at no less than the run's input
 * floor. The answer is the main router's, through the tenant's profiles and policy bundle, so it writes the
 * same egress decision row a turn would (allow or deny), and a refusal leaves nothing else behind.
 *
 * `also` is an extra condition the composition may add. It can only refuse more, never allow more.
 */
export function createAgentContextAuthorizer(deps: {
  database: AppDatabase;
  router: ModelRouter;
  also?: AuthorizeAgentContext;
}): AuthorizeAgentContext {
  const { database, router } = deps;
  return async (ctx, run, input) => {
    if (
      input.task.purpose !== AGENT_TURN_PURPOSE ||
      input.task.runId !== run.runId ||
      !run.modelStep
    )
      return false;
    const facts = await readRunFacts(database, ctx, { agentRunId: run.runId });
    if (
      !facts ||
      facts.status !== 'running' ||
      facts.workUnitId !== run.workUnitId ||
      facts.agentVersionId !== run.agentVersionId
    )
      return false;
    const floor = strongestClassification(
      await currentRunInputClass(database, ctx),
      facts.classification,
    );
    if (strongestClassification(floor, input.classification) !== input.classification) return false;
    const verdict = await router.select(
      {
        ...input.task,
        purpose: AGENT_TURN_PURPOSE,
        classification: input.classification,
        pinned: facts.bound
          ? { profileId: facts.bound.profileId, profileVersion: facts.bound.profileVersion }
          : null,
      },
      ctx,
    );
    return verdict.kind === 'selected' && (!deps.also || (await deps.also(ctx, run, input)));
  };
}
