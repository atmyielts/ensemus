// A run's generated file written the way the tool gateway's artifact.draft.create writes one. An
// authority-v1 run's output inventory exists only inside a transaction that holds that run's own
// read-scope and authority-v1 admission (0417, 0525: the gate's readRun(lock: true)), so a bare
// addGeneratedArtifact transaction is refused INVALID_STATE before any lineage is written. Nothing
// here admits anything the gateway would not.
import type { ObjectStore } from '@ensemus/application';
import { createToolStepStore } from '@ensemus/application/ai-tool-steps';
import {
  agentRuns,
  withTenantTx,
  type AgentContext,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import { eq } from 'drizzle-orm';

/** The run's own transaction moves it from queued to running, as ai-input-protocol's fixture does. */
export async function startRunning(database: AppDatabase, context: AgentContext): Promise<void> {
  await withTenantTx(database, context, async (tx) => {
    await tx
      .update(agentRuns)
      .set({ status: 'preparing' })
      .where(eq(agentRuns.id, context.agentRunId));
    await tx
      .update(agentRuns)
      .set({ status: 'running' })
      .where(eq(agentRuns.id, context.agentRunId));
  });
}

/**
 * Opens the tool step, notes the upload, puts the bytes once and publishes the bound file, each
 * effect in its own transaction behind the gate, exactly as the gateway sequences them.
 */
export async function draftRunOutput(
  database: AppDatabase,
  objects: Pick<ObjectStore, 'put'>,
  context: AgentContext,
  input: { workUnitId: string; stepNumber: number; name: string; text: string },
): Promise<{ id: string }> {
  const runId = context.agentRunId;
  const tools = createToolStepStore({ database, objects });
  const draftId = tools.draftIdFor(context, { runId, stepNumber: input.stepNumber });
  const gated = <T>(effect: (tx: Tx) => Promise<T>) =>
    tools.withTx(context, async (tx) => {
      const facts = await tools.readRun(tx, context, runId, { lock: true });
      if (!facts?.inputsOpen) throw new Error('TEST_RUN_NOT_ADMITTED');
      return effect(tx);
    });
  const step = await gated((tx) =>
    tools.openStep(tx, context, {
      runId,
      stepNumber: input.stepNumber,
      toolId: 'artifact.draft.create',
    }),
  );
  if (!step) throw new Error('TEST_TOOL_STEP_NOT_OPENED');
  const write = await gated((tx) =>
    tools.noteDraftUpload(tx, context, {
      draftId,
      workUnitId: input.workUnitId,
      runId,
      text: input.text,
    }),
  );
  await tools.putDraft(context, { draftId, text: input.text, write });
  await gated((tx) =>
    tools.insertDraft(tx, context, {
      draftId,
      runId,
      stepId: step.stepId,
      workUnitId: input.workUnitId,
      name: input.name,
      text: input.text,
      classification: 'internal',
      evidence: [],
      write,
    }),
  );
  return { id: draftId };
}
