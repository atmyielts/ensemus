// SEC-06, QA-AI-KILL, ADR-028 FD-15. The kill switch on real PostgreSQL, as the real roles: forced RLS on
// the switches, the trigger on M3's attempts, and the operator's command on the migrator role. Needs the
// role provisioning step in ADR-028. Written and typechecked. It has not been run yet.
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { createWorkUnit, getWorkUnit, listWorkUnits } from '@ensemus/application';
import {
  createHaltCheck,
  engageKillSwitch,
  listKillSwitches,
  readLiveSwitches,
  releaseKillSwitch,
} from '@ensemus/application/ai-halt';
import {
  agentRuns,
  auditEvents,
  domainEvents,
  executionSteps,
  externalActionAttempts,
  killSwitches,
  modelProfiles,
  openAppDatabase,
  toolProposals,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { createAgentContext, withRunLookupTx } from '@ensemus/database/agent';
import {
  engageOperatorSwitch,
  listOperatorSwitches,
  OperatorSwitchNotFound,
  releaseOperatorSwitch,
} from '@ensemus/database/halt-operator';
import { PROVIDER_KINDS } from '@ensemus/domain/ai';
import { idempotencyKeyFor } from '@ensemus/domain/external-action';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createHaltWatcher,
  parseHaltCommand,
  runHaltCommand,
  switchReaderFor,
} from '../../workers/workflow/src/kill-switch';
import {
  openAgentTestDatabase,
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  sha256Of,
  type AiTenant,
  type SeededAgentVersion,
} from '../helpers/ai/fixtures';
import { seedConnection, seedExternalAction } from '../helpers/integrations';
import { urls } from '../helpers/stack';

const halted = expect.objectContaining({ code: 'AI_HALTED' });
const refusedWith = (code: string) => expect.objectContaining({ code });
const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

