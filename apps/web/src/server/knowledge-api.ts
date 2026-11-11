import 'server-only';
import { AppError, idSchema, requestHash, runIdempotent } from '@ensemus/application';
import {
  addUploadedSource,
  getSource,
  listSources,
  setSourceGrants,
  raiseSourceClassification,
  openDocumentBytes,
  type SourceGrantInput,
  type SourceSummary,
  type SourceDetail,
} from '@ensemus/application/knowledge/sources';
import {
  askQuestion,
  getAnswer,
  listMyAnswers,
  type AnswerView,
} from '@ensemus/application/knowledge/answers';
import { searchLexical, type RetrievedPassage } from '@ensemus/application/knowledge/retrieval';
import {
  getFact,
  listFacts,
  proposeFact,
  reviewFact,
  type FactView,
} from '@ensemus/application/knowledge/facts';
import { linkNodes, traverseGraph } from '@ensemus/application/knowledge/graph';
import {
  getPurgeStatus,
  revokeSource,
  deleteSource,
  type PurgeStatus,
} from '@ensemus/application/knowledge/purge';
import { searchCompany } from '@ensemus/application/knowledge/company-search';
import { listEgressLedger, simulateProvider } from '@ensemus/application/knowledge/egress';
import { listMcpTools, reviewMcpTool, type McpToolView } from '@ensemus/application/knowledge/mcp';
import {
  getArtifactVerification,
  decideArtifact,
  type ArtifactVerificationView,
} from '@ensemus/application/knowledge/verification';
import {
  startClientOnboarding,
  getClientOnboarding,
  type OnboardingView,
} from '@ensemus/application/knowledge/onboarding';
import * as contracts from '@ensemus/contracts/knowledge';
import type { components } from '@ensemus/contracts/openapi';
import { z } from 'zod';
import { readKnowledgeUpload } from '@/lib/knowledge-input';
import {
  apiRoute,
  assertConnectorsEnabled,
  organizationParams,
  readJson,
  readIfMatch,
  readQuery,
  etag,
  idempotencyKeyReused,
  type ApiScope,
} from './api';
import { getStore } from './runtime';
import { getKnowledgeReadPorts } from './knowledge-ports';

type Schema = components['schemas'];
function iso(date: Date): string;
function iso(date: Date | null): string | null;
function iso(date: Date | null) {
  return date?.toISOString() ?? null;
}
const pageQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export const sourceParams = organizationParams.extend({ sourceId: idSchema });
export const answerParams = organizationParams.extend({ answerId: idSchema });
export const factParams = organizationParams.extend({ factId: idSchema });
export const documentParams = organizationParams.extend({ documentId: idSchema });
export const onboardingParams = organizationParams.extend({ clientOnboardingId: idSchema });
export const toolParams = organizationParams.extend({
  connectionId: idSchema,
  mcpToolId: idSchema,
});
export const connectionParams = organizationParams.extend({ connectionId: idSchema });
export const verificationParams = organizationParams.extend({
  workUnitId: idSchema,
  artifactId: idSchema,
});

