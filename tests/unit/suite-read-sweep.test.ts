// Which suite reads the upkeep deletes (ADR-038 D6), and migration 0564 holding the same rule. No
// database: the selection is pure, and the migration is read as text. Generated values only.
import {
  ENDED_RUN_STATUSES,
  SUITE_READ_KEEP_MS,
  suiteReadIsSpent,
} from '@ensemus/application/suite-reads';
import { AGENT_RUN_STATUSES, isTerminalAgentRun } from '@ensemus/domain/ai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

const now = new Date('2026-11-11T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('a suite read nobody will collect', () => {
  it('is kept while its run is live and it is under an hour old', () => {
    for (const status of ['queued', 'preparing', 'running', 'paused', 'waiting_for_approval']) {
      expect(suiteReadIsSpent({ createdAt: ago(60_000), runStatus: status }, now), status).toBe(
        false,
      );
    }
    expect(
      suiteReadIsSpent({ createdAt: ago(SUITE_READ_KEEP_MS), runStatus: 'running' }, now),
    ).toBe(false);
  });

  it('is deleted once its run has ended, whatever its age', () => {
    for (const status of AGENT_RUN_STATUSES.filter(isTerminalAgentRun)) {
      expect(suiteReadIsSpent({ createdAt: ago(1_000), runStatus: status }, now), status).toBe(
        true,
      );
    }
  });

  it('is deleted past an hour even while its run goes on, and when its run cannot be found', () => {
    expect(
      suiteReadIsSpent({ createdAt: ago(SUITE_READ_KEEP_MS + 1), runStatus: 'running' }, now),
    ).toBe(true);
    expect(suiteReadIsSpent({ createdAt: ago(1_000), runStatus: null }, now)).toBe(true);
  });

  it('counts a status it does not know as live, as the migration does', () => {
    expect(suiteReadIsSpent({ createdAt: ago(1_000), runStatus: 'made_up' }, now)).toBe(false);
  });
});

describe('migration 0564', () => {
  const sql = readFileSync(
    join(repoRoot, 'packages/database/migrations/0564_suite_upkeep_and_own_revoke.sql'),
    'utf8',
  );

  it('is flagged for human security review on its first line', () => {
    expect(sql.split(/\r?\n/)[0]).toBe('-- FLAGGED FOR HUMAN SECURITY REVIEW');
  });

  it('lets only the service context delete, by the same hour and the same ended statuses', () => {
    expect(sql).toContain('GRANT DELETE ON integrations.suite_reads TO ensemus_app;');
    expect(sql).toContain('AS RESTRICTIVE FOR DELETE TO ensemus_app');
    expect(sql).toContain("current_user = 'ensemus_app' AND knowledge.is_service_actor()");
    expect(SUITE_READ_KEEP_MS).toBe(3_600_000);
    expect(sql).toContain("created_at < now() - interval '1 hour'");
    const listed = /r\.status NOT IN \(([^)]*)\)/.exec(sql)![1]!.split(',');
    expect(listed.map((each) => each.replace(/'/g, '')).sort()).toEqual(
      [...ENDED_RUN_STATUSES].sort(),
    );
  });

  it('lets the owner revoke their own connection and change nothing else with it', () => {
    const owner = sql.slice(sql.indexOf("app.current_actor_type()='user'"));
    expect(owner).toContain('OLD.owner_membership_id IS NOT NULL');
    expect(owner).toContain('OLD.owner_membership_id=app.current_membership_id()');
    expect(owner).toContain("OLD.state<>'revoked' AND NEW.state='revoked'");
    expect(owner).toContain('NEW.version=OLD.version+1');
    // Its last error is not among what may change alongside, unlike 0561's no-op case.
    expect(owner).toContain("ARRAY['state','revoked_at','updated_at','version']");
    expect(owner).toContain('NEW.revoked_at:=now();NEW.updated_at:=now();RETURN NEW;');
  });
});
