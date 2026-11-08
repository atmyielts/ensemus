// The exact M2 plan template is the sole authority for its explicit no-knowledge inventory.
import { createHash } from 'node:crypto';
import {
  artifactAclCatalog,
  artifactLineage,
  artifactWorkLinks,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { and, eq } from 'drizzle-orm';
import type { CompletionCriterion } from '@ensemus/domain/work-unit';
import { canonicalJson } from '@ensemus/domain/approval';
import { AppError } from '../errors';
import { loadReadable } from '../work';
import type { ObjectStore } from '../artifacts';
import { addGeneratedArtifact, type ArtifactInputInventory } from './artifact-provenance';
import { workInputClassInTx } from '../ai/input-observations';

export const CHECKLIST_TEMPLATE = 'ensemus/completion-checklist/v1';
export const CHECKLIST_NAME = 'completion-checklist.md';
const words: Record<CompletionCriterion['kind'], string> = {
  artifact_exists: 'Someone attaches the file that shows the result.',
  reviewer_approved: 'A reviewer approves this work as it stands.',
  external_receipt: 'The outside system confirms it happened.',
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function completionChecklist(work: {
  id: string;
  completionCriteria: readonly CompletionCriterion[];
}) {
  const criteria: readonly CompletionCriterion[] = work.completionCriteria;
  if (
    !Array.isArray(work.completionCriteria) ||
    work.completionCriteria.some((criterion) => !criterion || !Object.hasOwn(words, criterion.kind))
  )
    throw new AppError('INVALID_STATE');
  return [
    '# Completion checklist',
    '',
    'Ensemus wrote this list. It has not checked any of this, and this file is not evidence.',
    'A person decides when this work is done.',
    '',
    `Work: ${work.id}`,
    '',
    ...(criteria.length
      ? criteria.map((criterion) => `- [ ] ${words[criterion.kind]}`)
      : ['- [ ] The accountable owner confirms the outcome. No evidence was asked for.']),
    '',
  ].join('\n');
}
export function createChecklistInputInventory(): ArtifactInputInventory {
  return {
    async inspectInTx(tx, context, input) {
      if (
        context.actorType !== 'service' ||
        input.execution.kind !== 'system' ||
        input.execution.template !== CHECKLIST_TEMPLATE
      )
        return { known: false };
      const work = await loadReadable(tx, context, input.workUnitId);
      if (
        work.status !== 'running' ||
        work.runId !== input.execution.id ||
        hash(
          completionChecklist(work as typeof work & { completionCriteria: CompletionCriterion[] }),
        ) !== input.artifactSha256
      )
        return { known: false };
      const classification = await workInputClassInTx(
        tx,
        work.id,
        work.classification as 'public' | 'internal' | 'confidential' | 'restricted',
      );
      return {
        known: true,
        execution: input.execution,
        workUnitId: work.id,
        viewerMembershipId: null,
        classification,
        noKnowledge: true,
        artifactInputs: [],
        recordInputs: [
          {
            kind: 'work_unit',
            id: work.id,
            classification,
            sha256: hash(
              canonicalJson({ id: work.id, completionCriteria: work.completionCriteria }),
            ),
          },
        ],
      };
    },
  };
}
export async function produceCompletionChecklist(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { workUnitId: string; runId: string },
) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const { body, existing } = await withTenantTx(database, context, async (tx) => {
    const work = await loadReadable(tx, context, input.workUnitId);
    if (work.status !== 'running' || work.runId !== input.runId)
      throw new AppError('INVALID_STATE');
    const body = Buffer.from(
      completionChecklist(work as typeof work & { completionCriteria: CompletionCriterion[] }),
    );
    // Control-plane metadata suffices for an exact known template; no service file-serving bypass.
    const [existing] = await tx
      .select({
        id: artifactLineage.artifactId,
        sha256: artifactLineage.artifactSha256,
        state: artifactLineage.state,
      })
      .from(artifactLineage)
      .innerJoin(artifactAclCatalog, eq(artifactAclCatalog.artifactId, artifactLineage.artifactId))
      .innerJoin(artifactWorkLinks, eq(artifactWorkLinks.artifactId, artifactLineage.artifactId))
      .where(
        and(
          eq(artifactWorkLinks.workUnitId, work.id),
          eq(artifactLineage.workUnitId, work.id),
          eq(artifactLineage.executionKind, 'system'),
          eq(artifactLineage.executionId, input.runId),
          eq(artifactLineage.executorRef, CHECKLIST_TEMPLATE),
          eq(artifactAclCatalog.alive, true),
        ),
      )
      .orderBy(artifactLineage.createdAt)
      .limit(1);
    if (existing && (existing.sha256 !== hash(body) || existing.state !== 'bound'))
      throw new AppError('INVALID_STATE');
    return { body, existing };
  });
  if (existing) return { id: existing.id };
  return addGeneratedArtifact(
    database,
    store,
    context,
    {
      workUnitId: input.workUnitId,
      name: CHECKLIST_NAME,
      mimeType: 'text/markdown',
      body,
      execution: { kind: 'system', id: input.runId, template: CHECKLIST_TEMPLATE },
      requestKey: `completion-checklist:${input.runId}`,
    },
    { inventory: createChecklistInputInventory() },
  );
}
