// Actual-role authoring and immutable request-time inputs. Authored until the joined SQL gate runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { memberships, openAppDatabase, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  createAgentDraft,
  getAgentDraft,
  listAgentDrafts,
  updateAgentDraft,
  archiveAgentDraft,
} from '@ensemus/application/agent-drafts';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import { makeTwoTenants, testAnswers } from '../helpers/product';
import { urls } from '../helpers/stack';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { disableMember } from '@ensemus/application';
import { databaseInTransaction } from '../../packages/application/src/transaction-database';

describe('Studio authoring uses real tenant and current person authority', () => {
  let app: ReturnType<typeof openAppDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app());
  });
  afterAll(async () => {
    await app?.close();
  });
  const ports = () => createRuntimeProductPorts(app.db);

  it('denies members and services before creating a draft', async () => {
    const { a } = await makeTwoTenants(app.db),
      answers = testAnswers(a.owner.context.membershipId);
    for (const context of [a.member.context, createServiceContext(a.organizationId)])
      await expect(
        createAgentDraft(app.db, context, ports(), { name: 'Generated denied draft', answers }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await listAgentDrafts(app.db, a.owner.context)).toEqual([]);
  });

  it('does not reveal a same-named draft to another company', async () => {
    const { a, b } = await makeTwoTenants(app.db),
      draft = await createAgentDraft(app.db, a.owner.context, ports(), {
        name: 'Generated shared name',
        answers: testAnswers(a.owner.context.membershipId),
      });
    await expect(getAgentDraft(app.db, b.owner.context, draft.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      updateAgentDraft(app.db, b.owner.context, ports(), {
        draftId: draft.id,
        expectedVersion: 1,
        name: 'Foreign update',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listAgentDrafts(app.db, b.owner.context)).toEqual([]);
  });

  it('rechecks the saved author role and the selected accountable owner', async () => {
    const { a, b } = await makeTwoTenants(app.db);
    await expect(
      createAgentDraft(app.db, a.owner.context, ports(), {
        name: 'Foreign accountable owner',
        answers: testAnswers(b.owner.context.membershipId),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const draft = await createAgentDraft(app.db, a.admin.context, ports(), {
      name: 'Generated current authority',
      answers: testAnswers(a.admin.context.membershipId),
    });
    await withTenantTx(app.db, a.owner.context, (tx) =>
      tx
        .update(memberships)
        .set({ role: 'member' })
        .where(eq(memberships.id, a.admin.context.membershipId)),
    );
    await expect(getAgentDraft(app.db, a.admin.context, draft.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      updateAgentDraft(app.db, a.admin.context, ports(), {
        draftId: draft.id,
        expectedVersion: 1,
        name: 'Stale author',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('saves a bounded draft, refuses stale edits and archives without deleting its history', async () => {
    const { a } = await makeTwoTenants(app.db),
      answers = testAnswers(a.owner.context.membershipId),
      draft = await createAgentDraft(app.db, a.owner.context, ports(), {
        name: 'Generated real draft',
        answers,
      });
    expect(draft.specSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(draft.status).toBe('editing');
    const changed = await updateAgentDraft(app.db, a.owner.context, ports(), {
      draftId: draft.id,
      expectedVersion: 1,
      answers: { ...answers, intendedOutcome: 'A changed brief with source citations.' },
    });
    expect(changed.version).toBe(2);
    expect(changed.specSha256).not.toBe(draft.specSha256);
    await expect(
      updateAgentDraft(app.db, a.owner.context, ports(), {
        draftId: draft.id,
        expectedVersion: 1,
        name: 'Stale',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await archiveAgentDraft(app.db, a.owner.context, { draftId: draft.id, expectedVersion: 2 });
    expect((await getAgentDraft(app.db, a.owner.context, draft.id)).status).toBe('archived');
    await expect(
      updateAgentDraft(app.db, a.owner.context, ports(), {
        draftId: draft.id,
        expectedVersion: 3,
        name: 'Revived',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('serializes before the author membership lock so a concurrent disable wins without a deadlock', async () => {
    const { a } = await makeTwoTenants(app.db),
      draft = await createAgentDraft(app.db, a.admin.context, ports(), {
        name: 'Generated author lock race',
        answers: testAnswers(a.admin.context.membershipId),
      }),
      observer = new pg.Client({ connectionString: urls.superuser() });
    await observer.connect();
    let editing: Promise<unknown> | undefined;
    try {
      await withTenantTx(app.db, a.owner.context, async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended('interactive_policy:'||${a.organizationId}::text,0))`,
        );
        const locked = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        editing = updateAgentDraft(app.db, a.admin.context, ports(), {
          draftId: draft.id,
          expectedVersion: 1,
          name: 'Denied after disable',
        }).then(
          () => null,
          (error) => error,
        );
        await expect
          .poll(
            async () => {
              const result = await observer.query<{ blocked: boolean }>(
                'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',
                [locked.rows[0]!.pid],
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 5000, interval: 20 },
          )
          .toBe(true);
        await disableMember(databaseInTransaction(tx), a.owner.context, {
          membershipId: a.admin.context.membershipId,
        });
      });
      expect(await editing).toMatchObject({ code: 'FORBIDDEN' });
      expect((await getAgentDraft(app.db, a.owner.context, draft.id)).name).toBe(
        'Generated author lock race',
      );
    } finally {
      await editing;
      await observer.end();
    }
  });
});
