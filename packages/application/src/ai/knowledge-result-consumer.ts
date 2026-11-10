// A per-principal, in-memory receipt capability, issued only by this factory wrapping a real model
// response. Callers get no context/binding map and cannot consume an invented/other call's receipt.
import { modelCallAttempts, modelCallInputs } from '@ensemus/database';
import {
  ModelCallFailed,
  type KnowledgeModelPort,
  type ModelUsage,
} from '@ensemus/knowledge/ports';
import { and, eq, sql } from 'drizzle-orm';
import {
  assertKnowledgeAgentScopeInTx,
  bindModelPrincipal,
  lockKnowledgeModelInputs,
} from './knowledge-call-store';
import { lockRunInputsForContent } from './input-observations';
import type { KnowledgeModelPrincipal, ModelResultConsumer } from './knowledge-ports';

const bindings = [
  'app.organization_id',
  'app.user_id',
  'app.membership_id',
  'app.actor_type',
  'app.agent_run_id',
  'app.agent_input_protocol',
  'app.agent_scope_protocol',
  'app.agent_authority_protocol',
  'app.terminal_work_control_run',
  'app.knowledge_model_protocol',
  'app.model_job_id',
  'app.interactive_session_id',
] as const;
const denied = () => new ModelCallFailed('EGRESS_DENIED');
export function bindKnowledgeModelReceipts(
  principal: KnowledgeModelPrincipal,
  actual: KnowledgeModelPort,
): {
  model: KnowledgeModelPort;
  acceptResultInTx: ModelResultConsumer;
} {
  const receipts = new WeakMap<ModelUsage, string>();
  const remember = (usage: ModelUsage) => {
    if (!usage.callId) throw denied();
    receipts.set(usage, usage.callId);
    Object.freeze(usage);
  };
  const model: KnowledgeModelPort = {
    ...(actual.recordsCalls ? { recordsCalls: true as const } : {}),
    route: (request) => actual.route(request),
    async embed(...args) {
      const result = await actual.embed(...args);
      remember(result.usage);
      return result;
    },
    async rerank(...args) {
      const result = await actual.rerank(...args);
      remember(result.usage);
      return result;
    },
    async answer(...args) {
      const result = await actual.answer(...args);
      remember(result.usage);
      return result;
    },
  };
  const acceptResultInTx: ModelResultConsumer = async (tx, usage, target) => {
    const callId = receipts.get(usage);
    if (!callId || usage.callId !== callId) throw denied();
    // A SQL error rolls this actual savepoint back, restoring every temporary setting even when the
    // caller catches the error. Successful consumption explicitly restores all original settings.
    await tx.transaction(async (inner) => {
      const current = await inner.execute<{ name: string; value: string | null }>(
        sql`select v.name,current_setting(v.name,true) value from(values ${sql.join(
          bindings.map((name) => sql`(${name})`),
          sql`,`,
        )}) v(name)`,
      );
      if (
        current.rows.find((row) => row.name === 'app.organization_id')?.value !==
        principal.context.organizationId
      )
        throw denied();
      const role = await inner.execute<{ role: string }>(sql`select current_user::text role`);
      if (role.rows[0]?.role !== 'ensemus_agent') throw denied();
      const c = principal.context;
      const temporary: Record<string, string> = {
        'app.user_id': c.userId,
        'app.membership_id': c.membershipId,
        'app.actor_type': c.actorType,
        'app.agent_run_id': principal.kind === 'agent_run' ? principal.step.runId : '',
        'app.agent_input_protocol': principal.kind === 'agent_run' ? 'v1' : '',
        'app.agent_scope_protocol': '',
        'app.agent_authority_protocol': '',
        'app.terminal_work_control_run': '',
        'app.interactive_session_id': '',
      };
      for (const [name, value] of Object.entries(temporary))
        await inner.execute(sql`select set_config(${name},${value},true)`);
      await bindModelPrincipal(inner, principal);
      const [call] = await inner
        .select()
        .from(modelCallAttempts)
        .where(
          and(
            eq(modelCallAttempts.id, callId),
            principal.kind === 'job'
              ? eq(modelCallAttempts.jobId, principal.jobId)
              : and(
                  eq(modelCallAttempts.runId, principal.step.runId),
                  eq(modelCallAttempts.stepId, principal.step.stepId),
                ),
          ),
        );
      if (!call) throw denied();
      const inputs = await inner
        .select()
        .from(modelCallInputs)
        .where(eq(modelCallInputs.callId, callId))
        .limit(1001);
      if (inputs.length > 1000) throw denied();
      await lockKnowledgeModelInputs(
        inner,
        inputs.map((input) => ({
          kind: input.kind,
          id: input.inputId,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        })),
      );
      await assertKnowledgeAgentScopeInTx(inner, principal, call.classification, inputs);
      if (principal.kind === 'agent_run') await lockRunInputsForContent(inner, principal.context);
      await inner.execute(
        sql`select ai.assert_model_call(c) from ai.model_call_attempts c where c.organization_id=${c.organizationId}::uuid and c.id=${callId}::uuid`,
      );
      const fresh = await inner.execute<{ ok: boolean }>(
        sql`select ai.model_call_inputs_readable(${callId}::uuid,${c.membershipId}::uuid) ok`,
      );
      if (!fresh.rows[0]?.ok) throw denied();
      if (call.state === 'accepted') {
        if (call.resultKind !== target.kind || call.resultId !== target.id) throw denied();
      } else {
        if (call.state !== 'response_received') throw denied();
        if (target.kind === 'embeddings') {
          const exact = await inner.execute(
            sql`select 1 from knowledge.embedding_spaces s where s.organization_id=${c.organizationId}::uuid and s.id=${target.spaceId}::uuid and s.qualification_id=${call.qualificationId}::uuid`,
          );
          if (!exact.rows.length) throw denied();
        }
        const accepted = await inner
          .update(modelCallAttempts)
          .set({ state: 'accepted', resultKind: target.kind, resultId: target.id })
          .where(
            and(eq(modelCallAttempts.id, callId), eq(modelCallAttempts.state, 'response_received')),
          )
          .returning({ id: modelCallAttempts.id });
        if (!accepted.length) throw denied();
      }
      for (const saved of current.rows)
        await inner.execute(sql`select set_config(${saved.name},${saved.value ?? ''},true)`);
    });
  };
  return { model, acceptResultInTx };
}
