// Owned by the process slice (AGENT-13). See docs/06-delivery/m7-slices.md and ADR-031 D7.
//
// A running step gets no shortcut. A step's Work Unit comes from `createWorkUnit`, an approval from
// `createApprovalInTx`, and an external action from M3's `proposeExternalActionInTx`, with its own approval
// and its own receipt, each acting as a real person and never as a service. All the worker does itself is
// hold the run's lock, ask the pure rules in `@ensemus/domain/process-run`, and write down what was made.
import { createHash, randomUUID } from 'node:crypto';
import {
  approvals,
  connections,
  externalActions,
  memberships,
  TenantAccessDenied,
  withTenantTx,
  workAssignments,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { createDelegatedContext } from '@ensemus/database/service';
import { processRuns, processRunSteps, processSpecs } from '@ensemus/database/product';
import { canonicalJson, type ProposedAction } from '@ensemus/domain/approval';
import {
  EMAIL_CONNECTOR_TYPE,
  EMAIL_SEND_TOOL,
  EMAIL_SEND_VERSION,
} from '@ensemus/domain/external-action';
import { canManageWork, type Classification } from '@ensemus/domain/policy';
import {
  agentStepOutcome,
  ancestorsOf,
  approvalStepOutcome,
  externalStepOutcome,
  nextProcessSteps,
  recheckRun,
  stopStatusFor,
  sumMeasuredCost,
  workStepOutcome,
  type MeasuredCost,
  type StepOutcome,
  type StepStatus,
} from '@ensemus/domain/process-run';
import {
  compileProcessGraph,
  PROCESS_LIMITS,
  type ProcessSpec,
  type ProcessStep,
} from '@ensemus/domain/process-spec';
import {
  AGGREGATE_PROCESS_RUN,
  NOTIFY_PROCESS_RUN_FINISHED,
  PROCESS_RUN_FINISHED,
  PROCESS_RUN_REQUESTED,
  PROCESS_RUN_STOP_REQUESTED,
  PROCESS_RUN_WAKE,
  processRunTargetRef,
} from '@ensemus/domain/product-events';
import { canProduct } from '@ensemus/domain/product-policy';
import type { WorkState } from '@ensemus/domain/work-unit';
import {
  BUNDLED_WORKFLOWS,
  FLAGSHIP_WORKFLOW,
  findBundledWorkflow,
  needStopCode,
  type BundledNeed,
  type BundledWorkflow,
} from '@ensemus/packs/bundled';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createApprovalInTx, REVIEW_HOURS } from '../approvals';
import { AppError } from '../errors';
import { databaseInTransaction } from '../transaction-database';
import { emit } from '../events';
import { proposeExternalActionInTx } from '../external-actions';
import { idSchema } from '../ids';
import { idFromRequest } from '../request-id';
import {
  applyTransition,
  assignContributor,
  auditAction,
  createWorkUnitInTx,
  failRun,
  loadReadable,
  memberCanRead,
  notify,
  visibleTo,
  type WorkRow,
} from '../work';
import type { ProductPorts } from './ports';
import { publishProcessSpecInTx } from './process-specs';
import { studioPerson, withStudioTx } from './studio-authority';
import { experiencePerson } from './experience-authority';
import {
  assertProcessInventory,
  withProcessBirth,
  processProof,
  processIntent,
  processApproval,
  processReceipt,
} from './process-run-authority';

export type ProcessRunView = {
  id: string;
  specId: string;
  processName: string;
  /** Current readable root Work title, separate from the immutable definition name. */
  title: string;
  rootWorkUnitId: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  stopCode: string | null;
  steps: readonly {
    key: string;
    label: string;
    /** What kind of step this is, so a page can say what it is waiting for. */
    kind: ProcessStep['kind'];
    after: readonly string[];
    /** Which tool, for an external action. */
    toolId: string | null;
    status: StepStatus;
    stopCode: string | null;
    workUnitId: string | null;
    approvalId: string | null;
    externalActionId: string | null;
    agentRunId: string | null;
  }[];
  /** From M4's ledger through a port. Null while unavailable, and labelled an estimate where it is one. */
  cost: { costMicros: number; isEstimate: boolean } | null;
  /** Whether this viewer answers for the root Work Unit, and so can stop this or write what it sends. */
  canManage: boolean;
  version: number;
  createdAt: Date;
  finishedAt: Date | null;
};

type RunRow = typeof processRuns.$inferSelect;
type SpecRow = typeof processSpecs.$inferSelect;
type StepRow = typeof processRunSteps.$inferSelect;

const PAGE_SIZE = 50;
const FINISHED = new Set(['completed', 'failed', 'cancelled']);
const STOP_REQUESTED = 'STOP_REQUESTED';
const STEP_APPROVAL_TOOL = 'process.step_approval';
const STEP_APPROVAL_VERSION = '1';

/** What can perform each tool. A tool with nothing here stops, since nothing can make its effect. */
const TOOL_CONNECTOR_TYPES: Readonly<Record<string, readonly string[]>> = {
  [EMAIL_SEND_TOOL]: [EMAIL_CONNECTOR_TYPE],
};

/**
 * What meets a catalog workflow's need. Accounting and meetings have no connector, so nothing can meet them,
 * and this is the place a connector gets named when one ships.
 */
const NEED_CONNECTOR_TYPES: Readonly<Record<BundledNeed, readonly string[]>> = {
  email_connector: [EMAIL_CONNECTOR_TYPE],
  accounting_connector: [],
  meeting_notes: [],
};

const sha256 = (canonical: string) => createHash('sha256').update(canonical).digest('hex');

/**
 * Lets a service that opens its own transaction run inside this one, as a savepoint, the way `runIdempotent`
 * joins a service to its key. It is what makes "the Work Unit and what points at it" one commit, and it needs
 * no second connection while the run's lock is held.
 */
const insideThisTransaction = databaseInTransaction;

type Attempt<T> = { ok: true; value: T } | { ok: false; code: string };

/**
 * Tries something a normal service may refuse. A refusal is a fact about this step, with a code, and it must
 * not undo the rest of the transaction. Anything else is a fault, so the Activity tries again.
 */
async function attempt<T>(tx: Tx, fn: (nested: Tx) => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await tx.transaction(fn) };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, code: error.code };
    throw error;
  }
}

/** An ID only this run and this step can arrive at, so a repeated step finds the Work Unit it made. */
const stepRequestKey = (runId: string, stepKey: string) =>
  idFromRequest('process_step', runId, runId, { stepKey });

const specOf = (row: SpecRow) => row.spec as ProcessSpec;

const whoReads = (row: Pick<SpecRow, 'classification' | 'publishedByMembershipId'>, me: string) =>
  row.classification !== 'restricted' || row.publishedByMembershipId === me;

/** The root has already been read by this viewer, so this asks only who answers for it. */
const answersFor = (root: WorkRow, context: TenantContext) =>
  canManageWork(
    {
      classification: root.classification as Classification,
      ownerMembershipId: root.ownerMembershipId,
      isAssigned: true,
    },
    { membershipId: context.membershipId, role: context.role },
  );

