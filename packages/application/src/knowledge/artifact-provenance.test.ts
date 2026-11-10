// A generated file's inherited delegated influence, without PostgreSQL. What the inherited refs flatten
// into is tested in tests/integration/delegated-child-lifecycle.test.ts; here are the branch that
// decides whether a run inherits anything at all, the redaction filter of the receipts it reads, and
// the 0208 order that checks the trusted inventory's own structured list before any inherited ref is
// merged into it. The end-to-end refusal with zero object puts is
// tests/integration/knowledge-artifact-provenance.test.ts.
import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext, Tx } from '@ensemus/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  createArtifactProvenance,
  inheritedInfluenceInputs,
  inheritedInfluenceInTx,
  type ArtifactExecution,
  type ArtifactInputInventory,
  type InheritedInfluenceRef,
} from './artifact-provenance';

const dialect = new PgDialect();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const organizationId = randomUUID(),
  runId = randomUUID(),
  workUnitId = randomUUID(),
  membershipId = randomUUID();
const contextOf = (actorType: TenantContext['actorType']) =>
  ({
    organizationId,
    userId: randomUUID(),
    membershipId,
    role: 'member',
    actorType,
    ...(actorType === 'agent' ? { agentRunId: runId } : {}),
  }) as unknown as TenantContext;
const agentRun: ArtifactExecution = { kind: 'agent_run', id: runId };
const systemTemplate: ArtifactExecution = { kind: 'system', id: runId, template: 'checklist/v1' };
const ref = (value: Partial<InheritedInfluenceRef> = {}): InheritedInfluenceRef => ({
  kind: 'work_unit',
  id: randomUUID(),
  sha256: hash(randomUUID()),
  classification: 'internal',
  proofKind: 'actual_content',
  sourceId: null,
  ...value,
});
/** Only `execute` answers; any other database call is the point past the step under test. */
const reached = new Error('reached a later database read');
const fakeTx = (rows: InheritedInfluenceRef[] = []) => {
  const execute = vi.fn(async (_query: SQL) => ({ rows }));
  const tx = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'execute'
          ? execute
          : property === 'then'
            ? undefined
            : () => {
                throw reached;
              },
    },
  ) as unknown as Tx;
  return { tx, execute };
};
const empty = { records: [], artifacts: [], packageIds: [], sourceIds: [] };

describe('which runs inherit delegated influence', () => {
  it('a system template inherits nothing and never reads a receipt, whoever runs it', async () => {
    for (const actor of ['agent', 'service', 'delegated'] as const) {
      const { tx, execute } = fakeTx([ref()]);
      expect(await inheritedInfluenceInTx(tx, contextOf(actor), systemTemplate)).toEqual(empty);
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it('an agent_run written by a non-agent actor inherits nothing and never reads a receipt', async () => {
    for (const actor of ['service', 'delegated', 'user'] as const) {
      const { tx, execute } = fakeTx([ref()]);
      expect(await inheritedInfluenceInTx(tx, contextOf(actor), agentRun)).toEqual(empty);
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it('the agent session of an agent_run reads its receipts and flattens what they hold', async () => {
    const record = ref(),
      { tx, execute } = fakeTx([record]);
    expect(await inheritedInfluenceInTx(tx, contextOf('agent'), agentRun)).toEqual({
      ...empty,
      records: [
        {
          kind: 'work_unit',
          id: record.id,
          sha256: record.sha256,
          classification: 'internal',
        },
      ],
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it('the results of the empty branch are independent, so one caller cannot alter another', async () => {
    const { tx } = fakeTx();
    const first = await inheritedInfluenceInTx(tx, contextOf('service'), agentRun);
    first.records.push({ kind: 'work_unit', id: randomUUID(), sha256: hash('x') });
    expect(await inheritedInfluenceInTx(tx, contextOf('service'), agentRun)).toEqual(empty);
    expect(inheritedInfluenceInputs([])).toEqual(empty);
  });
});

describe('the inherited receipts read', () => {
  const query = async () => {
    const { tx, execute } = fakeTx();
    await inheritedInfluenceInTx(tx, contextOf('agent'), agentRun);
    return dialect.sqlToQuery(execute.mock.calls[0]![0]);
  };
  it('excludes a redacted receipt: redacted_at is null is a conjunct of the receipt filter', async () => {
    // 0419: ai.current_main_input_inventory folds only unredacted receipts into inherited_influence,
    // and a redacted receipt's refs are erased material. The filter is ANDed with the tenant and
    // run-inheritance terms, never an alternative to them.
    const { sql: text } = await query();
    const where = text.slice(text.indexOf('where'), text.indexOf('order by'));
    expect(where).toMatch(
      /^where receipt\.organization_id=\$1::uuid and receipt\.redacted_at is null\s+and receipt\.child_run_id in\(select ai\.run_inherited_receipt_ids\(\$2::uuid\)\)\s*$/,
    );
    expect(text).not.toMatch(/redacted_at is not null|\bor\b/i);
  });
  it('is bound to this tenant and this run, and bounded one past the input limit', async () => {
    const { sql: text, params } = await query();
    expect(params.slice(0, 2)).toEqual([organizationId, runId]);
    expect(params.at(-1)).toBe(1001);
    expect(text).toMatch(/limit \$3$/);
  });
  it('refuses a run id that is not an id before reading anything', async () => {
    const { tx, execute } = fakeTx();
    await expect(
      inheritedInfluenceInTx(tx, contextOf('agent'), { kind: 'agent_run', id: 'not-an-id' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('0208: the trusted structured list is checked on its own before inherited refs merge', () => {
  const targetRecord = {
    kind: 'work_unit' as const,
    id: workUnitId,
    sha256: hash('target'),
    classification: 'internal' as const,
  };
  const begin = (recordInputs: unknown, inheritedRows: InheritedInfluenceRef[]) => {
    const { tx, execute } = fakeTx(inheritedRows);
    const inventory = {
      inspectInTx: async () => ({
        known: true,
        execution: agentRun,
        workUnitId,
        viewerMembershipId: membershipId,
        classification: 'internal',
        noKnowledge: false,
        artifactInputs: [],
        recordInputs,
      }),
    } as unknown as ArtifactInputInventory;
    const started = createArtifactProvenance({ inventory }).beginInTx(tx, contextOf('agent'), {
      execution: agentRun,
      artifactId: randomUUID(),
      workUnitId,
      artifactSha256: hash('bytes'),
      sizeBytes: 5,
    });
    return { started, execute };
  };
  // The parent's read of the child's own Work would satisfy the target check if it were merged first.
  const inheritedTarget = ref({ id: workUnitId });

  it('refuses a missing, empty or unrelated list as INVALID_STATE, never a TypeError', async () => {
    for (const records of [
      undefined,
      null,
      'not-a-list',
      [],
      [{ kind: 'client', id: randomUUID(), sha256: hash('unrelated'), classification: 'internal' }],
    ]) {
      const { started, execute } = begin(records, [inheritedTarget]);
      await expect(started).rejects.toMatchObject({ code: 'INVALID_STATE' });
      // Refused before the inherited receipts are even read, so they cannot stand in for the list.
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it('a list that names the target Work goes on to merge the inherited refs', async () => {
    const { started, execute } = begin([targetRecord], [inheritedTarget, ref()]);
    // It passes the list checks and the merge, and stops only at the next database read.
    await expect(started).rejects.toBe(reached);
    expect(execute).toHaveBeenCalledOnce();
  });
  it('a malformed inherited ref is still refused after a valid list', async () => {
    const { started } = begin([targetRecord], [ref({ sha256: null })]);
    await expect(started).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});
