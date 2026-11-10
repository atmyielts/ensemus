// Fixed terminal-run status authority. No body row, login/MFA proof, binding map or arbitrary target
// is exposed. Each SQL effect independently rechecks the same real run/Work/Temporal/state/version.
import {
  artifactAclCatalog,
  artifactWorkLinks,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { AGENT_RUN_STATUSES, isTerminalAgentRun } from '@ensemus/domain/ai';
import { WORK_STATES } from '@ensemus/domain/work-unit';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';
import { releaseTerminalWorkInTx, type WorkTransitionMetadata } from '../work';

const wire = z.strictObject({
  id: idSchema,
  status: z.enum(WORK_STATES),
  version: z.preprocess(
    (value) => (typeof value === 'string' ? Number(value) : value),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ),
  classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  ownerMembershipId: idSchema,
  runId: z.string().nullable(),
  runRequestedAt: z.coerce.date().nullable(),
  runRequestedByMembershipId: idSchema.nullable(),
  hasExecutionPlan: z.boolean(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  runStatus: z.enum(AGENT_RUN_STATUSES),
  initiatorMembershipId: idSchema,
});
type Facts = z.infer<typeof wire>;
type Patch = {
  status: string;
  version: number;
  updatedAt: Date;
  runId: string | null;
  runRequestedAt?: null;
};
const genuine = new WeakMap<object, { tx: Tx; context: TenantContext }>();
export type TerminalWorkControl = {
  readonly current: WorkTransitionMetadata;
  readonly runStatus: Facts['runStatus'];
  readonly hasExecutionPlan: boolean;
  readonly contentSha256: string;
  write(patch: Patch): Promise<WorkTransitionMetadata>;
  visibleArtifactIds(): Promise<readonly string[]>;
};
export function isTerminalWorkControl(value: TerminalWorkControl, tx: Tx, context: TenantContext) {
  const issued = genuine.get(value);
  return issued?.tx === tx && issued.context === context;
}

const metadata = (facts: Facts): WorkTransitionMetadata =>
  Object.freeze({
    id: facts.id,
    status: facts.status,
    version: facts.version,
    classification: facts.classification,
    ownerMembershipId: facts.ownerMembershipId,
    runId: facts.runId,
    runRequestedAt: facts.runRequestedAt,
    runRequestedByMembershipId: facts.runRequestedByMembershipId,
  });
const safeFailure = (error: unknown) =>
  new AppError(
    ['55P03', '40001'].includes(pgCode(error) ?? '') ? 'VERSION_CONFLICT' : 'INVALID_STATE',
  );
function factsOf(row: unknown, context: TenantContext): Facts {
  const parsed = wire.safeParse(row);
  if (
    !parsed.success ||
    !isTerminalAgentRun(parsed.data.runStatus) ||
    (context.actorType === 'agent' && parsed.data.initiatorMembershipId !== context.membershipId)
  )
    throw new AppError('INVALID_STATE');
  return parsed.data;
}

export async function loadTerminalWorkControlInTx(
  tx: Tx,
  context: TenantContext,
  runId: string,
): Promise<{ kind: 'legacy' | 'unowned' } | { kind: 'control'; control: TerminalWorkControl }> {
  if (
    context.actorType !== 'service' &&
    (context.actorType !== 'agent' || context.agentRunId !== runId)
  )
    throw new AppError('FORBIDDEN');
  const version = await tx.execute<{ protocol: string | null }>(
    sql`select ai.run_authority_protocol_version(${runId}::uuid) protocol`,
  );
  if (version.rows[0]?.protocol === 'legacy') return { kind: 'legacy' };
  if (version.rows[0]?.protocol !== 'authority-v1') throw new AppError('FORBIDDEN');
  let current: Facts;
  try {
    const rows = await tx.execute(
      sql`select id,status,version,classification,"ownerMembershipId","runId","runRequestedAt","runRequestedByMembershipId","hasExecutionPlan","contentSha256","runStatus","initiatorMembershipId" from work.agent_terminal_control_facts(${runId}::uuid)`,
    );
    if (!rows.rows.length) return { kind: 'unowned' };
    current = factsOf(rows.rows[0], context);
  } catch (error) {
    throw safeFailure(error);
  }
  const originalId = current.id,
    originalHash = current.contentSha256,
    initiatorMembershipId = current.initiatorMembershipId;
  const control: TerminalWorkControl = Object.freeze({
    get current() {
      return metadata(current);
    },
    get runStatus() {
      return current.runStatus;
    },
    get hasExecutionPlan() {
      return current.hasExecutionPlan;
    },
    get contentSha256() {
      return current.contentSha256;
    },
    async write(patch: Patch) {
      if (
        !['running', 'failed', 'verifying'].includes(patch.status) ||
        !Number.isSafeInteger(patch.version) ||
        patch.version !== current.version + 1
      )
        throw new AppError('INVALID_STATE');
      try {
        const rows = await tx.execute(
          sql`select id,status,version,classification,"ownerMembershipId","runId","runRequestedAt","runRequestedByMembershipId","hasExecutionPlan","contentSha256","runStatus","initiatorMembershipId" from work.agent_terminal_control_transition(${runId}::uuid,${current.version}::bigint,${current.status},${patch.status})`,
        );
        const next = factsOf(rows.rows[0], context);
        if (
          next.id !== originalId ||
          next.contentSha256 !== originalHash ||
          next.version !== patch.version ||
          next.status !== patch.status ||
          next.runId !== patch.runId
        )
          throw new AppError('INVALID_STATE');
        current = next;
        return metadata(current);
      } catch (error) {
        throw safeFailure(error);
      }
    },
    async visibleArtifactIds() {
      const rows = await tx
        .select({ id: artifactAclCatalog.artifactId })
        .from(artifactWorkLinks)
        .innerJoin(
          artifactAclCatalog,
          and(
            eq(artifactAclCatalog.organizationId, artifactWorkLinks.organizationId),
            eq(artifactAclCatalog.artifactId, artifactWorkLinks.artifactId),
          ),
        )
        .where(
          and(
            eq(artifactWorkLinks.workUnitId, originalId),
            eq(artifactAclCatalog.alive, true),
            sql`knowledge.artifact_readable(${artifactAclCatalog.artifactId},${initiatorMembershipId}::uuid)`,
          ),
        )
        .orderBy(asc(artifactAclCatalog.artifactId));
      return Object.freeze(rows.map((row) => row.id));
    },
  });
  genuine.set(control, { tx, context });
  return { kind: 'control', control };
}

/** Only the actual agent login's fixed terminal RPC can authorize this conservative effect. This
 * adapter never hands its service context, binding map or a callback to the agent-run caller. */
export async function releaseTerminalWorkForLookupInTx(
  tx: Tx,
  organizationId: string,
  runId: string,
) {
  const native = await tx.execute<{ allowed: boolean }>(sql`select current_user='ensemus_agent'
    and session_user='ensemus_agent' and app.current_organization_id()=${organizationId}::uuid allowed`);
  if (native.rows[0]?.allowed !== true) throw new AppError('FORBIDDEN');
  const selectors = [
    'app.user_id',
    'app.membership_id',
    'app.agent_run_id',
    'app.agent_input_protocol',
    'app.agent_scope_protocol',
    'app.agent_authority_protocol',
    'app.interactive_session_id',
    'app.terminal_work_control_run',
    'app.actor_type',
  ] as const;
  const previous = await tx.execute<{ setting_name: string; setting_value: string }>(sql`
    select setting_name,coalesce(current_setting(setting_name,true),'') setting_value
    from unnest(array[${sql.join(
      selectors.map((name) => sql`${name}::text`),
      sql`, `,
    )}]) setting_name`);
  if (
    previous.rows.length !== selectors.length ||
    previous.rows.some((row) => !selectors.includes(row.setting_name as (typeof selectors)[number]))
  )
    throw new AppError('INVALID_STATE');
  const service = createServiceContext(organizationId);
  try {
    // The savepoint contains only these fixed metadata operations. It also makes the outer
    // transaction usable for restoration if a native SQL guard rejects the effect.
    await tx.transaction(async (controlTx) => {
      for (const name of selectors)
        await controlTx.execute(
          sql`select set_config(${name},${name === 'app.actor_type' ? 'service' : ''},true)`,
        );
      const terminal = await loadTerminalWorkControlInTx(controlTx, service, runId);
      if (terminal.kind === 'control')
        await releaseTerminalWorkInTx(controlTx, service, terminal.control);
    });
  } finally {
    for (const row of previous.rows)
      await tx.execute(sql`select set_config(${row.setting_name},${row.setting_value},true)`);
  }
}