function viewOf(
  run: RunRow,
  spec: Pick<SpecRow, 'name' | 'spec'>,
  rows: readonly StepRow[],
  root: Pick<WorkRow, 'title'>,
  canManage: boolean,
  cost: ProcessRunView['cost'] = null,
): ProcessRunView {
  assertProcessInventory(spec.spec as ProcessSpec, rows);
  const byKey = new Map(rows.map((row) => [row.stepKey, row]));
  return {
    id: run.id,
    specId: run.specId,
    processName: spec.name,
    title: root.title,
    rootWorkUnitId: run.rootWorkUnitId,
    status: run.status as ProcessRunView['status'],
    stopCode: run.stopCode,
    steps: (spec.spec as ProcessSpec).steps.map((step) => {
      const row = byKey.get(step.key);
      if (!row) throw new AppError('CAPABILITY_UNAVAILABLE');
      return {
        key: step.key,
        label: step.label,
        kind: step.kind,
        after: step.after,
        toolId: step.toolId ?? null,
        status: row.status as StepStatus,
        stopCode: row?.stopCode ?? null,
        workUnitId: row?.workUnitId ?? null,
        approvalId: row?.approvalId ?? null,
        externalActionId: row?.externalActionId ?? null,
        agentRunId: row?.agentRunId ?? null,
      };
    }),
    cost,
    canManage,
    version: run.version,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  };
}

const startInput = z.strictObject({
  specId: idSchema,
  title: z.string().trim().min(1).max(200),
  dueAt: z.coerce.date().optional(),
  requestKey: idSchema.optional(),
});

/**
 * Needs `studio.publish` on a spec the starter can read. Makes the root Work Unit, the run and its steps, and
 * PROCESS_RUN_REQUESTED, in one transaction. Restricted specs may not hold an `external_action` step.
 */
export async function startProcessRun(
  database: AppDatabase,
  context: TenantContext,
  raw: { specId: string; title: string; dueAt?: Date; requestKey?: string },
): Promise<ProcessRunView> {
  if (!canProduct(context.role, 'studio.publish')) throw new AppError('FORBIDDEN');
  const parsed = startInput.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const input = parsed.data;
  return withStudioTx(database, context, async (tx) => {
    await studioPerson(tx, context, 'studio.publish');
    const native = await tx.execute<{ allowed: boolean }>(
      sql`select studio.author_allowed() as allowed`,
    );
    if (native.rows[0]?.allowed !== true) throw new AppError('FORBIDDEN');
    const [spec] = await tx.select().from(processSpecs).where(eq(processSpecs.id, input.specId));
    if (!spec || !whoReads(spec, context.membershipId)) throw new AppError('NOT_FOUND');
    const { steps } = specOf(spec);
    if (steps.length === 0) throw new AppError('GRAPH_INVALID');
    if (
      spec.classification === 'restricted' &&
      steps.some((step) => step.kind === 'external_action')
    ) {
      throw new AppError('RESTRICTED_NOT_ALLOWED');
    }

    const { requestKey, ...content } = input;
    const runId = requestKey
      ? idFromRequest('process_run', context.membershipId, requestKey, content)
      : randomUUID();
    // Serialize a key before the real Work INSERT. A retry must find its committed intent before
    // any birth trigger runs, even when its original Work is already finished.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`process_start:${context.organizationId}:${runId}`},0))`,
    );
    const [previous] = await tx.select().from(processRuns).where(eq(processRuns.id, runId));
    if (previous) {
      if (previous.specId !== spec.id || previous.startedByMembershipId !== context.membershipId)
        throw new AppError('VERSION_CONFLICT');
      await processIntent(tx, previous.id);
      const root = await loadReadable(tx, context, previous.rootWorkUnitId);
      return viewOf(previous, spec, await loadSteps(tx, runId), root, answersFor(root, context));
    }
    const root = await withProcessBirth(tx, { runId, specId: spec.id }, () =>
      createWorkUnitInTx(tx, context, {
        title: input.title,
        classification: spec.classification as Classification,
        ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        requestKey: runId,
      }),
    );
    const [run] = await tx
      .insert(processRuns)
      .values({
        organizationId: context.organizationId,
        id: runId,
        specId: spec.id,
        rootWorkUnitId: root.id,
        startedByMembershipId: context.membershipId,
      })
      .onConflictDoNothing()
      .returning();
    // The same form sent again, or racing itself. The first one's run is this one.
    if (!run) {
      const [existing] = await tx.select().from(processRuns).where(eq(processRuns.id, runId));
      if (!existing) throw new AppError('NOT_FOUND');
      return viewOf(existing, spec, await loadSteps(tx, runId), root, answersFor(root, context));
    }
    const rows = steps.length
      ? await tx
          .insert(processRunSteps)
          .values(
            steps.map((step) => ({
              organizationId: context.organizationId,
              runId,
              stepKey: step.key,
            })),
          )
          .returning()
      : [];
    await emit(tx, context, {
      eventType: PROCESS_RUN_REQUESTED,
      aggregateType: AGGREGATE_PROCESS_RUN,
      aggregateId: runId,
      aggregateVersion: run.version,
      classification: spec.classification,
      payload: { process_run_id: runId, spec_id: spec.id, work_unit_id: root.id },
    });
    await auditAction(tx, context, 'process_run.started', processRunTargetRef(runId));
    return viewOf(run, spec, rows, root, answersFor(root, context));
  });
}

/** Installs a catalog workflow as a spec this tenant can run, once per version. Needs `studio.publish`. */
export async function installBundledWorkflow(
  database: AppDatabase,
  context: TenantContext,
  input: { processKey: string },
): Promise<{ specId: string; versionNumber: number }> {
  if (!canProduct(context.role, 'studio.publish')) throw new AppError('FORBIDDEN');
  const workflow = findBundledWorkflow(input.processKey);
  if (!workflow) throw new AppError('NOT_FOUND');
  // Compiled like anything drawn, so it gets no way past the path rule. A catalog graph names its own tools,
  // and whether one can really run is the run's question: with no connection, that step stops with a code.
  const compiled = compileProcessGraph(
    workflow.graph,
    {
      classification: workflow.classification,
      agentDefinitionIds: new Set(),
      toolIds: new Set(workflow.graph.nodes.flatMap((node) => node.toolId ?? [])),
    },
    sha256,
  );
  if (!compiled.ok) throw new AppError('GRAPH_INVALID');
  const sourceRef = bundledRef(workflow);
  return withStudioTx(database, context, async (tx) => {
    await studioPerson(tx, context, 'studio.publish');
    const native = await tx.execute<{ allowed: boolean }>(
      sql`select studio.author_allowed() as allowed`,
    );
    if (native.rows[0]?.allowed !== true) throw new AppError('FORBIDDEN');
    // Two people pressing Install at once queue here, so "once per version" is not a race.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`bundled_install:${context.organizationId}:${workflow.key}`}, 0))`,
    );
    const [existing] = await tx
      .select({ specId: processSpecs.id, versionNumber: processSpecs.versionNumber })
      .from(processSpecs)
      .where(and(eq(processSpecs.processKey, workflow.key), eq(processSpecs.sourceRef, sourceRef)));
    if (existing) return existing;
    const published = await publishProcessSpecInTx(tx, context, {
      processKey: workflow.key,
      name: workflow.name,
      classification: workflow.classification,
      spec: compiled.spec,
      specSha256: compiled.specSha256,
      source: 'bundled',
      sourceRef,
    });
    await auditAction(tx, context, 'process_spec.installed', `process_spec:${published.specId}`);
    return published;
  });
}

const bundledRef = (workflow: Pick<BundledWorkflow, 'key' | 'version'>) =>
  `${workflow.key}@${workflow.version}`;

