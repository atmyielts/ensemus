// Owned by the context slice (AGENT-15). What an agent can read, loaded under its initiator's context, so
// every read goes through the same Work Unit access rules a person gets. The tool gateway reads through
// this as well. Only agent-worker uses it.
import { createHash } from 'node:crypto';
import { agentSpecV1Schema } from '@ensemus/contracts/ai';
import {
  agentRuns,
  agentVersions,
  artifacts,
  clients,
  executionSteps,
  projects,
  stepPayloads,
  tombstones,
  withTenantTx,
  workArtifacts,
  type AgentContext,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import {
  CLASSIFICATIONS,
  strongestClassification,
  type AiClassification,
  type ModelCapability,
} from '@ensemus/domain/ai';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../errors';
import { canonicalId, idSchema } from '../ids';
import { loadReadable } from '../work';
import { lockArtifactInputSources } from '../knowledge/artifact-provenance';
import {
  assertRunInputsOpen,
  assertRunInputsReadable,
  recordRunInputs,
  workInputHash,
  workInputClassInTx,
} from './input-ledger';
import {
  assertWithinAgentCeiling,
  assertWithinAgentProtection,
  loadAgentReadScopeInTx,
} from './read-scope';
import { currentRunInputClassInTx } from './model-admission';
import { lockReadAuthorityBeforeBody } from './read-authority';
export { loadAgentReadScope } from './read-scope';

export type LoadedWork = {
  id: string;
  title: string;
  objective: string | null;
  classification: AiClassification;
  clientClassification: AiClassification | null;
  artifactIds: readonly string[];
};

export type LoadedArtifact = {
  id: string;
  classification: AiClassification;
  sha256: string;
  text: string;
};

/**
 * `NOT_PERMITTED` also covers an ID not attached to this work: another tenant's, another work's or one
 * already removed all look alike, so this cannot be used to find out what exists. `DELETED` is for a file
 * still attached whose tombstone is set, or whose bytes are gone or no longer what was attached.
 */
export type ArtifactRefusal = 'NOT_PERMITTED' | 'NOT_TEXT' | 'TOO_LARGE' | 'DELETED';

/** One earlier part of this run's transcript, from `ai.step_payloads`, which the next turn needs. */
export type TranscriptPart = {
  stepNumber: number;
  kind: 'completion' | 'tool_args' | 'tool_output';
  classification: AiClassification;
  text: string;
};

/**
 * What the run's own rows say a turn may use. Read fresh each turn, from the immutable version and the
 * limits no role can raise, so nothing a model did earlier can change it.
 */
export type LoadedRunBrief = {
  objective: string;
  /** The only tenant-written text that may reach role `policy` (FD-17). */
  instructions: string;
  requiredCapabilities: readonly ModelCapability[];
  qualityTier: 'economy' | 'balanced' | 'high';
  allowFallback: boolean;
  allowedTools: readonly string[];
  deniedTools: readonly string[];
  /** The run's stored scopes: the intersection, for a child. */
  delegatedTools: readonly string[];
  maxInputTokens: number | null;
  /** The run's class so far. Whatever a turn includes can only raise this (FD-13). */
  classification: AiClassification;
  pinned: { profileId: string; profileVersion: number } | null;
  remaining: { tokens: number; activeMs: number };
};

export interface ContextSource {
  /** Throws NOT_FOUND when the initiator cannot read this work, whatever the agent role could. */
  loadWork(context: AgentContext, workUnitId: string): Promise<LoadedWork>;
  /** Rechecks access now. Text files only, up to `maxBytes`. */
  loadArtifactText(
    context: AgentContext,
    input: { workUnitId: string; artifactId: string; maxBytes: number },
  ): Promise<LoadedArtifact | { refused: ArtifactRefusal }>;
  /** Oldest first, for this run only. Only the agent role can run this query at all. */
  loadTranscript(context: AgentContext, runId: string): Promise<readonly TranscriptPart[]>;
}

/**
 * The compiler needs one thing more than a tool does: the run's own instructions and limits. It is apart
 * from `ContextSource` so a tool gateway keeps only the reads it uses.
 */
export interface RunContextSource extends ContextSource {
  /** Throws NOT_FOUND unless this is the context's own run, on this work, at this version. */
  loadRunBrief(
    context: AgentContext,
    run: { runId: string; workUnitId: string; agentVersionId: string },
  ): Promise<LoadedRunBrief>;
}

// --- Reading a file's bytes. Pure apart from the read it is handed, so it is tested without a database.

const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
]);