describe('the kill switch, as the real roles', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let a: AiTenant;
  let b: AiTenant;
  let versionA: SeededAgentVersion;
  const check = createHaltCheck();

  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 3 });
    agent = openAgentTestDatabase(3);
    // Two tenants with one name, so nothing below can pass by telling them apart that way.
    a = await seedAiTenant(app.db);
    b = await seedAiTenant(app.db);
    versionA = await seedAgentVersion(app.db, a.owner);
  });

  // An operator's switch stops every tenant in this database, including other test files'. So none outlives
  // its test, whatever happened in it.
  afterEach(async () => {
    for (const row of await listOperatorSwitches(urls.migrator())) {
      await releaseOperatorSwitch(urls.migrator(), row.id);
    }
    for (const tenant of [a, b]) {
      await withTenantTx(app.db, tenant.owner, (tx) =>
        tx
          .update(killSwitches)
          .set({ releasedAt: new Date() })
          .where(
            and(
              eq(killSwitches.organizationId, tenant.organizationId),
              isNull(killSwitches.releasedAt),
            ),
          ),
      );
    }
  });

  afterAll(async () => {
    await app.close();
    await agent.close();
  });

  const newWork = async (tenant: AiTenant) =>
    (await createWorkUnit(app.db, tenant.owner, { title: 'Agent work', objective: 'Do it.' })).id;

  /** A run on a new Work Unit, moved as far as the agent role would move it. */
  const runningRun = async (
    tenant: AiTenant,
    version: SeededAgentVersion,
    profile?: { id: string; version: number },
  ) => {
    const workUnitId = await newWork(tenant);
    const runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId, version });
    await withRunLookupTx(agent.db, tenant.organizationId, async (tx) => {
      await tx.update(agentRuns).set({ status: 'preparing' }).where(eq(agentRuns.id, runId));
      await tx
        .update(agentRuns)
        .set({
          status: 'running',
          ...(profile ? { boundProfileId: profile.id, boundProfileVersion: profile.version } : {}),
        })
        .where(eq(agentRuns.id, runId));
    });
    return { runId, workUnitId };
  };

  const agentContextFor = (tenant: AiTenant, runId: string) =>
    createAgentContext(agent.db, {
      organizationId: tenant.organizationId,
      initiatorMembershipId: tenant.owner.membershipId,
      agentRunId: runId,
    });

  const assertRunning = (
    database: AppDatabase,
    context: TenantContext,
    target: Parameters<typeof check.assertRunning>[2],
  ) => withTenantTx(database, context, (tx) => check.assertRunning(tx, context, target));

  /** An effect an agent proposed through M3, waiting on its first attempt. */
  const agentProposedAction = async (tenant: AiTenant, version: SeededAgentVersion) => {
    const { runId, workUnitId } = await runningRun(tenant, version);
    const connectionId = await seedConnection(app.db, tenant.owner);
    const action = await seedExternalAction(app.db, tenant.owner, {
      workUnitId,
      connectionId,
      approverMembershipId: tenant.member.membershipId,
      status: 'ready',
    });
    const stepId = randomUUID();
    await withRunLookupTx(agent.db, tenant.organizationId, async (tx) => {
      await tx.insert(executionSteps).values({
        organizationId: tenant.organizationId,
        id: stepId,
        runId,
        stepNumber: 0,
        kind: 'tool_call',
        state: 'in_flight',
        labelCode: 'SENDING_EMAIL',
      });
      await tx.insert(toolProposals).values({
        organizationId: tenant.organizationId,
        runId,
        stepId,
        toolId: 'email.send',
        toolVersion: '1',
        payloadHash: sha256Of(action.id),
        idempotencyKey: `halt-test-${stepId}`,
        approvalId: action.approvalId,
        externalActionId: action.id,
        status: 'approved',
      });
    });
    return { action, runId };
  };

  const firstAttempt = (tenant: AiTenant, action: { id: string; requestHash: string }) =>
    withTenantTx(app.db, tenant.owner, (tx) =>
      tx.insert(externalActionAttempts).values({
        organizationId: tenant.organizationId,
        externalActionId: action.id,
        attemptNo: 1,
        requestHash: action.requestHash,
        idempotencyKey: idempotencyKeyFor(action.id),
        runId: 'halt-test',
      }),
    );

  describe.each([
    {
      scope: 'global',
      engage: () =>
        engageOperatorSwitch(urls.migrator(), { scope: 'global', reasonCode: 'INCIDENT' }),
    },
    {
      scope: 'organization',
      engage: async () =>
        (
          await engageKillSwitch(app.db, a.owner, {
            scope: 'organization',
            target_ref: null,
            reason_code: 'INCIDENT',
          })
        ).switchId,
    },
    {
      scope: 'agent_version',
      engage: async () =>
        (
          await engageKillSwitch(app.db, a.owner, {
            scope: 'agent_version',
            target_ref: versionA.versionId,
            reason_code: 'INCIDENT',
          })
        ).switchId,
    },
  ])('a $scope switch', ({ engage }) => {
    it('blocks a queued run', async () => {
      const workUnitId = await newWork(a);
      await seedQueuedRun(app.db, a.owner, { workUnitId, version: versionA });
      await engage();
      await expect(
        assertRunning(agent.db, a.owner, { agentVersionId: versionA.versionId }),
      ).rejects.toEqual(halted);
    });

    it('blocks the next turn and the next tool of a run under way', async () => {
      const { runId } = await runningRun(a, versionA);
      const context = await agentContextFor(a, runId);
      await assertRunning(agent.db, context, {});
      await engage();
      await expect(
        assertRunning(agent.db, context, { providerKind: 'local_openai_compatible' }),
      ).rejects.toEqual(halted);
      await expect(assertRunning(agent.db, context, {})).rejects.toEqual(halted);
    });

    it('blocks an effect with no one telling anyone: the attempt itself is refused and nothing was sent', async () => {
      const { action } = await agentProposedAction(a, versionA);
      await engage();
      await expect(firstAttempt(a, action)).rejects.toEqual(sqlState('EN007'));
      const attempts = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(externalActionAttempts)
          .where(eq(externalActionAttempts.externalActionId, action.id)),
      );
      expect(attempts).toEqual([]);
    });
  });

  describe('a provider switch', () => {
    let profileId: string;

    beforeAll(async () => {
      profileId = await seedActiveProfile(app.db, agent.db, a.owner);
    });

    const providerOf = async () => {
      const [row] = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select({ kind: modelProfiles.providerKind, version: modelProfiles.version })
          .from(modelProfiles)
          .where(eq(modelProfiles.id, profileId)),
      );
      if (!row) throw new Error('Profile not found');
      return row;
    };

    it('blocks a queued run at the turn that would use that provider', async () => {
      const { kind } = await providerOf();
      await engageOperatorSwitch(urls.migrator(), {
        scope: 'provider',
        providerKind: kind,
        reasonCode: 'INCIDENT',
      });
      const workUnitId = await newWork(a);
      await seedQueuedRun(app.db, a.owner, { workUnitId, version: versionA });
      await expect(
        assertRunning(agent.db, a.owner, {
          agentVersionId: versionA.versionId,
          providerKind: kind as never,
        }),
      ).rejects.toEqual(halted);
    });

    it('blocks the next tool of a run pinned to that provider, though the tool never names it', async () => {
      const { kind, version } = await providerOf();
      const { runId } = await runningRun(a, versionA, { id: profileId, version });
      const context = await agentContextFor(a, runId);
      await assertRunning(agent.db, context, {});
      await engageOperatorSwitch(urls.migrator(), {
        scope: 'provider',
        providerKind: kind,
        reasonCode: 'INCIDENT',
      });
      await expect(assertRunning(agent.db, context, {})).rejects.toEqual(halted);
    });

    it('leaves a run on another provider alone', async () => {
      const { kind, version } = await providerOf();
      const other = PROVIDER_KINDS.find((each) => each !== kind);
      if (!other) throw new Error('Only one provider kind');
      const { runId } = await runningRun(a, versionA, { id: profileId, version });
      await engageOperatorSwitch(urls.migrator(), {
        scope: 'provider',
        providerKind: other,
        reasonCode: 'INCIDENT',
      });
      await assertRunning(agent.db, await agentContextFor(a, runId), {});
    });
  });

  it('holds across a capital letter, because the trigger compares the version as text', async () => {
    const { action } = await agentProposedAction(a, versionA);
    await engageKillSwitch(app.db, a.owner, {
      scope: 'agent_version',
      target_ref: versionA.versionId.toUpperCase(),
      reason_code: 'INCIDENT',
    });
    await expect(firstAttempt(a, action)).rejects.toEqual(sqlState('EN007'));
  });

  it('lifts: the next check passes once it is released', async () => {
    const { runId } = await runningRun(a, versionA);
    const context = await agentContextFor(a, runId);
    const { switchId } = await engageKillSwitch(app.db, a.owner, {
      scope: 'organization',
      target_ref: null,
      reason_code: 'INCIDENT',
    });
    await expect(assertRunning(agent.db, context, {})).rejects.toEqual(halted);
    await releaseKillSwitch(app.db, a.owner, { switchId });
    await assertRunning(agent.db, context, {});
  });

  it('aborts a call in flight within the measured limit, on the agent role', async () => {
    const pollMs = 100;
    const watcher = createHaltWatcher({ pollMs, read: switchReaderFor(agent.db) });
    watcher.start();
    try {
      const signal = watcher.signalFor({
        organizationId: a.organizationId,
        agentVersionId: versionA.versionId,
      });
      // Long enough for clear reads, so an abort below can only be the switch's doing.
      await new Promise((resolve) => setTimeout(resolve, pollMs * 3));
      expect(signal.aborted).toBe(false);

      await engageKillSwitch(app.db, a.owner, {
        scope: 'organization',
        target_ref: null,
        reason_code: 'INCIDENT',
      });
      const committedAt = performance.now();
      const abortedAt = await new Promise<number>((resolve) => {
        signal.addEventListener('abort', () => resolve(performance.now()));
      });
      expect(abortedAt - committedAt).toBeLessThanOrEqual(watcher.abortLimitMs);
      expect(signal.reason).toEqual(halted);
    } finally {
      await watcher.stop();
    }
  });

  describe('unreadable state', () => {
    it('counts as halted when the role cannot read the table at all', async () => {
      // The dispatcher's role has no grant on the switches, which is a real read failure.
      const dispatcher = openAppDatabase(urls.dispatcher(), { max: 1 });
      try {
        await expect(
          withRunLookupTx(dispatcher.db, a.organizationId, (tx) =>
            check.assertRunning(tx, a.owner, {}),
          ),
        ).rejects.toEqual(halted);
      } finally {
        await dispatcher.close();
      }
    });

    it('counts as halted when the database is gone', async () => {
      const gone = openAppDatabase(urls.app(), { max: 1 });
      await gone.close();
      const watcher = createHaltWatcher({ pollMs: 50, read: switchReaderFor(gone.db) });
      watcher.start();
      try {
        const signal = watcher.signalFor({
          organizationId: a.organizationId,
          agentVersionId: versionA.versionId,
        });
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve);
        });
        expect(signal.reason).toEqual(halted);
      } finally {
        await watcher.stop();
      }
    });

    it('counts as halted when no tenant is bound, where RLS would otherwise hide this tenant', async () => {
      await engageKillSwitch(app.db, a.owner, {
        scope: 'organization',
        target_ref: null,
        reason_code: 'INCIDENT',
      });
      await expect(app.db.run((tx) => check.assertRunning(tx, a.owner, {}))).rejects.toEqual(
        halted,
      );
    });

    it("counts as halted when another tenant's transaction is passed in", async () => {
      await expect(
        withTenantTx(app.db, b.owner, (tx) => check.assertRunning(tx, a.owner, {})),
      ).rejects.toEqual(halted);
    });

    it('counts as halted for a run that does not exist', async () => {
      const context = await agentContextFor(a, randomUUID());
      await expect(assertRunning(agent.db, context, {})).rejects.toEqual(halted);
    });
  });

  describe('who can touch a switch', () => {
    const stopAll = {
      scope: 'organization',
      target_ref: null,
      reason_code: 'INCIDENT',
    } as const;

    it('refuses a member to engage, release or list', async () => {
      const { switchId } = await engageKillSwitch(app.db, a.owner, stopAll);
      await expect(engageKillSwitch(app.db, a.member, stopAll)).rejects.toEqual(
        refusedWith('FORBIDDEN'),
      );
      await expect(releaseKillSwitch(app.db, a.member, { switchId })).rejects.toEqual(
        refusedWith('FORBIDDEN'),
      );
      await expect(listKillSwitches(app.db, a.member)).rejects.toEqual(refusedWith('FORBIDDEN'));
      await expect(assertRunning(app.db, a.owner, {})).rejects.toEqual(halted);
    });

    it('refuses an agent working for an owner, so a model cannot lift a stop on itself', async () => {
      const { runId } = await runningRun(a, versionA);
      const context = await agentContextFor(a, runId);
      expect(context.role).toBe('owner');
      await expect(engageKillSwitch(agent.db, context, stopAll)).rejects.toEqual(
        refusedWith('FORBIDDEN'),
      );
      const { switchId } = await engageKillSwitch(app.db, a.owner, stopAll);
      await expect(releaseKillSwitch(agent.db, context, { switchId })).rejects.toEqual(
        refusedWith('FORBIDDEN'),
      );
    });

    it('refuses a tenant engaging a global or provider stop, through the service and through SQL', async () => {
      for (const scope of ['global', 'provider']) {
        await expect(
          engageKillSwitch(app.db, a.owner, {
            scope,
            target_ref: null,
            reason_code: 'INCIDENT',
          } as never),
        ).rejects.toEqual(refusedWith('FORBIDDEN'));
      }
      await expect(
        withTenantTx(app.db, a.owner, (tx) =>
          tx.insert(killSwitches).values({ scope: 'global', reasonCode: 'INCIDENT' }),
        ),
      ).rejects.toThrow();
    });

    it('refuses a tenant releasing a global row, keeps it engaged, and leaves a record', async () => {
      const switchId = await engageOperatorSwitch(urls.migrator(), {
        scope: 'global',
        reasonCode: 'INCIDENT',
      });
      await expect(releaseKillSwitch(app.db, a.owner, { switchId })).rejects.toEqual(
        refusedWith('KILL_SWITCH_NOT_YOURS'),
      );
      // And straight at the table: RLS finds no row this role may change.
      const changed = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .update(killSwitches)
          .set({ releasedAt: new Date() })
          .where(eq(killSwitches.id, switchId))
          .returning({ id: killSwitches.id }),
      );
      expect(changed).toEqual([]);
      await expect(assertRunning(app.db, a.owner, {})).rejects.toEqual(halted);

      const records = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.targetRef, `kill_switch:${switchId}`)),
      );
      expect(records).toEqual([
        expect.objectContaining({
          action: 'kill_switch.release',
          decision: 'deny',
          safeReason: 'KILL_SWITCH_NOT_YOURS',
          actorId: a.owner.membershipId,
        }),
      ]);
    });

    it('refuses a version from another tenant, under the same name', async () => {
      const theirs = await seedAgentVersion(app.db, b.owner);
      await expect(
        engageKillSwitch(app.db, a.owner, {
          scope: 'agent_version',
          target_ref: theirs.versionId,
          reason_code: 'INCIDENT',
        }),
      ).rejects.toEqual(refusedWith('INVALID_INPUT'));
    });

    it('cannot be deleted by anyone, so the record survives', async () => {
      const { switchId } = await engageKillSwitch(app.db, a.owner, stopAll);
      await expect(
        withTenantTx(app.db, a.owner, (tx) =>
          tx.delete(killSwitches).where(eq(killSwitches.id, switchId)),
        ),
      ).rejects.toThrow();
    });
  });

  describe('between tenants', () => {
    const stopAll = {
      scope: 'organization',
      target_ref: null,
      reason_code: 'INCIDENT',
    } as const;

    it("is not stopped by another tenant's switch", async () => {
      await engageKillSwitch(app.db, b.owner, stopAll);
      await assertRunning(app.db, a.owner, { agentVersionId: versionA.versionId });
      const { action } = await agentProposedAction(a, versionA);
      await firstAttempt(a, action);
    });

    it("cannot see another tenant's switch, by service or by SQL", async () => {
      const { switchId } = await engageKillSwitch(app.db, b.owner, stopAll);
      const listed = await listKillSwitches(app.db, a.owner);
      expect(listed.map((row) => row.id)).not.toContain(switchId);
      const rows = await withTenantTx(app.db, a.owner, readLiveSwitches);
      expect(rows.some((row) => row.organizationId === b.organizationId)).toBe(false);
    });

    it("cannot release another tenant's switch, and hears the same as for one that never was", async () => {
      const { switchId } = await engageKillSwitch(app.db, b.owner, stopAll);
      await expect(releaseKillSwitch(app.db, a.owner, { switchId })).rejects.toEqual(
        refusedWith('NOT_FOUND'),
      );
      await expect(releaseKillSwitch(app.db, a.owner, { switchId: randomUUID() })).rejects.toEqual(
        refusedWith('NOT_FOUND'),
      );
      await expect(assertRunning(app.db, b.owner, {})).rejects.toEqual(halted);
    });

    it("sees an operator's switch, marked as one", async () => {
      const switchId = await engageOperatorSwitch(urls.migrator(), {
        scope: 'global',
        reasonCode: 'INCIDENT',
      });
      for (const tenant of [a, b]) {
        const listed = await listKillSwitches(app.db, tenant.owner);
        expect(listed.find((row) => row.id === switchId)?.operator).toBe(true);
      }
    });
  });

  describe("the operator's command", () => {
    it('reaches only the database, prints the ID and nothing else, and stops every tenant', async () => {
      const connected: unknown[] = [];
      const originalConnect = net.Socket.prototype.connect;
      const socket = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
        this: net.Socket,
        ...args: unknown[]
      ) {
        connected.push(args[0]);
        return originalConnect.apply(this, args as never);
      });
      const noFetch = vi.spyOn(globalThis, 'fetch');
      const url = urls.migrator();
      const output: string[] = [];
      try {
        const command = parseHaltCommand(['engage', 'global', 'INCIDENT'], PROVIDER_KINDS);
        if (!command) throw new Error('Refused its own usage');
        await runHaltCommand(
          command,
          {
            engage: (input) => engageOperatorSwitch(url, input),
            release: (id) => releaseOperatorSwitch(url, id),
            list: () => listOperatorSwitches(url),
          },
          (text) => output.push(text),
        );
      } finally {
        socket.mockRestore();
      }
      expect(noFetch).not.toHaveBeenCalled();
      noFetch.mockRestore();
      const port = new URL(url).port;
      expect(connected.length).toBeGreaterThan(0);
      for (const target of connected) expect(String(target)).toBe(port);

      expect(output).toHaveLength(1);
      expect(output[0]).toMatch(/^[0-9a-f-]{36}\n$/);
      await expect(assertRunning(app.db, a.owner, {})).rejects.toEqual(halted);
      await expect(assertRunning(app.db, b.owner, {})).rejects.toEqual(halted);
    });

    it('is confined to rows with no tenant, so it cannot release or see a tenant switch', async () => {
      const { switchId } = await engageKillSwitch(app.db, a.owner, {
        scope: 'organization',
        target_ref: null,
        reason_code: 'INCIDENT',
      });
      const listed = await listOperatorSwitches(urls.migrator());
      expect(listed.map((row) => row.id)).not.toContain(switchId);
      await expect(releaseOperatorSwitch(urls.migrator(), switchId)).rejects.toBeInstanceOf(
        OperatorSwitchNotFound,
      );
      await expect(assertRunning(app.db, a.owner, {})).rejects.toEqual(halted);
    });

    it('releases, once, and a second release changes nothing', async () => {
      const switchId = await engageOperatorSwitch(urls.migrator(), {
        scope: 'global',
        reasonCode: 'INCIDENT',
      });
      await releaseOperatorSwitch(urls.migrator(), switchId);
      await releaseOperatorSwitch(urls.migrator(), switchId);
      await assertRunning(app.db, a.owner, {});
    });

    it('refuses a reason in free text, at the database too', async () => {
      await expect(
        engageOperatorSwitch(urls.migrator(), { scope: 'global', reasonCode: 'they said so' }),
      ).rejects.toThrow();
    });
  });

  describe('while halted', () => {
    it("leaves people's own work alone: reading it, listing it and starting more", async () => {
      const id = await newWork(a);
      await engageOperatorSwitch(urls.migrator(), { scope: 'global', reasonCode: 'INCIDENT' });
      await engageKillSwitch(app.db, a.owner, {
        scope: 'organization',
        target_ref: null,
        reason_code: 'INCIDENT',
      });
      expect((await getWorkUnit(app.db, a.owner, id)).id).toBe(id);
      expect((await listWorkUnits(app.db, a.owner)).items.map((item) => item.id)).toContain(id);
      await expect(newWork(a)).resolves.toEqual(expect.any(String));
    });
  });

  describe('the record', () => {
    it('holds who, what and a code, and nothing else, for engaging and for releasing', async () => {
      const { switchId } = await engageKillSwitch(app.db, a.owner, {
        scope: 'organization',
        target_ref: null,
        reason_code: 'SUSPECTED_INJECTION',
      });
      await releaseKillSwitch(app.db, a.owner, { switchId });
      // Pressing it twice leaves one release on the record.
      await releaseKillSwitch(app.db, a.owner, { switchId });

      const { audit, events } = await withTenantTx(app.db, a.owner, async (tx) => ({
        audit: await tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.targetRef, `kill_switch:${switchId}`)),
        events: await tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, switchId)),
      }));
      expect(audit.map((row) => [row.action, row.decision, row.safeReason])).toEqual([
        ['kill_switch.engaged', 'allow', 'SUSPECTED_INJECTION'],
        ['kill_switch.released', 'allow', null],
      ]);
      expect(events.map((row) => row.eventType).sort()).toEqual([
        'kill_switch.engaged',
        'kill_switch.released',
      ]);
      for (const row of events) {
        for (const value of Object.values(row.payload as Record<string, unknown>)) {
          expect(value === null || /^[A-Za-z0-9_-]+$/.test(String(value))).toBe(true);
        }
      }
    });
  });
});