export type BundledCatalogEntry = {
  key: string;
  catalogNumber: number;
  name: string;
  description: string;
  classification: ProcessSpec['classification'];
  scenarioKey: string;
  needs: readonly { need: BundledNeed; met: boolean }[];
  installed: { specId: string; versionNumber: number } | null;
};

/** What the catalog page shows. Whether a need is met is read from real connections, each time. */
export async function listBundledCatalog(
  database: AppDatabase,
  context: TenantContext,
): Promise<{ flagship: typeof FLAGSHIP_WORKFLOW; items: readonly BundledCatalogEntry[] }> {
  if (!canProduct(context.role, 'studio.publish')) throw new AppError('FORBIDDEN');
  const refs = BUNDLED_WORKFLOWS.map(bundledRef);
  return withTenantTx(database, context, async (tx) => {
    const installed = await tx
      .select({
        ref: processSpecs.sourceRef,
        specId: processSpecs.id,
        versionNumber: processSpecs.versionNumber,
      })
      .from(processSpecs)
      .where(inArray(processSpecs.sourceRef, refs));
    const items: BundledCatalogEntry[] = [];
    for (const workflow of BUNDLED_WORKFLOWS) {
      const spec = installed.find((row) => row.ref === bundledRef(workflow));
      const needs = [];
      for (const need of workflow.needs) needs.push({ need, met: await needMet(tx, need) });
      items.push({
        key: workflow.key,
        catalogNumber: workflow.catalogNumber,
        name: workflow.name,
        description: workflow.description,
        classification: workflow.classification,
        scenarioKey: workflow.scenario.key,
        needs,
        installed: spec ? { specId: spec.specId, versionNumber: spec.versionNumber } : null,
      });
    }
    items.sort((a, b) => a.catalogNumber - b.catalogNumber);
    return { flagship: FLAGSHIP_WORKFLOW, items };
  });
}

/** The newest version of each spec this person may start, for the start form. */
export async function listStartableSpecs(
  database: AppDatabase,
  context: TenantContext,
): Promise<
  readonly {
    id: string;
    name: string;
    processKey: string;
    versionNumber: number;
    classification: string;
  }[]
> {
  if (!canProduct(context.role, 'studio.publish')) throw new AppError('FORBIDDEN');
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: processSpecs.id,
        name: processSpecs.name,
        processKey: processSpecs.processKey,
        versionNumber: processSpecs.versionNumber,
        classification: processSpecs.classification,
        publishedByMembershipId: processSpecs.publishedByMembershipId,
      })
      .from(processSpecs)
      .where(
        or(
          sql`${processSpecs.classification}<>'restricted'`,
          eq(processSpecs.publishedByMembershipId, context.membershipId),
        ),
      )
      .orderBy(asc(processSpecs.processKey), desc(processSpecs.versionNumber))
      .limit(500),
  );
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      if (seen.has(row.processKey)) return false;
      seen.add(row.processKey);
      return true;
    })
    .map(({ publishedByMembershipId: _unused, ...row }) => row);
}

// A timestamp exactly as PostgreSQL wrote it, and an ID. Anything else is a broken link.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

const encodeCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify([at, id])).toString('base64url');

