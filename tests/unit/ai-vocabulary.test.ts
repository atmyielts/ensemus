// ADR-028: what the domain says, what reviewed SQL says and what the contracts say have to stay one thing.
// These run with no database, on the text of the migrations.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentRunStatusSchema } from '@ensemus/contracts/ai';
import { TOOL_ARGS_SCHEMAS } from '@ensemus/contracts/ai-tools';
import {
  AGENT_RUN_STATUSES,
  AGENT_RUN_TRANSITIONS,
  canTransitionAgentRun,
  isTerminalAgentRun,
  modelLedgerKey,
  strongestClassification,
  usdToMicros,
  type AgentRunStatus,
} from '@ensemus/domain/ai';
import { contentSha256, endpointDigest, modelKeyPurpose } from '@ensemus/domain/ai-binding';
import { FORBIDDEN_TOOL_PREFIXES, TOOL_IDS, TOOL_MANIFESTS } from '@ensemus/domain/ai-tools';
import { can } from '@ensemus/domain/policy';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

const migration = (name: string) =>
  readFileSync(join(repoRoot, 'packages/database/migrations', name), 'utf8');
const security = migration('0101_ai_security.sql');
const tables = migration('0100_ai.sql');

/** Reads the CASE in ai.check_agent_run_change into a table. */
function transitionsInSql(): Record<string, string[]> {
  const body = security.slice(security.indexOf('CREATE FUNCTION ai.check_agent_run_change'));
  const found: Record<string, string[]> = {};
  for (const match of body.matchAll(/WHEN '([a-z_]+)' THEN NEW\.status IN \(([^)]+)\)/g)) {
    found[match[1] as string] = (match[2] as string)
      .split(',')
      .map((item) => item.trim().replaceAll("'", ''))
      .sort();
  }
  return found;
}

describe('the run state machine', () => {
  it('is the same in the domain and in the trigger', () => {
    const inSql = transitionsInSql();
    for (const status of AGENT_RUN_STATUSES) {
      const allowed = [...AGENT_RUN_TRANSITIONS[status]].sort();
      if (allowed.length === 0) expect(inSql[status], status).toBeUndefined();
      else expect(inSql[status], status).toEqual(allowed);
    }
  });

  it('has the same statuses in the domain, the contract and the table', () => {
    expect([...agentRunStatusSchema.options].sort()).toEqual([...AGENT_RUN_STATUSES].sort());
    const check = /"agent_runs_status_check" CHECK \([^)]* in \(([^)]+)\)/.exec(tables);
    expect(check?.[1]?.replaceAll("'", '').split(',').sort()).toEqual(
      [...AGENT_RUN_STATUSES].sort(),
    );
  });

  it('never leaves a finished run, and a failed run stays failed', () => {
    const finished: AgentRunStatus[] = ['completed', 'failed', 'cancelled', 'timed_out'];
    for (const from of finished) {
      expect(isTerminalAgentRun(from)).toBe(true);
      for (const to of AGENT_RUN_STATUSES) expect(canTransitionAgentRun(from, to)).toBe(false);
    }
  });
});

describe('what a role can reach', () => {
  it('gives ensemus_app not one grant on prompts', () => {
    expect(security).not.toMatch(/GRANT[^;]*ON ai\.step_payloads TO ensemus_app/);
    expect(security).toMatch(/GRANT SELECT, INSERT, DELETE ON ai\.step_payloads TO ensemus_agent/);
  });

  it('gives no role UPDATE on a published version or on the ledger', () => {
    expect(security).not.toMatch(/GRANT UPDATE[^;]*ON ai\.agent_versions/);
    expect(security).not.toMatch(/GRANT UPDATE[^;]*ON platform\.usage_ledger/);
    expect(security).toMatch(/usage_ledger_append_only/);
    expect(security).toMatch(/agent_versions_immutable/);
  });

  it('leaves a run limits nobody can update', () => {
    const updates = [...security.matchAll(/GRANT UPDATE \(([^)]+)\)\s+ON ai\.agent_runs/g)]
      .map((match) => match[1] as string)
      .join(',');
    for (const limit of [
      'max_model_turns',
      'max_tool_calls',
      'max_total_tokens',
      'max_cost_micros',
      'timeout_seconds',
      'max_delegation_depth',
      'delegated_scopes',
      'initiator_membership_id',
    ]) {
      expect(updates, limit).not.toContain(limit);
    }
  });

  it('gives the dispatcher and the secrets role nothing here', () => {
    expect(security).not.toMatch(/TO ensemus_dispatcher/);
    expect(security).not.toMatch(/TO ensemus_secrets/);
  });

  it('stops clearly when the role has not been provisioned', () => {
    expect(security).toContain('ROLE_MISSING: ensemus_agent');
  });

  it('holds no free-text column on a step', () => {
    const step = /CREATE TABLE "ai"\."execution_steps" \(([\s\S]*?)\n\);/.exec(tables)?.[1] ?? '';
    expect(step).not.toMatch(/summary|message|text_body|reason"/);
  });
});

