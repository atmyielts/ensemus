'use server';
import {
  AppError,
  canonicalId,
  idSchema,
  auditRefusal,
  isAuditedRefusal,
  refusalCode,
  runIdempotent,
  requestHash,
} from '@ensemus/application';
import {
  addUploadedSource,
  addDocumentVersion,
  setSourceGrants,
  raiseSourceClassification,
} from '@ensemus/application/knowledge/sources';
import { askQuestion } from '@ensemus/application/knowledge/answers';
import { searchLexical } from '@ensemus/application/knowledge/retrieval';
import { proposeFact, reviewFact } from '@ensemus/application/knowledge/facts';
import { revokeSource, deleteSource } from '@ensemus/application/knowledge/purge';
import { decideArtifact } from '@ensemus/application/knowledge/verification';
import { startClientOnboarding } from '@ensemus/application/knowledge/onboarding';
import { reviewMcpTool, listMcpTools } from '@ensemus/application/knowledge/mcp';
import { simulateProvider } from '@ensemus/application/knowledge/egress';
import * as contracts from '@ensemus/contracts/knowledge';
import { MAX_DOCUMENT_BYTES } from '@ensemus/domain/knowledge';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { KnowledgeFormState } from '@/lib/knowledge-form-state';
import { uploadMediaType } from '@/lib/knowledge-input';
import { getStore, getRuntime } from './runtime';
import { requireTenant } from './tenant';
import { grantInput } from './knowledge-api';
import { getKnowledgeReadPorts } from './knowledge-ports';

const text = (form: FormData, name: string) =>
  typeof form.get(name) === 'string' ? String(form.get(name)) : '';
const identifier = (form: FormData, name: string) => {
  const result = idSchema.safeParse(canonicalId(text(form, name)));
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
};
const optionalIdentifier = (form: FormData, name: string) =>
  text(form, name) ? identifier(form, name) : undefined;