function decodeCursor(cursor: string) {
  try {
    const [at, id] = z
      .tuple([z.string().regex(CURSOR_TIME), idSchema])
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { at, id };
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}

/** Only runs whose root this person may read, filtered in the query, so a page size is honest. */
export async function listProcessRuns(
  database: AppDatabase,
  context: TenantContext,
  input: { status?: ProcessRunView['status']; after?: string } = {},
): Promise<{ items: readonly ProcessRunView[]; next: string | null }> {
  const cursor = input.after ? decodeCursor(input.after) : null;
  return withTenantTx(database, context, async (tx) => {
    const rows = await tx
      .select({
        run: processRuns,
        name: processSpecs.name,
        spec: processSpecs.spec,
        root: workUnits,
        cursorAt: sql<string>`${processRuns.createdAt}::text`,
      })
      .from(processRuns)
      .innerJoin(workUnits, eq(workUnits.id, processRuns.rootWorkUnitId))
      .innerJoin(processSpecs, eq(processSpecs.id, processRuns.specId))
      .where(
        and(
          visibleTo(context),
          input.status ? eq(processRuns.status, input.status) : undefined,
          cursor
            ? or(
                sql`${processRuns.createdAt} < ${cursor.at}::timestamptz`,
                and(
                  sql`${processRuns.createdAt} = ${cursor.at}::timestamptz`,
                  lt(processRuns.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(processRuns.createdAt), desc(processRuns.id))
      .limit(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    for (const { run } of page) await processIntent(tx, run.id);
    const ids = page.map(({ run }) => run.id);
    const steps = ids.length
      ? await tx.select().from(processRunSteps).where(inArray(processRunSteps.runId, ids))
      : [];
    const last = page.at(-1);
    return {
      items: page.map(({ run, name, spec, root }) =>
        viewOf(
          run,
          { name, spec },
          steps.filter((step) => step.runId === run.id),
          root,
          answersFor(root, context),
        ),
      ),
      next: rows.length > PAGE_SIZE && last ? encodeCursor(last.cursorAt, last.run.id) : null,
    };
  });
}

const loadSteps = (tx: Tx, runId: string) =>
  tx.select().from(processRunSteps).where(eq(processRunSteps.runId, runId));

/** Not measured stays not measured: a port with nothing behind it is null, and never zero. */
async function measuredCost(
  context: TenantContext,
  ports: Pick<ProductPorts, 'usage'>,
  workUnitIds: readonly string[],
): Promise<MeasuredCost | null> {
  try {
    const costs = await Promise.all(
      workUnitIds.map((id) =>
        ports.usage.costForWorkUnit(context, id).catch((error: unknown) => {
          // A step's work this viewer cannot read has a cost they are not told.
          if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
          throw error;
        }),
      ),
    );
    return sumMeasuredCost(costs);
  } catch (error) {
    if (error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE') return null;
    throw error;
  }
}

/** Filtered by who can read the root Work Unit. Anyone else gets not found. */
export async function getProcessRun(
  database: AppDatabase,
  context: TenantContext,
  ports: Pick<ProductPorts, 'usage'>,
  runId: string,
): Promise<ProcessRunView> {
  const id = idSchema.safeParse(runId);
  if (!id.success) throw new AppError('NOT_FOUND');
  const view = await withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({ run: processRuns, name: processSpecs.name, spec: processSpecs.spec })
      .from(processRuns)
      .innerJoin(processSpecs, eq(processSpecs.id, processRuns.specId))
      .where(eq(processRuns.id, id.data));
    if (!row) throw new AppError('NOT_FOUND');
    const root = await loadReadable(tx, context, row.run.rootWorkUnitId);
    await processIntent(tx, row.run.id);
    return viewOf(row.run, row, await loadSteps(tx, id.data), root, answersFor(root, context));
  });
  const workUnitIds = [view.rootWorkUnitId, ...view.steps.flatMap((step) => step.workUnitId ?? [])];
  return { ...view, cost: await measuredCost(context, ports, workUnitIds) };
}

/** Needs `canManageWork` on the root. Commits the stop first, and the next step finds it in PostgreSQL. */
export async function requestStopProcessRun(
  database: AppDatabase,
  context: TenantContext,
  input: { runId: string; expectedVersion: number },
): Promise<void> {
  const id = idSchema.safeParse(input.runId);
  if (!id.success) throw new AppError('NOT_FOUND');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new AppError('INVALID_INPUT');
  await withStudioTx(database, context, async (tx) => {
    // No new MFA rule: a real current person who manages this root may stop it. Lock the
    // interactive policy and membership BEFORE the run/root, as deprovisioning does.
    const person = await experiencePerson(tx, context);
    const run = await lockRun(tx, id.data);
    const root = await loadReadable(tx, person, run.rootWorkUnitId);
    if (!answersFor(root, person)) throw new AppError('FORBIDDEN');
    if (run.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (FINISHED.has(run.status)) throw new AppError('INVALID_STATE');
    const version = run.version + 1;
    await tx
      .update(processRuns)
      .set({ stopCode: STOP_REQUESTED, version, updatedAt: new Date() })
      .where(eq(processRuns.id, run.id));
    await emit(tx, context, {
      eventType: PROCESS_RUN_STOP_REQUESTED,
      aggregateType: AGGREGATE_PROCESS_RUN,
      aggregateId: run.id,
      aggregateVersion: version,
      classification: root.classification,
      payload: { process_run_id: run.id },
    });
    await auditAction(tx, context, 'process_run.stop_requested', processRunTargetRef(run.id));
  });
}

async function lockRun(tx: Tx, runId: string): Promise<RunRow> {
  const [run] = await tx.select().from(processRuns).where(eq(processRuns.id, runId)).for('update');
  if (!run) throw new AppError('NOT_FOUND');
  return run;
}

const setStep = (
  tx: Tx,
  runId: string,
  stepKey: string,
  values: Partial<
    Pick<
      StepRow,
      | 'status'
      | 'stopCode'
      | 'workUnitId'
      | 'approvalId'
      | 'externalActionId'
      | 'agentRunId'
      | 'artifactId'
    >
  >,
) =>
  tx
    .update(processRunSteps)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(processRunSteps.runId, runId), eq(processRunSteps.stepKey, stepKey)));

async function needMet(tx: Tx, need: BundledNeed) {
  const types = NEED_CONNECTOR_TYPES[need];
  return types.length > 0 && (await hasActiveConnection(tx, types));
}

async function hasActiveConnection(tx: Tx, types: readonly string[]) {
  const [found] = await tx
    .select({ id: connections.id })
    .from(connections)
    .where(and(inArray(connections.connectorType, [...types]), eq(connections.state, 'active')))
    .limit(1);
  return Boolean(found);
}

/** Someone may be disabled at any moment. This reads them as they are now, under a shared lock. */
async function starterOf(tx: Tx, run: RunRow): Promise<TenantContext | null> {
  const [member] = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.id, run.startedByMembershipId))
    .for('share');
  if (!member) return null;
  try {
    return await createDelegatedContext(
      insideThisTransaction(tx),
      run.organizationId,
      run.startedByMembershipId,
    );
  } catch (error) {
    if (error instanceof TenantAccessDenied) return null;
    throw error;
  }
}

type Gate = { code: string; starter: null } | { code: null; starter: TenantContext };

/**
 * What has to hold just before each effect, read fresh under the run's lock, so a stop committed or a person
 * disabled a moment ago is seen here and nothing more is made.
 */
async function recheck(tx: Tx, run: RunRow, spec: SpecRow): Promise<Gate> {
  const [root] = await tx
    .select({ status: workUnits.status, classification: workUnits.classification })
    .from(workUnits)
    .where(eq(workUnits.id, run.rootWorkUnitId))
    .for('share');
  if (root && root.classification !== spec.classification)
    return { code: 'WORK_CHANGED', starter: null };
  const starter = await starterOf(tx, run);
  const code = recheckRun({
    stopRequested: run.stopCode === STOP_REQUESTED,
    rootStatus: root?.status ?? 'cancelled',
    specHashStored: spec.specSha256,
    specHashNow: sha256(canonicalJson(spec.spec)),
    starterActive: starter !== null,
  });
  return code === null && starter
    ? { code: null, starter }
    : { code: code ?? 'STARTER_INACTIVE', starter: null };
}

const WAY_TO_DONE: Partial<Record<WorkState, WorkState>> = {
  queued: 'ready',
  blocked: 'ready',
  ready: 'running',
  awaiting_approval: 'running',
  running: 'verifying',
  verifying: 'completed',
};

/**
 * Walks a Work Unit to done by the normal rules, as the starter. Its owner may have moved on, so the last
 * step can be refused, and then it stops at Checking for its owner to confirm. A process does not get to
 * say a person's work is finished on their behalf.
 */
async function closeWork(tx: Tx, starter: TenantContext, workUnitId: string) {
  const [first] = await tx
    .select()
    .from(workUnits)
    .where(eq(workUnits.id, workUnitId))
    .for('update');
  let work = first;
  while (work) {
    const next = WAY_TO_DONE[work.status as WorkState];
    if (!next) return;
    const current: WorkRow = work;
    const moved = await attempt(tx, (nested) => applyTransition(nested, starter, current, next));
    if (!moved.ok) return;
    work = moved.value;
  }
}

/**
 * Who is asked. Never the person asking, and never someone who could not read it, because being asked is not
 * an access grant. Nobody in this product records a manager, so `starter_manager` finds no one and says so.
 */
async function findApprover(
  tx: Tx,
  context: { starter: TenantContext; asking: string },
  run: RunRow,
  spec: SpecRow,
  step: ProcessStep,
  work: WorkRow,
): Promise<string | null> {
  const role = step.approverRole ?? 'process_owner';
  const candidates: string[] = [];
  if (role === 'named_reviewer') {
    const named = await tx
      .select({ id: workAssignments.membershipId })
      .from(workAssignments)
      .where(
        and(
          eq(workAssignments.workUnitId, run.rootWorkUnitId),
          eq(workAssignments.responsibility, 'reviewer'),
        ),
      )
      .orderBy(asc(workAssignments.membershipId));
    candidates.push(...named.map(({ id }) => id));
  } else if (role === 'process_owner') {
    candidates.push(spec.publishedByMembershipId);
    const answerable = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(inArray(memberships.role, ['owner', 'admin']), eq(memberships.status, 'active')))
      .orderBy(asc(memberships.role), asc(memberships.id))
      .limit(50);
    candidates.push(...answerable.map(({ id }) => id));
  }
  for (const id of candidates) {
    if (id === context.asking) continue;
    const [member] = await tx
      .select({ id: memberships.id, role: memberships.role, status: memberships.status })
      .from(memberships)
      .where(eq(memberships.id, id));
    if (member?.status !== 'active') continue;
    // A named reviewer is already on the run, so being on the step's own work follows from that.
    if (role === 'named_reviewer') {
      await assignContributor(insideThisTransaction(tx), context.starter, {
        id: work.id,
        membershipId: id,
        responsibility: 'reviewer',
      });
    }
    if (await memberCanRead(tx, work, { membershipId: member.id, role: member.role })) return id;
  }
  return null;
}

type RoundState = {
  run: RunRow;
  spec: SpecRow;
  process: ProcessSpec;
  rows: Map<string, StepRow>;
  starter: TenantContext;
};

/** Moves one step into being. Answers whether anything changed, so the round knows to look again. */
async function startStep(tx: Tx, state: RoundState, step: ProcessStep): Promise<boolean> {
  const { run, spec, rows, starter } = state;
  const row = rows.get(step.key);
  if (!row) throw new AppError('INVALID_STATE');
  const update = async (values: Parameters<typeof setStep>[3]) => {
    await setStep(tx, run.id, step.key, values);
    rows.set(step.key, { ...row, ...values });
  };
  const fail = (stopCode: string) => update({ status: 'failed', stopCode });

  // A catalog step whose need nobody has met stops here with a code. Only ever stricter than a drawn graph.
  if (spec.source === 'bundled') {
    const need = findBundledWorkflow(spec.processKey)?.stepNeeds[step.key];
    if (need && !(await needMet(tx, need))) {
      await fail(needStopCode(need));
      return true;
    }
  }
  if (step.kind === 'external_action') {
    if (spec.classification === 'restricted') {
      await fail('RESTRICTED_EFFECT');
      return true;
    }
    const types = TOOL_CONNECTOR_TYPES[step.toolId ?? ''] ?? [];
    if (types.length === 0 || !(await hasActiveConnection(tx, types))) {
      await fail('TOOL_NOT_CONNECTED');
      return true;
    }
  }

  // The Work Unit comes first, and is written down in the same commit, so a repeat finds it.
  let workUnitId = row.workUnitId;
  if (!workUnitId) {
    const made = await attempt(tx, (nested) =>
      withTenantTx(insideThisTransaction(nested), starter, (bound) =>
        withProcessBirth(bound, { runId: run.id, stepKey: step.key }, () =>
          createWorkUnitInTx(
            bound,
            starter,
            {
              title: step.label,
              classification: spec.classification as Classification,
              requestKey: stepRequestKey(run.id, step.key),
            },
            { parentId: run.rootWorkUnitId },
          ),
        ),
      ),
    );
    if (!made.ok) {
      await fail(made.code);
      return true;
    }
    workUnitId = made.value.id;
    await update({ workUnitId });
  }

  const current = rows.get(step.key) as StepRow;
  switch (step.kind) {
    case 'work_item':
    case 'evidence_check':
      await setStep(tx, run.id, step.key, { status: 'waiting' });
      rows.set(step.key, { ...current, status: 'waiting' });
      return true;
    case 'agent_task':
      // Port calls commit in M4's own transaction, so they happen after this one.
      if (current.status === 'ready') return false;
      await setStep(tx, run.id, step.key, { status: 'ready' });
      rows.set(step.key, { ...current, status: 'ready' });
      return true;
    case 'external_action':
      // What it sends is a person's words, and a spec holds none. Someone writes them on the run's page,
      // and that goes through M3 with its own approval. Nothing here sends anything.
      await setStep(tx, run.id, step.key, { status: 'waiting', stopCode: 'DETAILS_NEEDED' });
      rows.set(step.key, { ...current, status: 'waiting', stopCode: 'DETAILS_NEEDED' });
      return true;
    case 'human_approval':
      return askApproval(tx, state, step, workUnitId);
  }
}

async function askApproval(
  tx: Tx,
  state: RoundState,
  step: ProcessStep,
  workUnitId: string,
): Promise<boolean> {
  const { run, spec, rows, starter } = state;
  const row = rows.get(step.key) as StepRow;
  const [work] = await tx.select().from(workUnits).where(eq(workUnits.id, workUnitId));
  if (!work) throw new AppError('NOT_FOUND');
  const found = await attempt(tx, (nested) =>
    withTenantTx(insideThisTransaction(nested), starter, (bound) =>
      findApprover(bound, { starter, asking: starter.membershipId }, run, spec, step, work),
    ),
  );
  if (!found.ok) {
    await setStep(tx, run.id, step.key, { status: 'failed', stopCode: found.code });
    rows.set(step.key, { ...row, status: 'failed', stopCode: found.code });
    return true;
  }
  if (!found.value) {
    // A reviewer can still be named on the root, so that one goes on looking. Nobody else will appear.
    if (step.approverRole === 'named_reviewer') {
      if (row.status === 'ready' && row.stopCode === 'REVIEWER_NEEDED') return false;
      await setStep(tx, run.id, step.key, { status: 'ready', stopCode: 'REVIEWER_NEEDED' });
      rows.set(step.key, { ...row, status: 'ready', stopCode: 'REVIEWER_NEEDED' });
      return true;
    }
    await setStep(tx, run.id, step.key, { status: 'failed', stopCode: 'APPROVER_UNAVAILABLE' });
    rows.set(step.key, { ...row, status: 'failed', stopCode: 'APPROVER_UNAVAILABLE' });
    return true;
  }
  // Binds the run, the step and the exact spec, so it cannot be read as approval of anything else.
  const action: ProposedAction = {
    toolName: STEP_APPROVAL_TOOL,
    toolVersion: STEP_APPROVAL_VERSION,
    targetRef: processRunTargetRef(run.id),
    payload: { process_run_id: run.id, step_key: step.key, spec_sha256: spec.specSha256 },
  };
  const asked = await attempt(tx, (nested) =>
    withTenantTx(insideThisTransaction(nested), starter, (bound) =>
      createApprovalInTx(bound, starter, {
        workUnitId,
        action,
        approverMembershipId: found.value as string,
        expiresAt: new Date(Date.now() + REVIEW_HOURS * 60 * 60 * 1000),
        requestedByMembershipId: starter.membershipId,
      }),
    ),
  );
  const values = asked.ok
    ? { status: 'waiting', stopCode: null, approvalId: asked.value.id }
    : { status: 'failed', stopCode: asked.code };
  await setStep(tx, run.id, step.key, values);
  rows.set(step.key, { ...row, ...values });
  return true;
}

/** What evidence says about a check. Finding it writes down which record it was. */
async function settleEvidence(
  tx: Tx,
  state: RoundState,
  step: ProcessStep,
  row: StepRow,
): Promise<Parameters<typeof setStep>[3]> {
  const { run, process, rows } = state;
  const before = [...ancestorsOf(process, step.key)]
    .map((key) => ({
      row: rows.get(key),
      step: process.steps.find((candidate) => candidate.key === key),
    }))
    .filter((entry): entry is { row: StepRow; step: ProcessStep } =>
      Boolean(entry.row && entry.step),
    );
  const missing = { status: 'waiting', stopCode: 'EVIDENCE_MISSING' };
  switch (step.evidence) {
    case 'artifact_attached': {
      const scope = [
        run.rootWorkUnitId,
        ...(row.workUnitId ? [row.workUnitId] : []),
        ...before.flatMap((entry) => entry.row.workUnitId ?? []),
      ];
      // Use retained metadata, not a serving bypass. Generated rows may correctly be hidden from
      // the service's raw artifact SELECT; this fixed predicate checks the actual named starter,
      // current sources/input records and exact human acceptance before selecting one candidate.
      const found = await tx.execute<{ id: string }>(sql`select a.artifact_id as id
        from knowledge.artifact_acl_catalog a join knowledge.artifact_work_links wa
          on wa.organization_id=a.organization_id and wa.artifact_id=a.artifact_id
        where a.organization_id=app.current_organization_id() and a.alive
          and wa.work_unit_id in (${sql.join(
            scope.map((id) => sql`${id}::uuid`),
            sql`,`,
          )})
          and studio.process_artifact_valid(a.artifact_id,wa.work_unit_id,${run.startedByMembershipId}::uuid)
        order by a.artifact_id limit 1`);
      const file = found.rows[0];
      return file ? { status: 'done', stopCode: null, artifactId: file.id } : missing;
    }
    case 'reviewer_approved': {
      const approved = before.find(
        (entry) =>
          entry.step.kind === 'human_approval' &&
          entry.row.status === 'done' &&
          entry.row.approvalId,
      );
      return approved?.row.approvalId && (await processProof(tx, run.id, approved.row.stepKey))
        ? { status: 'done', stopCode: null, approvalId: approved.row.approvalId }
        : missing;
    }
    case 'external_receipt': {
      for (const entry of before) {
        if (entry.step.kind !== 'external_action' || !entry.row.workUnitId) continue;
        if (!entry.row.externalActionId) continue;
        if (await processReceipt(tx, entry.row.externalActionId, entry.row.workUnitId)) {
          return { status: 'done', stopCode: null, externalActionId: entry.row.externalActionId };
        }
      }
      return missing;
    }
    default:
      return missing;
  }
}

/** Reads what a waiting step made, and says what that means now. An agent's run is read through its port. */
async function settleWaiting(tx: Tx, state: RoundState): Promise<boolean> {
  const { run, process, rows, starter } = state;
  let moved = false;
  for (const step of process.steps) {
    const row = rows.get(step.key);
    if (!row || row.status !== 'waiting' || step.kind === 'agent_task') continue;
    let values: Parameters<typeof setStep>[3];
    if (step.kind === 'evidence_check') {
      values = await settleEvidence(tx, state, step, row);
    } else {
      values = await outcomeOfRecord(tx, run, step, row);
    }
    if (values.status === 'done' && row.workUnitId) {
      if (step.kind !== 'work_item') await closeWork(tx, starter, row.workUnitId);
      const [work] = await tx
        .select({ status: workUnits.status })
        .from(workUnits)
        .where(eq(workUnits.id, row.workUnitId));
      if (work?.status !== 'completed')
        values = { ...values, status: 'waiting', stopCode: 'WORK_CONFIRMATION_REQUIRED' };
    }
    if (Object.entries(values).every(([key, value]) => row[key as keyof StepRow] === value))
      continue;
    await setStep(tx, run.id, step.key, values);
    rows.set(step.key, { ...row, ...values });
    moved = true;
  }
  return moved;
}

async function outcomeOfRecord(
  tx: Tx,
  run: RunRow,
  step: ProcessStep,
  row: StepRow,
): Promise<StepOutcome> {
  if (step.kind === 'work_item' && row.workUnitId) {
    const [work] = await tx
      .select({ status: workUnits.status })
      .from(workUnits)
      .where(eq(workUnits.id, row.workUnitId));
    return workStepOutcome(work?.status ?? 'cancelled');
  }
  if (step.kind === 'human_approval' && row.approvalId) {
    const [approval] = await tx
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, row.approvalId));
    if (
      approval?.status === 'approved' &&
      !(await processApproval(tx, run.id, step.key, row.approvalId))
    )
      return { status: 'waiting', stopCode: 'APPROVAL_PROOF_MISSING' };
    return approvalStepOutcome(approval?.status ?? 'cancelled');
  }
  if (step.kind === 'external_action') {
    if (!row.externalActionId) return { status: 'waiting', stopCode: 'DETAILS_NEEDED' };
    const [action] = await tx
      .select({ status: externalActions.status })
      .from(externalActions)
      .where(eq(externalActions.id, row.externalActionId));
    if (
      action?.status === 'sent' &&
      !(await processReceipt(
        tx,
        row.externalActionId,
        row.workUnitId ?? '00000000-0000-0000-0000-000000000000',
      ))
    )
      return { status: 'waiting', stopCode: 'RECEIPT_PROOF_MISSING' };
    return externalStepOutcome(action?.status ?? 'cancelled');
  }
  return { status: 'waiting', stopCode: row.stopCode };
}

