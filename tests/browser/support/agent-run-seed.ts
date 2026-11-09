// A run for tests/browser/specs/agent-run.spec.ts, walked forward as a worker would. No worker runs in
// the browser stack, so this writes what one would write, through the same roles, triggers and
// admission the worker goes through, and nothing the rules forbid.
import { createHash, randomUUID } from 'node:crypto';
import { executionSteps, stepPayloads } from '@ensemus/database';
import pg from 'pg';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  withAdmittedRunTx,
} from '../../helpers/ai/fixtures';
import { urls } from '../../helpers/stack';

export type SeedRunInput = {
  organization: string;
  workUnitId: string;
  versionId: string;
  initiatorMembership: string;
  /** The statuses the run is moved through, in order. It must reach `running`. */
  path: readonly string[];
  stopCode?: string;
  canary?: string;
};

/**
 * A run with one model step, and, given a canary, model text only the agent role can read.
 *
 * A run born since 0417 is an authority-v1 run, and its step and payload rows are refused
 * (RUN_AUTHORITY_PROTOCOL_REQUIRED, 0417 and 0525) unless the writing transaction holds that run's
 * own admission. So, as the worker does, the step is written while the run is running, in a
 * transaction that first takes the run's read-scope and authority-v1 admission
 * (`withAdmittedRunTx`, after the Work has been read through the product's context source), and only
 * then is the run moved on to where the test wants it. No protocol setting is made by hand.
 */
export async function seedRun(input: SeedRunInput): Promise<string> {
  const live = input.path.indexOf('running');
  if (live < 0) throw new Error('TEST_RUN_PATH_NEVER_RUNS');
  const sql = new pg.Client({ connectionString: urls.superuser() });
  const agent = new pg.Client({ connectionString: urls.agent() });
  const agentDatabase = openAgentTestDatabase();
  try {
    await sql.connect();
    await agent.connect();
    const runId = randomUUID();
    // Born in its own tenant's context, as the birth fence (0529, 0533) requires.
    await sql.query(`select set_config('app.organization_id', $1, false)`, [input.organization]);
    await sql.query(
      `insert into ai.agent_runs
         (organization_id, id, work_unit_id, agent_version_id, initiator_membership_id,
          service_identity_id, effective_classification, max_model_turns, max_tool_calls,
          max_total_tokens, max_cost_micros, timeout_seconds, delegated_scopes)
       select $1, $2, $3, $4, $5, d.service_identity_id, 'internal', 5, 5, 10000, 1000000, 60,
              '{"tools":["work.read"]}'
         from ai.agent_versions v
         join ai.agent_definitions d
           on d.organization_id = v.organization_id and d.id = v.definition_id
        where v.id = $4`,
      [input.organization, runId, input.workUnitId, input.versionId, input.initiatorMembership],
    );
    await agent.query(`select set_config('app.organization_id', $1, false)`, [input.organization]);
    const walk = async (statuses: readonly string[]) => {
      for (const status of statuses) {
        await agent.query(`update ai.agent_runs set status = $2, stop_code = $3 where id = $1`, [
          runId,
          status,
          status === input.path.at(-1) ? (input.stopCode ?? null) : null,
        ]);
      }
    };
    await walk(input.path.slice(0, live + 1));
    const context = await prepareRunInputContext(agentDatabase.db, input.organization, runId);
    const stepId = randomUUID();
    await withAdmittedRunTx(agentDatabase.db, context, async (tx) => {
      await tx.insert(executionSteps).values({
        organizationId: input.organization,
        id: stepId,
        runId,
        stepNumber: 0,
        kind: 'model_turn',
        state: 'completed',
        labelCode: 'THINKING',
        outcome: 'tool_proposed',
      });
      if (input.canary) {
        await tx.insert(stepPayloads).values({
          organizationId: input.organization,
          stepId,
          kind: 'completion',
          classification: 'internal',
          content: input.canary,
          contentSha256: createHash('sha256').update(input.canary).digest('hex'),
        });
      }
    });
    await walk(input.path.slice(live + 1));
    return runId;
  } finally {
    await agentDatabase.close();
    await agent.end();
    await sql.end();
  }
}