export function grantInput(grant: contracts.SourceGrantBody): SourceGrantInput {
  return grant.kind === 'membership'
    ? { kind: grant.kind, membershipId: grant.membership_id }
    : grant.kind === 'team'
      ? { kind: grant.kind, teamId: grant.team_id }
      : { kind: 'organization' };
}
export function sourceDto(
  row: SourceSummary | SourceDetail,
  includeDetails = false,
): Schema['KnowledgeSource'] {
  const detail = includeDetails && 'documentId' in row ? row : undefined;
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    classification: row.classification,
    title: row.title,
    can_read: row.canRead,
    document_state: row.documentState,
    embedding_state: row.embeddingState,
    searchable_at: iso(row.searchableAt),
    source_modified_at: iso(row.sourceModifiedAt),
    version: row.version,
    created_at: iso(row.createdAt),
    ...(detail
      ? {
          can_manage: detail.canManage,
          document_id: detail.documentId,
          media_type: detail.mediaType,
          size_bytes: detail.sizeBytes,
          source_url: detail.sourceUrl,
          source_version: detail.sourceVersion,
          // `flagged` is the pre-0710 name, never produced now; the API speaks only the current states.
          scan_state: detail.scanState === 'flagged' ? 'infected' : detail.scanState,
          reject_code: detail.rejectCode,
          grants_managed_by_provider: detail.grantsManagedByProvider,
          grants: detail.grants.map((grant) => ({
            id: grant.id,
            kind: grant.kind,
            ...(grant.kind === 'membership'
              ? { membership_id: grant.membershipId }
              : grant.kind === 'team'
                ? { team_id: grant.teamId }
                : {}),
          })),
        }
      : {}),
  };
}
export const passageDto = (row: RetrievedPassage): Schema['KnowledgePassage'] => ({
  chunk_id: row.chunkId,
  document_id: row.documentId,
  source_id: row.sourceId,
  excerpt: row.text,
  title: row.title,
  classification: row.classification,
  source_version: row.sourceVersion,
  source_url: row.sourceUrl,
  source_modified_at: iso(row.sourceModifiedAt),
  searchable_at: iso(row.searchableAt),
});
export const answerDto = (row: AnswerView): Schema['KnowledgeAnswer'] => ({
  id: row.id,
  state: row.state,
  question: row.question,
  question_classification: row.questionClassification,
  answer_text: row.answerText,
  refusal_code: row.refusalCode,
  strongest_classification: row.strongestClassification,
  cost_micros: row.costMicros,
  version: row.version,
  created_at: iso(row.createdAt),
  finished_at: iso(row.finishedAt),
  citations: row.citations.map((c) => ({
    ordinal: c.ordinal,
    answer_start: c.answerStart,
    answer_end: c.answerEnd,
    chunk_id: c.chunkId,
    document_id: c.documentId,
    source_id: c.sourceId,
    title: c.title,
    excerpt: c.excerpt,
    source_version: c.sourceVersion,
    source_url: c.sourceUrl,
    source_modified_at: iso(c.sourceModifiedAt),
    freshness: c.freshness,
  })),
});
export const factDto = (row: FactView): Schema['KnowledgeFact'] => ({
  id: row.id,
  subject_ref: row.subjectRef,
  predicate: row.predicate,
  claim: row.claim,
  trust_state: row.trustState,
  origin: row.origin,
  classification: row.classification,
  conflict_ref: row.conflictRef,
  reviewed_by_membership_id: row.reviewedByMembershipId,
  reviewed_at: iso(row.reviewedAt),
  version: row.version,
  created_at: iso(row.createdAt),
  evidence: row.evidence.map((e) => ({
    chunk_id: e.chunkId,
    document_id: e.documentId,
    source_id: e.sourceId,
    title: e.title,
    excerpt: e.excerpt,
    stale: e.stale,
  })),
});
export const purgeDto = (row: PurgeStatus): Schema['KnowledgePurge'] => ({
  source_id: row.sourceId,
  reason: row.reason,
  state: row.state,
  counts: {
    documents: row.counts.documents,
    chunks: row.counts.chunks,
    embeddings: row.counts.embeddings,
    facts: row.counts.facts,
    answers: row.counts.answers,
    blobs: row.counts.blobs,
    transcripts: row.counts.transcripts,
    artifacts: row.counts.artifacts,
    work_units: row.counts.workUnits,
    work_units_remaining: row.counts.workUnitsRemaining,
    work_control_proofs_remaining: row.counts.workControlProofsRemaining,
    unproven_work_units: row.counts.unprovenWorkUnits,
  },
  requested_at: iso(row.requestedAt),
  completed_at: iso(row.completedAt),
  last_error_code: row.lastErrorCode,
  retry_requests: row.retryRequests,
  next_retry_at: iso(row.nextRetryAt),
  retry_exhausted: row.retryExhausted,
  held_artifacts: row.heldArtifacts,
});
export const mcpDto = (t: McpToolView): Schema['McpTool'] => ({
  id: t.id,
  connection_id: t.connectionId,
  tool_name: t.toolName,
  definition: t.definition,
  definition_sha256: t.definitionSha256,
  status: t.status,
  side_effect_level: t.sideEffectLevel,
  allowed_classes: t.allowedClasses.map((value) => {
    if (value === 'restricted') throw new AppError('INVALID_STATE');
    return value;
  }),
  reviewed_by: t.reviewedByMembershipId,
  reviewed_at: iso(t.reviewedAt),
  version: t.version,
});
export const verificationDto = (v: ArtifactVerificationView): Schema['ArtifactVerification'] => ({
  artifact_id: v.artifactId,
  artifact_sha256: v.artifactSha256,
  objective_sha256: v.objectiveSha256,
  citations_sha256: v.citationsSha256,
  grounding: v.grounding
    ? { verdict: v.grounding.verdict, reason_code: v.grounding.reasonCode, at: iso(v.grounding.at) }
    : null,
  human: v.human
    ? { verdict: v.human.verdict, by: v.human.by, reason: v.human.reason, at: iso(v.human.at) }
    : null,
  citations: v.citations.map((c) => ({
    ordinal: c.ordinal,
    chunk_id: c.chunkId,
    document_id: c.documentId,
    source_id: c.sourceId,
    title: c.title,
    excerpt: c.excerpt,
    available: c.available,
  })),
});
export const onboardingDto = (r: OnboardingView): Schema['ClientOnboarding'] => ({
  id: r.id,
  deal_ref: r.dealRef,
  state: r.state,
  state_code: r.stateCode,
  client_id: r.clientId,
  project_id: r.projectId,
  work_unit_id: r.workUnitId,
  brief_work_unit_id: r.briefWorkUnitId,
  review_work_unit_id: r.reviewWorkUnitId,
  send_work_unit_id: r.sendWorkUnitId,
  brief_artifact_id: r.briefArtifactId,
  reviewer_membership_id: r.reviewerMembershipId,
  cost_micros: r.costMicros,
  receipt: r.receipt
    ? { status: r.receipt.status, external_id: r.receipt.externalId, basis: r.receipt.basis }
    : null,
  version: r.version,
  created_at: iso(r.createdAt),
  finished_at: iso(r.finishedAt),
});