type Finished = { status: 'completed' | 'failed' | 'cancelled'; agentRunIds: readonly string[] };

/**
 * Ends a run in the caller's transaction: marks what is left as skipped, and never as done, stops the work
 * those steps made, and moves the root to match. Text a person wrote is in none of what this emits.
 */
async function finishInTx(
  tx: Tx,
  context: TenantContext,
  run: RunRow,
  spec: Pick<SpecRow, 'classification'>,
  status: 'completed' | 'failed' | 'cancelled',
  code: string | null,
  starter: TenantContext | null,
): Promise<Finished> {
  const rows = await loadSteps(tx, run.id);
  const left = rows.filter((row) => ['pending', 'ready', 'waiting'].includes(row.status));
  const agentRunIds = left.flatMap((row) => row.agentRunId ?? []);
  const stopped = code ?? 'RUN_FINISHED';
  for (const row of left) {
    await setStep(tx, run.id, row.stepKey, { status: 'skipped', stopCode: stopped });
    if (row.workUnitId) await stopWork(tx, context, row.workUnitId);
  }
  // A step that failed made work too, and nothing is coming back to it now.
  for (const row of rows) {
    if (row.status === 'failed' && row.workUnitId) await stopWork(tx, context, row.workUnitId);
  }

  const [root] = await tx
    .select()
    .from(workUnits)
    .where(eq(workUnits.id, run.rootWorkUnitId))
    .for('update');
  if (root) {
    if (status === 'completed' && starter) await closeWork(tx, starter, root.id);
    if (status === 'cancelled') await stopWork(tx, context, root.id);
    if (status === 'failed') {
      await attempt(tx, async (nested) => {
        const ready =
          root.status === 'queued' ? await applyTransition(nested, context, root, 'ready') : root;
        return failRun(nested, context, ready);
      });
    }
  }

  const version = run.version + 1;
  await tx
    .update(processRuns)
    .set({ status, stopCode: code, version, updatedAt: new Date(), finishedAt: new Date() })
    .where(eq(processRuns.id, run.id));
  await emit(tx, context, {
    eventType: PROCESS_RUN_FINISHED,
    aggregateType: AGGREGATE_PROCESS_RUN,
    aggregateId: run.id,
    aggregateVersion: version,
    classification: spec.classification,
    payload: { process_run_id: run.id, status, stop_code: code },
  });
  await auditAction(
    tx,
    context,
    'process_run.finished',
    processRunTargetRef(run.id),
    code ?? status.toUpperCase(),
  );
  await notify(
    tx,
    context,
    [run.startedByMembershipId, root?.ownerMembershipId],
    NOTIFY_PROCESS_RUN_FINISHED,
    processRunTargetRef(run.id),
  );
  return { status, agentRunIds };
}