const version = (form: FormData) => {
  const raw = text(form, 'version');
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647) throw new AppError('INVALID_INPUT');
  return Number(raw);
};
const parse = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('INVALID_INPUT');
  return result.data;
};
function sourceGrantChoice(choice: string): contracts.SourceGrantBody[] {
  if (!choice || choice === 'private') return [];
  return [
    parse(
      contracts.sourceGrantSchema,
      choice === 'organization'
        ? { kind: 'organization' }
        : choice.startsWith('team:')
          ? { kind: 'team', team_id: choice.slice(5) }
          : { kind: 'membership', membership_id: choice },
    ),
  ];
}
type Tenant = Awaited<ReturnType<typeof requireTenant>>;
async function run(
  form: FormData,
  perform: (tenant: Tenant, org: string) => Promise<string | KnowledgeFormState>,
): Promise<KnowledgeFormState> {
  const org = identifier(form, 'organizationId'),
    tenant = await requireTenant(org);
  let target: string | undefined;
  try {
    const result = await perform(tenant, org);
    if (typeof result === 'string') {
      target = result;
      revalidatePath(`/o/${org}`, 'layout');
    } else return result;
  } catch (error) {
    if (isAuditedRefusal(error))
      await auditRefusal(tenant.database, tenant.context, {
        surface: 'web',
        code: refusalCode(error),
      }).catch((failure) =>
        getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
      );
    if (error instanceof AppError && error.code === 'RESTORE_PENDING') redirect('/restoring');
    if (!(error instanceof AppError))
      getRuntime().log.error('knowledge.action_failed', { errorCode: errorCode(error) });
    // Only the submitting person's own form text returns. It is never added to a URL or a log.
    const values: Record<string, string> = {};
    for (const [key, value] of form)
      if (typeof value === 'string' && !key.startsWith('$ACTION') && value.length <= 10000)
        values[key] = value;
    return { code: error instanceof AppError ? error.code : 'UNEXPECTED', values };
  }
  redirect(target!);
}
async function once<R>(
  tenant: Tenant,
  form: FormData,
  name: string,
  body: unknown,
  perform: (db: Tenant['database']) => Promise<R>,
): Promise<R> {
  const key = identifier(form, 'requestKey');
  const result = await runIdempotent(
    tenant.database,
    tenant.context,
    { key, requestHash: requestHash(['WEB', name, JSON.stringify(body)]) },
    perform,
    (row) => ({ status: 200, body: row }),
  );
  if (result.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
  return result.body as R;
}
export async function uploadKnowledgeAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) throw new AppError('INVALID_INPUT');
    if (file.size > MAX_DOCUMENT_BYTES) throw new AppError('FILE_TOO_LARGE');
    const sharing = text(form, 'sharing');
    const metadata = parse(contracts.addSourceSchema, {
      title: text(form, 'title'),
      classification: text(form, 'classification'),
      grants: sourceGrantChoice(sharing),
    });
    const row = await addUploadedSource(tenant.database, getStore(), tenant.context, {
      title: metadata.title,
      classification: metadata.classification,
      grants: metadata.grants.map(grantInput),
      requestKey: identifier(form, 'requestKey'),
      mediaType: uploadMediaType(file),
      body: Buffer.from(await file.arrayBuffer()),
    });
    return `/o/${org}/knowledge/sources/${row.sourceId}`;
  });
}
export async function askKnowledgeAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    const b = parse(contracts.askQuestionSchema, {
      question: text(form, 'question'),
      classification: text(form, 'classification'),
    });
    const row = await once(tenant, form, 'knowledge-answer', b, (db) =>
      askQuestion(db, tenant.context, {
        question: b.question,
        classification: b.classification,
        ...(b.model ? { model: b.model } : {}),
      }),
    );
    return `/o/${org}/knowledge/answers/${row.answerId}`;
  });
}
export async function uploadKnowledgeVersionAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    const sourceId = identifier(form, 'sourceId'),
      file = form.get('file');
    if (!(file instanceof File) || !file.size) throw new AppError('INVALID_INPUT');
    if (file.size > MAX_DOCUMENT_BYTES) throw new AppError('FILE_TOO_LARGE');
    const row = await addDocumentVersion(tenant.database, getStore(), tenant.context, {
      sourceId,
      expectedVersion: version(form),
      title: text(form, 'title'),
      mediaType: uploadMediaType(file),
      body: Buffer.from(await file.arrayBuffer()),
    });
    return `/o/${org}/knowledge/sources/${sourceId}?version_result=${row.unchanged ? 'unchanged' : 'saved'}#source-versions`;
  });
}
export async function searchKnowledgeAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant) => {
    const b = parse(contracts.knowledgeSearchSchema, { query: text(form, 'query') });
    const rows = await searchLexical(tenant.database, tenant.context, { query: b.query });
    return {
      searched: true,
      values: { query: b.query },
      passages: rows.map((p) => ({
        chunkId: p.chunkId,
        documentId: p.documentId,
        sourceId: p.sourceId,
        title: p.title,
        text: p.text,
        classification: p.classification,
      })),
    };
  });
}
export async function closeKnowledgeAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    const input = {
      sourceId: identifier(form, 'sourceId'),
      expectedVersion: version(form),
      reason: parse(contracts.closeSourceSchema, { reason: text(form, 'reason') }).reason,
    };
    if (parse(z.enum(['delete', 'revoke']), text(form, 'operation')) === 'delete')
      await deleteSource(tenant.database, tenant.context, input);
    else await revokeSource(tenant.database, tenant.context, input);
    return `/o/${org}/knowledge/sources/${input.sourceId}/purge`;
  });
}
export async function changeSourceGrantsAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    const sourceId = identifier(form, 'sourceId'),
      remove = optionalIdentifier(form, 'removeGrantId'),
      principal = text(form, 'principal');
    const b = parse(contracts.setSourceGrantsSchema, {
      add: sourceGrantChoice(principal),
      remove_grant_ids: remove ? [remove] : [],
    });
    await setSourceGrants(tenant.database, tenant.context, {
      sourceId,
      expectedVersion: version(form),
      add: b.add.map(grantInput),
      removeGrantIds: b.remove_grant_ids,
    });
    return `/o/${org}/knowledge/sources/${sourceId}`;
  });
}
export async function raiseSourceClassAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    const sourceId = identifier(form, 'sourceId'),
      b = parse(contracts.raiseClassificationSchema, {
        classification: text(form, 'classification'),
      });
    await raiseSourceClassification(tenant.database, tenant.context, {
      sourceId,
      expectedVersion: version(form),
      classification: b.classification,
    });
    return `/o/${org}/knowledge/sources/${sourceId}`;
  });
}
export async function proposeKnowledgeFactAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    const b = parse(contracts.proposeFactSchema, {
      subject_ref: text(form, 'subjectRef'),
      predicate: text(form, 'predicate'),
      claim: text(form, 'claim'),
      evidence: [
        {
          chunk_id: identifier(form, 'chunkId'),
          quote_start: 0,
          quote_end: Number(text(form, 'quoteEnd')),
        },
      ],
    });
    const row = await once(tenant, form, 'knowledge-fact', b, (db) =>
      proposeFact(db, tenant.context, {
        subjectRef: b.subject_ref,
        predicate: b.predicate,
        claim: b.claim,
        origin: 'person',
        evidence: b.evidence.map((e) => ({
          chunkId: e.chunk_id,
          quoteStart: e.quote_start,
          quoteEnd: e.quote_end,
        })),
      }),
    );
    return `/o/${org}/knowledge/facts/${row.factId}`;
  });
}
export async function reviewKnowledgeFactAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    const factId = identifier(form, 'factId'),
      b = parse(contracts.reviewFactSchema, {
        decision: text(form, 'decision'),
        reason: text(form, 'reason'),
      });
    await reviewFact(tenant.database, tenant.context, {
      factId,
      expectedVersion: version(form),
      decision: b.decision,
      reason: b.reason,
    });
    return `/o/${org}/knowledge/facts/${factId}`;
  });
}
export async function decideKnowledgeArtifactAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    const workUnitId = identifier(form, 'workUnitId'),
      artifactId = identifier(form, 'artifactId'),
      b = parse(contracts.decideArtifactSchema, {
        artifact_sha256: text(form, 'artifactSha256'),
        objective_sha256: text(form, 'objectiveSha256'),
        citations_sha256: text(form, 'citationsSha256'),
        verdict: text(form, 'verdict'),
        ...(text(form, 'reason') ? { reason: text(form, 'reason') } : {}),
      });
    await decideArtifact(
      tenant.database,
      tenant.context,
      {
        artifactId,
        workUnitId,
        artifactSha256: b.artifact_sha256,
        ...(b.objective_sha256 ? { objectiveSha256: b.objective_sha256 } : {}),
        ...(b.citations_sha256 ? { citationsSha256: b.citations_sha256 } : {}),
        verdict: b.verdict,
        ...(b.reason ? { reason: b.reason } : {}),
      },
      { store: getStore() },
    );
    return `/o/${org}/work/${workUnitId}/artifacts/${artifactId}/verification`;
  });
}
export async function startKnowledgeOnboardingAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    const b = parse(contracts.startClientOnboardingSchema, {
      deal_ref: text(form, 'dealRef'),
      client_name: text(form, 'clientName'),
      project_name: text(form, 'projectName'),
      owner_membership_id: identifier(form, 'ownerMembershipId'),
      reviewer_membership_id: identifier(form, 'reviewerMembershipId'),
      email_connection_id: identifier(form, 'emailConnectionId'),
      contact_email: text(form, 'contactEmail'),
    });
    const row = await once(tenant, form, 'client-onboarding', b, (db) =>
      startClientOnboarding(db, tenant.context, {
        dealRef: b.deal_ref,
        clientName: b.client_name,
        projectName: b.project_name,
        ownerMembershipId: b.owner_membership_id,
        reviewerMembershipId: b.reviewer_membership_id,
        emailConnectionId: b.email_connection_id,
        contactEmail: b.contact_email,
      }),
    );
    return `/o/${org}/onboarding/${row.onboardingId}`;
  });
}
export async function reviewKnowledgeMcpAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant, org) => {
    const connectionId = identifier(form, 'connectionId'),
      toolId = identifier(form, 'toolId');
    if (
      !(await listMcpTools(tenant.database, tenant.context, { connectionId })).some(
        (t) => t.id === toolId,
      )
    )
      throw new AppError('NOT_FOUND');
    const decision = parse(z.enum(['approve', 'reject']), text(form, 'decision'));
    const b = parse(
      contracts.reviewMcpToolSchema,
      decision === 'reject'
        ? { decision: 'reject' }
        : {
            decision: 'approve',
            side_effect_level: text(form, 'sideEffectLevel'),
            allowed_classes: form.getAll('allowedClasses'),
          },
    );
    await reviewMcpTool(tenant.database, tenant.context, {
      toolId,
      expectedVersion: version(form),
      decision: b.decision,
      ...(b.decision === 'approve'
        ? { sideEffectLevel: b.side_effect_level, allowedClasses: b.allowed_classes }
        : {}),
    });
    return `/o/${org}/settings/connections/${connectionId}/mcp-tools`;
  });
}
export async function simulateKnowledgeEgressAction(_state: KnowledgeFormState, form: FormData) {
  return run(form, async (tenant) => {
    const b = parse(contracts.egressProposalSchema, {
      destination: text(form, 'destination'),
      destination_host: text(form, 'destinationHost'),
      billing_owner: text(form, 'billingOwner'),
      retention_basis: text(form, 'retentionBasis'),
      region: text(form, 'region') || null,
      contract_ref: text(form, 'contractRef') || null,
      allowed_classes: [text(form, 'allowedClass')],
      purposes: [text(form, 'purpose')],
    });
    const ports = await getKnowledgeReadPorts(tenant.database, tenant.context),
      rows = await simulateProvider(tenant.database, tenant.context, ports, {
        proposal: {
          destination: b.destination,
          destinationHost: b.destination_host,
          billingOwner: b.billing_owner,
          retentionBasis: b.retention_basis,
          region: b.region,
          contractRef: b.contract_ref,
          allowedClasses: b.allowed_classes,
          purposes: b.purposes,
        },
      });
    return {
      coverage: ports.coverage,
      simulation: rows.map((row) => ({
        key: row.workloadKey,
        classification: row.classification,
        purpose: row.purpose,
        wouldTransmit: row.wouldTransmit,
        reasonCode: row.reasonCode,
      })),
      values: Object.fromEntries(
        [...form].filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
    };
  });
}