describe('capabilities', () => {
  it('give a plain member none of the AI capabilities', () => {
    for (const capability of [
      'model.manage',
      'model.activate',
      'agent.publish',
      'agent.run',
      'agent.stop',
      'ai.halt',
      'budget.manage',
      'usage.view',
    ] as const) {
      expect(can('member', capability), capability).toBe(false);
      expect(can('owner', capability), capability).toBe(true);
      expect(can('admin', capability), capability).toBe(true);
    }
  });
});

describe('tools', () => {
  it('have one list, with arguments for every tool', () => {
    expect(Object.keys(TOOL_ARGS_SCHEMAS).sort()).toEqual([...TOOL_IDS].sort());
  });

  it('include nothing that reaches a secret, a model, a budget or a grant', () => {
    for (const id of TOOL_IDS) {
      for (const prefix of FORBIDDEN_TOOL_PREFIXES) expect(id.startsWith(prefix)).toBe(false);
    }
  });

  it('always ask a person before an external effect', () => {
    for (const tool of TOOL_MANIFESTS) {
      if (tool.class === 'external_write') expect(tool.requiresApproval).toBe(true);
    }
  });

  it('refuse an extra argument', () => {
    const parsed = TOOL_ARGS_SCHEMAS['work.read'].safeParse({
      work_unit_id: '6f1c2c6e-1111-4111-8111-111111111111',
      approver: 'someone',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('money', () => {
  it.each([
    ['0', 0],
    ['1', 1_000_000],
    ['0.30', 300_000],
    ['12.000001', 12_000_001],
  ])('reads %s as exact micros', (usd, micros) => {
    expect(usdToMicros(usd)).toBe(micros);
  });

  it.each(['1.0000001', '-1', '1e3', '', '.5', '1,5'])('refuses %s', (usd) => {
    expect(() => usdToMicros(usd)).toThrow();
  });

  it('keys a model call by run, step and attempt', () => {
    expect(modelLedgerKey('r', 3, 2)).toBe('model:r:3:2');
  });
});

describe('a class', () => {
  it('only rises when mixed', () => {
    expect(strongestClassification('public', 'restricted')).toBe('restricted');
    expect(strongestClassification('confidential', 'internal')).toBe('confidential');
    expect(strongestClassification('internal', 'internal')).toBe('internal');
  });
});

describe('a key bound to an endpoint', () => {
  const profile = '6f1c2c6e-1111-4111-8111-111111111111';

  it('changes purpose when the endpoint changes, so the sealed key will not open', () => {
    expect(modelKeyPurpose(profile, 'https://a.example.invalid/v1')).not.toBe(
      modelKeyPurpose(profile, 'https://b.example.invalid/v1'),
    );
  });

  it('changes purpose for another profile', () => {
    expect(modelKeyPurpose(profile, 'https://a.example.invalid/v1')).not.toBe(
      modelKeyPurpose('6f1c2c6e-2222-4222-8222-222222222222', 'https://a.example.invalid/v1'),
    );
  });

  it('reads an equal address the same way', () => {
    expect(endpointDigest('https://A.example.invalid/v1/')).toBe(
      endpointDigest('https://a.example.invalid/v1'),
    );
  });

  it('hashes content, so a trace can hold that instead', () => {
    expect(contentSha256('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