/** Stops a Work Unit if it can still be stopped. Work at Checking stays for its owner to decide on. */
async function stopWork(tx: Tx, context: TenantContext, workUnitId: string) {
  const [work] = await tx
    .select()
    .from(workUnits)
    .where(eq(workUnits.id, workUnitId))
    .for('update');
  if (!work) return;
  await attempt(tx, (nested) => applyTransition(nested, context, work, 'cancelled'));
}

type AgentWork = {
  stepKey: string;
  workUnitId: string;
  agentDefinitionId: string | null;
  agentRunId: string | null;
  status: string;
};

type Round =
  | { finished: Finished; starter: TenantContext | null }
  | { finished: null; moved: boolean; agents: readonly AgentWork[] };

/** One pass under the run's lock. Everything in it commits together, or not at all. */
async function lockedRound(
  tx: Tx,
  context: TenantContext,
  input: { runId: string; temporalRunId: string },
): Promise<Round> {
  const run = await lockRun(tx, input.runId);
  await processIntent(tx, run.id);
  if (FINISHED.has(run.status)) {
    return {
      finished: { status: run.status as Finished['status'], agentRunIds: [] },
      starter: null,
    };
  }
  const [spec] = await tx.select().from(processSpecs).where(eq(processSpecs.id, run.specId));
  if (!spec) throw new AppError('NOT_FOUND');

  const end = async (
    status: Finished['status'],
    code: string | null,
    starter: TenantContext | null,
  ) => ({
    finished: await finishInTx(tx, context, run, spec, status, code, starter),
    starter,
  });

  const gate = await recheck(tx, run, spec);
  if (gate.code !== null) {
    return end(stopStatusFor(gate.code), gate.code, await starterOf(tx, run));
  }

  if (run.status === 'queued' || run.temporalRunId !== input.temporalRunId) {
    await tx
      .update(processRuns)
      .set({ status: 'running', temporalRunId: input.temporalRunId, updatedAt: new Date() })
      .where(eq(processRuns.id, run.id));
  }
  await moveRootToRunning(tx, context, run);

  const process = specOf(spec);
  const stored = await loadSteps(tx, run.id);
  assertProcessInventory(process, stored);
  // A previously satisfied step may have lost its approval, receipt, file, or live Work proof.
  // Never use its historical status to authorize a new dependent effect.
  for (const row of stored) {
    if (row.status === 'done' && !(await processProof(tx, run.id, row.stepKey)))
      return end('failed', 'STEP_PROOF_CHANGED', gate.starter);
  }
  const state: RoundState = {
    run,
    spec,
    process,
    rows: new Map(stored.map((row) => [row.stepKey, row])),
    starter: gate.starter,
  };

  let moved = await settleWaiting(tx, state);
  const statuses = () =>
    Object.fromEntries([...state.rows].map(([key, row]) => [key, row.status as StepStatus]));

  const decision = nextProcessSteps(process, statuses());
  if (decision.next === 'completed') {
    await closeWork(tx, gate.starter, run.rootWorkUnitId);
    const [root] = await tx
      .select({ status: workUnits.status })
      .from(workUnits)
      .where(eq(workUnits.id, run.rootWorkUnitId));
    if (root?.status === 'completed') return end('completed', null, gate.starter);
    await tx
      .update(processRuns)
      .set({ status: 'waiting', stopCode: 'ROOT_CONFIRMATION_REQUIRED', updatedAt: new Date() })
      .where(eq(processRuns.id, run.id));
    return { finished: null, moved: false, agents: [] };
  }
  if (decision.next === 'failed') {
    const code = state.rows.get(decision.stepKey)?.stopCode ?? 'STEP_FAILED';
    return end('failed', code, gate.starter);
  }
  if (decision.next === 'start_steps') {
    for (const key of decision.stepKeys) {
      const step = process.steps.find((candidate) => candidate.key === key);
      if (!step) continue;
      // Again before each effect, because each one can take a moment and the world moves on.
      const clear = await recheck(tx, run, spec);
      if (clear.code !== null) {
        return end(stopStatusFor(clear.code), clear.code, await starterOf(tx, run));
      }
      if (await startStep(tx, { ...state, starter: clear.starter }, step)) moved = true;
    }
  }
  const now = nextProcessSteps(process, statuses());
  if (now.next === 'wait' || !moved) {
    await tx
      .update(processRuns)
      .set({ status: 'waiting', updatedAt: new Date() })
      .where(eq(processRuns.id, run.id));
  }
  const agents = process.steps.flatMap((step) => {
    const row = state.rows.get(step.key);
    if (step.kind !== 'agent_task' || !row?.workUnitId) return [];
    if (row.status !== 'ready' && row.status !== 'waiting') return [];
    return [
      {
        stepKey: step.key,
        workUnitId: row.workUnitId,
        agentDefinitionId: step.agentDefinitionId ?? null,
        agentRunId: row.agentRunId,
        status: row.status,
      },
    ];
  });
  return { finished: null, moved, agents };
}