/** By what the file says it is. That can be false, so the bytes are checked too, in `decodeText`. */
export function isTextMimeType(mimeType: string): boolean {
  const essence = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return /^text\/[a-z0-9.+-]+$/.test(essence) || TEXT_APPLICATION_TYPES.has(essence);
}

/** Null for anything that is not clean UTF-8 text, whatever its type claimed. */
export function decodeText(body: Buffer): string | null {
  if (body.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

/** Only a clear "not there" counts as gone, as in the store's own `exists`. */
function isMissingObject(error: unknown): boolean {
  const { $metadata, name } = error as { $metadata?: { httpStatusCode?: number }; name?: string };
  return $metadata?.httpStatusCode === 404 || name === 'NoSuchKey';
}

export type ArtifactRow = {
  id: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  classification: string;
};

/**
 * Type and size come first, from the row, so an enormous or binary file is refused without reading any
 * of it. A store failure that is not "not there" is thrown: the Activity retries, rather than a model
 * carrying on without a file that was only out of reach for a moment.
 */
export async function readTextArtifact(
  row: ArtifactRow,
  maxBytes: number,
  readObject: (objectKey: string, maxBytes: number) => Promise<Buffer>,
): Promise<LoadedArtifact | { refused: ArtifactRefusal }> {
  if (!isTextMimeType(row.mimeType)) return { refused: 'NOT_TEXT' };
  if (row.sizeBytes > maxBytes) return { refused: 'TOO_LARGE' };
  let body: Buffer;
  try {
    body = await readObject(row.objectKey, maxBytes);
  } catch (error) {
    if (isMissingObject(error)) return { refused: 'DELETED' };
    throw error;
  }
  if (body.length > maxBytes) return { refused: 'TOO_LARGE' };
  // Also catches a read cut short at the limit: part of a file must not pass as all of it.
  if (createHash('sha256').update(body).digest('hex') !== row.sha256) {
    return { refused: 'DELETED' };
  }
  const text = decodeText(body);
  if (text === null) return { refused: 'NOT_TEXT' };
  return { id: row.id, classification: classOf(row.classification), sha256: row.sha256, text };
}

// --- Rows.

/** A constraint holds these to the list. Should one ever not be, it counts as the strongest class. */
function classOf(value: string): AiClassification {
  return (CLASSIFICATIONS as readonly string[]).includes(value)
    ? (value as AiClassification)
    : 'restricted';
}

/**
 * The type says agent, and this makes sure at runtime. A service context skips every Work Unit check in
 * `loadReadable`, so one reaching this file by a cast would read restricted work (FD-3).
 */
function assertAgent(context: AgentContext) {
  if (context.actorType !== 'agent') throw new AppError('FORBIDDEN');
}

function assertOwnRun(context: AgentContext, runId: string) {
  if (canonicalId(runId) !== context.agentRunId) throw new AppError('NOT_FOUND');
}

const delegatedScopesSchema = z.object({ tools: z.array(z.string()) });

const TRANSCRIPT_KINDS = ['completion', 'tool_args', 'tool_output'] as const;

async function clientClassOf(tx: Tx, projectId: string | null) {
  if (!projectId) return null;
  const [client] = await tx
    .select({ classification: clients.classification })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(eq(projects.id, projectId));
  return client ? classOf(client.classification) : null;
}

/** `readObject` comes from @ensemus/storage in agent-main.ts, so this file reaches no store directly. */
export function createContextSource(deps: {
  database: AppDatabase;
  readObject: (objectKey: string, maxBytes: number) => Promise<Buffer>;
}): RunContextSource {
  const { database, readObject } = deps;
  return {
    async loadRunBrief(context, run) {
      assertAgent(context);
      assertOwnRun(context, run.runId);
      const workUnitId = idSchema.safeParse(run.workUnitId);
      const agentVersionId = idSchema.safeParse(run.agentVersionId);
      if (!workUnitId.success || !agentVersionId.success) throw new AppError('NOT_FOUND');
      const [row] = await withTenantTx(database, context, async (tx) => {
        await assertRunInputsOpen(tx, context);
        return tx
          .select({ run: agentRuns, spec: agentVersions.spec })
          .from(agentRuns)
          .innerJoin(agentVersions, eq(agentVersions.id, agentRuns.agentVersionId))
          .where(
            and(
              eq(agentRuns.id, context.agentRunId),
              eq(agentRuns.workUnitId, workUnitId.data),
              eq(agentRuns.agentVersionId, agentVersionId.data),
              // A context is built from the run's initiator. One that is not has been put together wrong.
              eq(agentRuns.initiatorMembershipId, context.membershipId),
            ),
          );
      });
      if (!row) throw new AppError('NOT_FOUND');
      // Both were checked when written. A row that no longer parses stops the run rather than guessing.
      const spec = agentSpecV1Schema.safeParse(row.spec);
      const scopes = delegatedScopesSchema.safeParse(row.run.delegatedScopes);
      if (!spec.success || !scopes.success) throw new AppError('INVALID_STATE');
      const { run: stored } = row;
      return {
        objective: spec.data.objective,
        instructions: spec.data.instructions,
        requiredCapabilities: spec.data.model.required_capabilities,
        qualityTier: spec.data.model.quality_tier,
        allowFallback: spec.data.model.fallback === 'approved_profiles_only',
        allowedTools: spec.data.tools.allow,
        deniedTools: spec.data.tools.deny ?? [],
        delegatedTools: scopes.data.tools,
        maxInputTokens: spec.data.context.max_input_tokens ?? null,
        classification: classOf(stored.effectiveClassification),
        pinned:
          stored.boundProfileId !== null && stored.boundProfileVersion !== null
            ? { profileId: stored.boundProfileId, profileVersion: stored.boundProfileVersion }
            : null,
        remaining: {
          tokens: stored.maxTotalTokens - stored.inputTokens - stored.outputTokens,
          activeMs: stored.timeoutSeconds * 1000 - stored.activeMs,
        },
      };
    },

    async loadWork(context, workUnitId) {
      assertAgent(context);
      const id = idSchema.safeParse(workUnitId);
      if (!id.success) throw new AppError('NOT_FOUND');
      return withTenantTx(database, context, async (tx) => {
        await assertRunInputsOpen(tx, context);
        const scope = await loadAgentReadScopeInTx(tx, context);
        // Pin the exact current authority closure before the body read; receipt capture must not
        // substitute a later parent after a concurrent reparenting.
        await lockReadAuthorityBeforeBody(tx, context, { kind: 'work_unit', id: id.data });
        const work = await loadReadable(tx, context, id.data);
        const floor = await workInputClassInTx(tx, id.data, 'public');
        assertWithinAgentCeiling(scope, floor);
        const attached = await tx
          .select({ id: workArtifacts.artifactId })
          .from(workArtifacts)
          .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
          .where(
            and(
              eq(workArtifacts.workUnitId, work.id),
              scope.ceiling
                ? inArray(
                    artifacts.classification,
                    CLASSIFICATIONS.slice(0, CLASSIFICATIONS.indexOf(scope.ceiling) + 1),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(workArtifacts.artifactId));
        const clientClassification = await clientClassOf(tx, work.projectId);
        const effectiveClass = await workInputClassInTx(
          tx,
          work.id,
          strongestClassification(classOf(work.classification), clientClassification ?? 'public'),
        );
        const loaded = {
          id: work.id,
          title: work.title,
          objective: work.objective,
          classification: effectiveClass,
          clientClassification,
          artifactIds: attached.map((row) => row.id),
        };
        await recordRunInputs(tx, context, [
          {
            kind: 'work_unit',
            id: work.id,
            sha256: workInputHash(work),
            classification: effectiveClass,
          },
        ]);
        return loaded;
      });
    },

    async loadArtifactText(context, input) {
      assertAgent(context);
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new AppError('INVALID_INPUT');
      }
      const workUnitId = idSchema.safeParse(input.workUnitId);
      const artifactId = idSchema.safeParse(input.artifactId);
      if (!workUnitId.success || !artifactId.success) return { refused: 'NOT_PERMITTED' };
      // The transaction ends before the bytes are read: nothing holds a connection across a store call.
      const found = await withTenantTx(database, context, async (tx) => {
        await assertRunInputsOpen(tx, context);
        const scope = await loadAgentReadScopeInTx(tx, context);
        try {
          await lockReadAuthorityBeforeBody(tx, context, {
            kind: 'artifact',
            id: artifactId.data,
            authorizationWorkUnitId: workUnitId.data,
          });
          await loadReadable(tx, context, workUnitId.data);
          const workClass = await workInputClassInTx(tx, workUnitId.data, 'public');
          assertWithinAgentCeiling(scope, workClass);
        } catch (error) {
          if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
          throw error;
        }
        const [row] = await tx
          .select({
            id: artifacts.id,
            objectKey: artifacts.objectKey,
            mimeType: artifacts.mimeType,
            sizeBytes: artifacts.sizeBytes,
            sha256: artifacts.sha256,
            classification: artifacts.classification,
          })
          .from(workArtifacts)
          .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
          .where(
            and(
              eq(workArtifacts.workUnitId, workUnitId.data),
              eq(workArtifacts.artifactId, artifactId.data),
            ),
          );
        if (!row) return null;
        if (
          scope.ceiling &&
          strongestClassification(scope.ceiling, classOf(row.classification)) !== scope.ceiling
        )
          return null;
        const tombstone = await tx
          .select({ id: tombstones.targetId })
          .from(tombstones)
          .where(and(eq(tombstones.targetType, 'artifact'), eq(tombstones.targetId, row.id)));
        return { row, deleted: tombstone.length > 0 };
      });
      if (!found) return { refused: 'NOT_PERMITTED' };
      if (found.deleted) return { refused: 'DELETED' };
      const loaded = await readTextArtifact(found.row, input.maxBytes, readObject);
      if ('refused' in loaded) return loaded;
      // Verified bytes never reach a model/tool until fresh ACL/hash checks and durable observation
      // commit. Sources precede run/checkpoint locks, matching source-close/purge order.
      return withTenantTx(database, context, async (tx) => {
        await lockArtifactInputSources(tx, context, { artifactId: loaded.id });
        const scope = await loadAgentReadScopeInTx(tx, context);
        assertWithinAgentCeiling(scope, loaded.classification);
        await lockReadAuthorityBeforeBody(tx, context, {
          kind: 'artifact',
          id: loaded.id,
          authorizationWorkUnitId: workUnitId.data,
        });
        const work = await loadReadable(tx, context, workUnitId.data);
        assertWithinAgentCeiling(scope, await workInputClassInTx(tx, workUnitId.data, 'public'));
        const [current] = await tx
          .select({ sha256: artifacts.sha256, classification: artifacts.classification })
          .from(workArtifacts)
          .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
          .where(and(eq(workArtifacts.workUnitId, work.id), eq(artifacts.id, loaded.id)));
        if (!current || current.sha256 !== loaded.sha256)
          return { refused: 'NOT_PERMITTED' as const };
        const finalClass = strongestClassification(
          loaded.classification,
          classOf(current.classification),
        );
        if (scope.ceiling && strongestClassification(scope.ceiling, finalClass) !== scope.ceiling)
          return { refused: 'NOT_PERMITTED' as const };
        await recordRunInputs(tx, context, [
          {
            kind: 'work_unit',
            id: work.id,
            sha256: workInputHash(work),
            classification: await workInputClassInTx(tx, work.id, classOf(work.classification)),
          },
          {
            kind: 'artifact',
            id: loaded.id,
            sha256: loaded.sha256,
            classification: finalClass,
            authorizationWorkUnitId: work.id,
          },
        ]);
        return { ...loaded, classification: finalClass };
      });
    },

    async loadTranscript(context, runId) {
      assertAgent(context);
      assertOwnRun(context, runId);
      const rows = await withTenantTx(database, context, async (tx) => {
        await assertRunInputsReadable(tx, context);
        const scope = await loadAgentReadScopeInTx(tx, context);
        // Internal policy text does not prove company data was public. Check every retained actual
        // current/historical influence before allowing an internally protected transcript body.
        await currentRunInputClassInTx(tx, context);
        const classes = await tx
          .select({ classification: stepPayloads.classification })
          .from(stepPayloads)
          .innerJoin(executionSteps, eq(executionSteps.id, stepPayloads.stepId))
          .where(
            and(
              eq(executionSteps.runId, context.agentRunId),
              inArray(stepPayloads.kind, [...TRANSCRIPT_KINDS]),
            ),
          );
        for (const row of classes) assertWithinAgentProtection(scope, classOf(row.classification));
        const rows = await tx
          .select({
            stepNumber: executionSteps.stepNumber,
            kind: stepPayloads.kind,
            classification: stepPayloads.classification,
            text: stepPayloads.content,
          })
          .from(stepPayloads)
          .innerJoin(executionSteps, eq(executionSteps.id, stepPayloads.stepId))
          .innerJoin(agentRuns, eq(agentRuns.id, executionSteps.runId))
          .where(
            and(
              eq(agentRuns.id, context.agentRunId),
              eq(agentRuns.initiatorMembershipId, context.membershipId),
              // A stored prompt is this same context again. Sending it back would only double it.
              inArray(stepPayloads.kind, [...TRANSCRIPT_KINDS]),
            ),
          )
          .orderBy(
            asc(executionSteps.stepNumber),
            asc(stepPayloads.createdAt),
            asc(stepPayloads.id),
          );
        await assertRunInputsReadable(tx, context);
        return rows;
      });
      return rows.map((row) => ({
        stepNumber: row.stepNumber,
        kind: row.kind as TranscriptPart['kind'],
        classification: classOf(row.classification),
        text: row.text,
      }));
    },
  };
}