async function once<P, R>(
  scope: ApiScope<P>,
  body: unknown,
  operation: string,
  status: number,
  perform: (database: ApiScope<P>['database']) => Promise<R>,
  dto: (row: R) => unknown,
): Promise<Response> {
  const outcome = await runIdempotent(
    scope.database,
    scope.context,
    {
      key: scope.request.headers.get('idempotency-key') ?? '',
      requestHash: requestHash(['POST', operation, JSON.stringify(body)]),
    },
    perform,
    (row) => ({ status, body: row }),
  );
  if (outcome.kind === 'conflict') throw idempotencyKeyReused();
  // Store the durable result IDs, then read their current authorized view. A key replay must not
  // return private words after the caller's source/subject access has been revoked.
  return Response.json(await dto(outcome.body as R), { status: outcome.status });
}

export const sourcesGET = apiRoute(organizationParams, async ({ request, database, context }) => {
  const query = readQuery(
    request,
    pageQuery.extend({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      state: z.enum(['active', 'revoked', 'deleted']).optional(),
    }),
  );
  const page = await listSources(database, context, {
    ...(query.cursor ? { after: query.cursor } : {}),
    ...(query.limit ? { limit: query.limit } : {}),
    ...(query.state ? { state: query.state } : {}),
  });
  return Response.json({ items: page.items.map((row) => sourceDto(row)), next_cursor: page.next });
});
export const sourcesPOST = apiRoute(organizationParams, async ({ request, database, context }) => {
  const { metadata, mediaType, body } = await readKnowledgeUpload(request);
  const key = z.string().min(8).max(128).safeParse(request.headers.get('idempotency-key'));
  if (!key.success) throw new AppError('INVALID_INPUT');
  const result = await addUploadedSource(database, getStore(), context, {
    title: metadata.title,
    classification: metadata.classification,
    grants: metadata.grants.map(grantInput),
    mediaType,
    body,
    requestKey: key.data,
  });
  const row = await getSource(database, context, result.sourceId);
  return Response.json(sourceDto(row, true), { status: 201, headers: { ETag: etag(row.version) } });
});
export const sourceGET = apiRoute(sourceParams, async ({ database, context, params }) => {
  const row = await getSource(database, context, params.sourceId);
  return Response.json(sourceDto(row, true), { headers: { ETag: etag(row.version) } });
});
export const sourceDELETE = apiRoute(
  sourceParams,
  async ({ request, database, context, params }) => {
    const body = await readJson(request, contracts.closeSourceSchema);
    await deleteSource(database, context, {
      sourceId: params.sourceId,
      expectedVersion: readIfMatch(request),
      reason: body.reason,
    });
    return Response.json(purgeDto(await getPurgeStatus(database, context, params.sourceId)), {
      status: 202,
    });
  },
);
export const sourceRevokePOST = apiRoute(
  sourceParams,
  async ({ request, database, context, params }) => {
    const body = await readJson(request, contracts.closeSourceSchema);
    await revokeSource(database, context, {
      sourceId: params.sourceId,
      expectedVersion: readIfMatch(request),
      reason: body.reason,
    });
    return Response.json(purgeDto(await getPurgeStatus(database, context, params.sourceId)), {
      status: 202,
    });
  },
);
export const sourceGrantsPATCH = apiRoute(
  sourceParams,
  async ({ request, database, context, params }) => {
    const body = await readJson(request, contracts.setSourceGrantsSchema);
    await setSourceGrants(database, context, {
      sourceId: params.sourceId,
      expectedVersion: readIfMatch(request),
      add: body.add.map(grantInput),
      removeGrantIds: body.remove_grant_ids,
    });
    return new Response(null, { status: 204 });
  },
);
export const sourceClassificationPATCH = apiRoute(
  sourceParams,
  async ({ request, database, context, params }) => {
    const body = await readJson(request, contracts.raiseClassificationSchema);
    await raiseSourceClassification(database, context, {
      sourceId: params.sourceId,
      expectedVersion: readIfMatch(request),
      classification: body.classification,
    });
    return new Response(null, { status: 204 });
  },
);
export const sourcePurgeGET = apiRoute(sourceParams, async ({ database, context, params }) =>
  Response.json(purgeDto(await getPurgeStatus(database, context, params.sourceId))),
);
export const documentGET = apiRoute(documentParams, async ({ database, context, params }) => {
  const file = await openDocumentBytes(database, getStore(), context, params.documentId);
  // Untrusted HTML is an attachment, with no execution in the application origin.
  return new Response(new Uint8Array(file.body), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="knowledge-document"',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    },
  });
});
export const searchPOST = apiRoute(organizationParams, async ({ request, database, context }) => {
  const body = await readJson(request, contracts.knowledgeSearchSchema);
  return Response.json({
    items: (
      await searchLexical(database, context, {
        query: body.query,
        ...(body.limit ? { limit: body.limit } : {}),
        ...(body.allowed_source_ids ? { sourceIds: body.allowed_source_ids } : {}),
      })
    ).map(passageDto),
  });
});
export const answersPOST = apiRoute(organizationParams, async (scope) => {
  const body = await readJson(scope.request, contracts.askQuestionSchema);
  return once(
    scope,
    body,
    'knowledge-answers',
    202,
    (joined) =>
      askQuestion(joined, scope.context, {
        question: body.question,
        classification: body.classification,
        ...(body.model ? { model: body.model } : {}),
      }),
    async (row) => answerDto(await getAnswer(scope.database, scope.context, row.answerId)),
  );
});
export const answersGET = apiRoute(organizationParams, async ({ request, database, context }) => {
  const q = readQuery(request, pageQuery);
  const rows = await listMyAnswers(database, context, {
    ...(q.cursor ? { after: q.cursor } : {}),
    ...(q.limit ? { limit: q.limit } : {}),
  });
  return Response.json({ items: rows.items.map(answerDto), next_cursor: rows.next });
});
export const answerGET = apiRoute(answerParams, async ({ database, context, params }) => {
  const row = await getAnswer(database, context, params.answerId);
  return Response.json(answerDto(row), { headers: { ETag: etag(row.version) } });
});
export const factsGET = apiRoute(organizationParams, async ({ request, database, context }) => {
  const q = readQuery(
    request,
    pageQuery.extend({
      subject_ref: z.string().max(64).optional(),
      trust_state: z
        .enum(['proposed', 'verified', 'disputed', 'rejected', 'superseded'])
        .optional(),
    }),
  );
  const page = await listFacts(database, context, {
    ...(q.cursor ? { after: q.cursor } : {}),
    ...(q.limit ? { limit: q.limit } : {}),
    ...(q.subject_ref ? { subjectRef: q.subject_ref } : {}),
    ...(q.trust_state ? { trustState: q.trust_state } : {}),
  });
  return Response.json({ items: page.items.map(factDto), next_cursor: page.next });
});
export const factsPOST = apiRoute(organizationParams, async (scope) => {
  const body = await readJson(scope.request, contracts.proposeFactSchema);
  return once(
    scope,
    body,
    'knowledge-facts',
    201,
    (joined) =>
      proposeFact(joined, scope.context, {
        subjectRef: body.subject_ref,
        predicate: body.predicate,
        claim: body.claim,
        origin: 'person',
        evidence: body.evidence.map((e) => ({
          chunkId: e.chunk_id,
          quoteStart: e.quote_start,
          quoteEnd: e.quote_end,
        })),
        ...(body.valid_from ? { validFrom: new Date(body.valid_from) } : {}),
        ...(body.valid_until ? { validUntil: new Date(body.valid_until) } : {}),
      }),
    async (row) => factDto(await getFact(scope.database, scope.context, row.factId)),
  );
});
export const factGET = apiRoute(factParams, async ({ database, context, params }) => {
  const row = await getFact(database, context, params.factId);
  return Response.json(factDto(row), { headers: { ETag: etag(row.version) } });
});
export const factReviewPOST = apiRoute(
  factParams,
  async ({ request, database, context, params }) => {
    const body = await readJson(request, contracts.reviewFactSchema);
    await reviewFact(database, context, {
      factId: params.factId,
      expectedVersion: readIfMatch(request),
      decision: body.decision,
      reason: body.reason,
    });
    const row = await getFact(database, context, params.factId);
    return Response.json(factDto(row), { headers: { ETag: etag(row.version) } });
  },
);
export const graphPOST = apiRoute(organizationParams, async ({ request, database, context }) => {
  const body = await readJson(request, contracts.traverseGraphSchema);
  return Response.json(
    await traverseGraph(database, context, {
      from: body.from,
      ...(body.relations ? { relations: body.relations } : {}),
      ...(body.depth ? { depth: body.depth } : {}),
      ...(body.limit ? { limit: body.limit } : {}),
    }),
  );
});
export const graphEdgesPOST = apiRoute(organizationParams, async ({ request, database, context }) =>
  Response.json(
    {
      edge_id: (
        await linkNodes(database, context, await readJson(request, contracts.linkNodesSchema))
      ).edgeId,
    },
    { status: 201 },
  ),
);
export const companySearchGET = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const params = new URL(request.url).searchParams;
    const q = contracts.companySearchQuerySchema.safeParse({
      q: params.get('q'),
      ...(params.has('kinds')
        ? { kinds: params.getAll('kinds').flatMap((k) => k.split(',')) }
        : {}),
      ...(params.has('limit') ? { limit: params.get('limit') } : {}),
    });
    if (!q.success) throw new AppError('INVALID_INPUT');
    return Response.json({
      items: await searchCompany(database, context, {
        query: q.data.q,
        ...(q.data.kinds ? { kinds: q.data.kinds } : {}),
        ...(q.data.limit ? { limit: q.data.limit } : {}),
      }),
    });
  },
);
export const egressGET = apiRoute(organizationParams, async ({ request, database, context }) => {
  const q = readQuery(request, pageQuery),
    ports = await getKnowledgeReadPorts(database, context);
  const page = await listEgressLedger(database, context, ports, {
    ...(q.cursor ? { after: q.cursor } : {}),
    ...(q.limit ? { limit: q.limit } : {}),
  });
  return Response.json({
    coverage: ports.coverage,
    next_cursor: page.next,
    items: page.items.map((e) => ({
      id: e.id,
      occurred_at: iso(e.occurredAt),
      source: e.source,
      purpose: e.purpose,
      data_class: e.dataClass,
      model_profile_ref: e.modelProfileRef,
      provider_kind: e.providerKind,
      destination_host: e.destinationHost,
      decision: e.decision,
      reason_code: e.reasonCode,
      policy_version: e.policyVersion,
      request_sha256: e.requestSha256,
      run_id: e.runId,
    })),
  });
});
export const simulationPOST = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const b = await readJson(request, contracts.egressProposalSchema),
      ports = await getKnowledgeReadPorts(database, context);
    const rows = await simulateProvider(database, context, ports, {
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
    return Response.json({
      coverage: ports.coverage,
      rows: rows.map((r) => ({
        workload_key: r.workloadKey,
        kind: r.kind,
        purpose: r.purpose,
        classification: r.classification,
        would_transmit: r.wouldTransmit,
        reason_code: r.reasonCode,
        policy_version: r.policyVersion,
      })),
    });
  },
);
export const mcpGET = apiRoute(connectionParams, async ({ database, context, params }) =>
  Response.json({ items: (await listMcpTools(database, context, params)).map(mcpDto) }),
);
export const mcpReviewPOST = apiRoute(
  toolParams,
  async ({ request, database, context, params }) => {
    const body = await readJson(request, contracts.reviewMcpToolSchema);
    const tools = await listMcpTools(database, context, params);
    if (!tools.some((t) => t.id === params.mcpToolId)) throw new AppError('NOT_FOUND');
    await reviewMcpTool(database, context, {
      toolId: params.mcpToolId,
      expectedVersion: readIfMatch(request),
      decision: body.decision,
      ...(body.decision === 'approve'
        ? { sideEffectLevel: body.side_effect_level, allowedClasses: body.allowed_classes }
        : {}),
    });
    const row = (await listMcpTools(database, context, params)).find(
      (t) => t.id === params.mcpToolId,
    );
    if (!row) throw new AppError('NOT_FOUND');
    return Response.json(mcpDto(row), { headers: { ETag: etag(row.version) } });
  },
);
export const verificationGET = apiRoute(verificationParams, async ({ database, context, params }) =>
  Response.json(verificationDto(await getArtifactVerification(database, context, params))),
);
export const verificationPOST = apiRoute(
  verificationParams,
  async ({ request, database, context, params }) => {
    const b = await readJson(request, contracts.decideArtifactSchema);
    await decideArtifact(
      database,
      context,
      {
        ...params,
        artifactSha256: b.artifact_sha256,
        ...(b.objective_sha256 ? { objectiveSha256: b.objective_sha256 } : {}),
        ...(b.citations_sha256 ? { citationsSha256: b.citations_sha256 } : {}),
        verdict: b.verdict,
        ...(b.reason ? { reason: b.reason } : {}),
      },
      { store: getStore() },
    );
    return Response.json(verificationDto(await getArtifactVerification(database, context, params)));
  },
);
export const onboardingPOST = apiRoute(organizationParams, async (scope) => {
  // An onboarding ends with a welcome message only the connector worker can send. Without connectors it would
  // start and then wait for a worker that is not coming, so it is refused before anything is read or written.
  assertConnectorsEnabled();
  const b = await readJson(scope.request, contracts.startClientOnboardingSchema);
  return once(
    scope,
    b,
    'client-onboardings',
    201,
    (joined) =>
      startClientOnboarding(joined, scope.context, {
        dealRef: b.deal_ref,
        clientName: b.client_name,
        projectName: b.project_name,
        ownerMembershipId: b.owner_membership_id,
        reviewerMembershipId: b.reviewer_membership_id,
        emailConnectionId: b.email_connection_id,
        contactEmail: b.contact_email,
      }),
    async (row) =>
      onboardingDto(await getClientOnboarding(scope.database, scope.context, row.onboardingId)),
  );
});
export const onboardingGET = apiRoute(onboardingParams, async ({ database, context, params }) => {
  const r = await getClientOnboarding(database, context, params.clientOnboardingId);
  return Response.json(onboardingDto(r), { headers: { ETag: etag(r.version) } });
});