/** The root shows the process is going. A person may have moved it, and then this leaves it be. */
async function moveRootToRunning(tx: Tx, context: TenantContext, run: RunRow) {
  const [root] = await tx
    .select()
    .from(workUnits)
    .where(eq(workUnits.id, run.rootWorkUnitId))
    .for('update');
  if (!root || (root.status !== 'queued' && root.status !== 'ready')) return;
  await attempt(tx, async (nested) => {
    const ready =
      root.status === 'queued' ? await applyTransition(nested, context, root, 'ready') : root;
    return applyTransition(nested, context, ready, 'running');
  });
}

/** Writes what a port said, under the run's lock. A run that ended meanwhile keeps its steps as they are. */
async function recordAgent(
  database: AppDatabase,
  context: TenantContext,
  runId: string,
  stepKey: string,
  values: Parameters<typeof setStep>[3],
  closeAs: TenantContext | null,
): Promise<'written' | 'unchanged' | 'run_finished'> {
  return withTenantTx(database, context, async (tx) => {
    const run = await lockRun(tx, runId);
    const [row] = await tx
      .select()
      .from(processRunSteps)
      .where(and(eq(processRunSteps.runId, runId), eq(processRunSteps.stepKey, stepKey)));
    if (!row) throw new AppError('NOT_FOUND');
    if (FINISHED.has(run.status) || !['ready', 'waiting'].includes(row.status)) {
      // What it started still gets written down. The step's status is settled and stays.
      if (values.agentRunId && !row.agentRunId) {
        await setStep(tx, runId, stepKey, { agentRunId: values.agentRunId });
      }
      return 'run_finished';
    }
    if (values.status === 'done' && closeAs && row.workUnitId) {
      await closeWork(tx, closeAs, row.workUnitId);
      const [work] = await tx
        .select({ status: workUnits.status })
        .from(workUnits)
        .where(eq(workUnits.id, row.workUnitId));
      if (work?.status !== 'completed')
        values = { ...values, status: 'waiting', stopCode: 'WORK_CONFIRMATION_REQUIRED' };
    }
    if (Object.entries(values).every(([key, value]) => row[key as keyof StepRow] === value))
      return 'unchanged';
    await setStep(tx, runId, stepKey, values);
    return 'written';
  });
}

/**
 * Agent steps, with no transaction held, because each port call commits in M4's own. The step's Work Unit
 * already exists by now, and M4 allows one live run per Work Unit, so `listForWorkUnit` finds an earlier
 * attempt's run, and a worker dying here starts no second one. An agent acts as the starter, never as a
 * service (M4 FD-3). Answers whether anything moved.
 */
async function agentRound(
  database: AppDatabase,
  context: TenantContext,
  ports: Pick<ProductPorts, 'agentRuns'>,
  runId: string,
  agents: readonly AgentWork[],
): Promise<boolean> {
  let moved = false;
  for (const agent of agents) {
    const starter = await withTenantTx(database, context, async (tx) => {
      const run = await lockRun(tx, runId);
      if (FINISHED.has(run.status)) return null;
      const [spec] = await tx.select().from(processSpecs).where(eq(processSpecs.id, run.specId));
      if (!spec) return null;
      const gate = await recheck(tx, run, spec);
      return gate.starter;
    });
    // Stopped, or the starter has gone. The next round under the lock ends the run and says why.
    if (!starter) return true;

    let values: Parameters<typeof setStep>[3] | null;
    try {
      values = await agentStep(ports, starter, agent, runId);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      values = { status: 'failed', stopCode: error.code };
    }
    if (!values) continue;
    const written = await recordAgent(database, context, runId, agent.stepKey, values, starter);
    if (written === 'run_finished' && values.agentRunId) {
      await ports.agentRuns.requestStop(starter, values.agentRunId).catch(() => undefined);
    }
    if (written !== 'unchanged') moved = true;
  }
  return moved;
}

async function agentStep(
  ports: Pick<ProductPorts, 'agentRuns'>,
  starter: TenantContext,
  agent: AgentWork,
  processRunId: string,
): Promise<Parameters<typeof setStep>[3] | null> {
  if (agent.status === 'waiting' && agent.agentRunId) {
    const outcome = agentStepOutcome(await ports.agentRuns.outcome(starter, agent.agentRunId));
    return outcome.status === 'waiting' && outcome.stopCode === null ? null : outcome;
  }
  if (agent.status !== 'ready') return null;
  if (!agent.agentDefinitionId) return { status: 'failed', stopCode: 'AGENT_NOT_PUBLISHED' };
  const version = await ports.agentRuns.latestVersionOf(starter, agent.agentDefinitionId);
  if (!version) return { status: 'failed', stopCode: 'AGENT_NOT_PUBLISHED' };
  const { runId } = await ports.agentRuns.start(starter, {
    processRunId,
    stepKey: agent.stepKey,
    workUnitId: agent.workUnitId,
    agentVersionId: version,
    initiatorMembershipId: starter.membershipId,
  });
  return { status: 'waiting', stopCode: null, agentRunId: runId };
}

export type AdvanceResult =
  { next: 'wait' } | { next: 'finished'; status: 'completed' | 'failed' | 'cancelled' };

/**
 * The worker's one step, with a service context. Under a lock on the run: reads the spec and every step,
 * asks `nextProcessSteps`, and starts what it says. Rechecks before each effect that the starter is still
 * active, the root is not stopped, and the spec's hash is what was stored. Repeating it changes nothing:
 * every effect is keyed on (run, step), and an effect always goes through the normal service, so an external
 * action still needs its own approval, and an agent task acts as the starter (M4 FD-3), never as a service.
 * Port calls commit in M4's own transaction, so they happen after this one, keyed on the step's Work Unit.
 */
export async function advanceProcessRun(
  database: AppDatabase,
  context: TenantContext,
  ports: Pick<ProductPorts, 'agentRuns'>,
  input: { runId: string; temporalRunId: string },
): Promise<AdvanceResult> {
  // A person has no business here, and acting as one is what each step does for itself.
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  // Each round moves a step or ends this. A spec's size bounds it, and the limit is only there to be sure.
  for (let round = 0; round < PROCESS_LIMITS.maxNodes * 4; round += 1) {
    const result = await withTenantTx(database, context, (tx) => lockedRound(tx, context, input));
    if (result.finished) {
      // Best effort, once committed. M4 rechecks its Work Unit, which is stopped by now, before each turn.
      const { starter } = result;
      if (starter) {
        for (const id of result.finished.agentRunIds) {
          await ports.agentRuns.requestStop(starter, id).catch(() => undefined);
        }
      }
      return { next: 'finished', status: result.finished.status };
    }
    const moved = await agentRound(database, context, ports, input.runId, result.agents);
    if (!result.moved && !moved) return { next: 'wait' };
  }
  return { next: 'wait' };
}

const finishInput = z.strictObject({
  runId: idSchema,
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
});

/** For the workflow's stop path: marks what is left, and records why. */
export async function finishProcessRun(
  database: AppDatabase,
  context: TenantContext,
  raw: { runId: string; code: string },
): Promise<void> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const parsed = finishInput.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const input = parsed.data;
  await withTenantTx(database, context, async (tx) => {
    const run = await lockRun(tx, input.runId);
    if (FINISHED.has(run.status)) return;
    const [spec] = await tx.select().from(processSpecs).where(eq(processSpecs.id, run.specId));
    if (!spec) throw new AppError('NOT_FOUND');
    await finishInTx(
      tx,
      context,
      run,
      spec,
      stopStatusFor(input.code),
      input.code,
      await starterOf(tx, run),
    );
  });
}

const emailDetails = z.strictObject({
  to: z.array(z.email().max(254)).min(1).max(50),
  subject: z.string().trim().min(1).max(200),
  textBody: z.string().min(1).max(200_000),
});

/**
 * A person writes what an external step sends. A spec holds no recipients or words, so they arrive here, from
 * someone who answers for the run, and go through M3 as that person: M3 checks them against its own schema,
 * freezes them, and asks for its own approval from someone else. Nothing is sent by this.
 */
export async function proposeProcessStepAction(
  database: AppDatabase,
  context: TenantContext,
  raw: { runId: string; stepKey: string; to: readonly string[]; subject: string; textBody: string },
): Promise<void> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const { runId: rawRunId, stepKey, ...details } = raw;
  const id = idSchema.safeParse(rawRunId);
  if (!id.success) throw new AppError('NOT_FOUND');
  const parsed = emailDetails.safeParse(details);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const runId = id.data;
  await withStudioTx(database, context, async (tx) => {
    const person = await experiencePerson(tx, context);
    const run = await lockRun(tx, runId);
    const root = await loadReadable(tx, person, run.rootWorkUnitId);
    if (!answersFor(root, person)) throw new AppError('FORBIDDEN');
    if (FINISHED.has(run.status)) throw new AppError('INVALID_STATE');
    const [spec] = await tx.select().from(processSpecs).where(eq(processSpecs.id, run.specId));
    if (!spec) throw new AppError('NOT_FOUND');
    const gate = await recheck(tx, run, spec);
    if (gate.code !== null) throw new AppError('INVALID_STATE');

    const step = specOf(spec).steps.find((candidate) => candidate.key === stepKey);
    if (step?.kind !== 'external_action' || step.toolId !== EMAIL_SEND_TOOL) {
      throw new AppError('INVALID_INPUT');
    }
    const [row] = await tx
      .select()
      .from(processRunSteps)
      .where(and(eq(processRunSteps.runId, runId), eq(processRunSteps.stepKey, stepKey)));
    if (row?.status !== 'waiting' || !row.workUnitId || row.externalActionId) {
      throw new AppError('INVALID_STATE');
    }
    const [work] = await tx.select().from(workUnits).where(eq(workUnits.id, row.workUnitId));
    if (!work) throw new AppError('NOT_FOUND');
    const [connection] = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(eq(connections.connectorType, EMAIL_CONNECTOR_TYPE), eq(connections.state, 'active')),
      )
      .orderBy(asc(connections.id))
      .limit(1);
    if (!connection) throw new AppError('CONNECTION_NOT_ACTIVE');
    const approver = await findApprover(
      tx,
      { starter: person, asking: person.membershipId },
      run,
      spec,
      step,
      work,
    );
    if (!approver) throw new AppError('APPROVAL_WRONG_APPROVER');
    const proposed = await proposeExternalActionInTx(tx, context, {
      workUnitId: row.workUnitId,
      connectionId: connection.id,
      toolName: EMAIL_SEND_TOOL,
      toolVersion: EMAIL_SEND_VERSION,
      payload: {
        to: parsed.data.to,
        subject: parsed.data.subject,
        text_body: parsed.data.textBody,
      },
      approverMembershipId: approver,
    });
    await setStep(tx, runId, stepKey, {
      stopCode: null,
      externalActionId: proposed.externalActionId,
      approvalId: proposed.approvalId,
    });
    await emit(tx, context, {
      eventType: PROCESS_RUN_WAKE,
      aggregateType: AGGREGATE_PROCESS_RUN,
      aggregateId: runId,
      aggregateVersion: run.version,
      classification: spec.classification,
      payload: { process_run_id: runId },
    });
    await auditAction(tx, context, 'process_run.step_proposed', processRunTargetRef(runId));
  });
}
