// Model calls are bound to one immutable real run/job principal. No provider output or private input
// crosses Temporal, and a durable dispatched attempt is never paid for a second time on retry.
import type {
  KnowledgeCallStore,
  KnowledgeModelCandidate,
  KnowledgeModelPrincipal,
} from '@ensemus/application/ai-knowledge-ports';
import type { Entitlements } from '@ensemus/application/ai-ports';
import {
  qualifiedFor,
  validRanking,
  type KnowledgeModelPurpose,
} from '@ensemus/domain/knowledge-models';
import { strongestClass, RETRIEVAL_CANDIDATES } from '@ensemus/domain/knowledge';
import {
  ModelCallFailed,
  type KnowledgeMessage,
  type KnowledgeModelPort,
  type ModelCallMetadata,
  type ModelRoute,
} from '@ensemus/knowledge/ports';
import {
  operationHash,
  rankingMessages,
  rankingSchema,
  normalizeModelInputs,
  type KnowledgeOperation,
} from '@ensemus/knowledge/model-operations';
import { decideEgress, scanForSecrets, type TenantPolicyBundle } from '@ensemus/policy';
import { checkEndpoint } from '@ensemus/policy/endpoint';
import type { Classification } from '@ensemus/domain/policy';
import type { CredentialLender, EndpointGuard, ModelAdapter, AdapterResult } from './types';
import type { EmbeddingAdapter } from './embedding-adapter';
import { egressFacts, hostOf, protocolOf } from './router/facts';

export type KnowledgeModelGatewayDeps = {
  store: KnowledgeCallStore;
  entitlements: Entitlements;
  credentials: CredentialLender;
  guard: EndpointGuard;
  adapter: ModelAdapter;
  embeddings: EmbeddingAdapter;
  privateEndpoints: readonly string[];
  canaries: () => Promise<readonly string[]>;
  bundle: (principal: KnowledgeModelPrincipal) => Promise<TenantPolicyBundle | null>;
  now?: () => Date;
};
const unavailable = () => new ModelCallFailed('MODEL_UNAVAILABLE');
const denied = () => new ModelCallFailed('EGRESS_DENIED');
const matches = (
  candidate: KnowledgeModelCandidate,
  route: ModelRoute,
  purpose: KnowledgeModelPurpose,
) =>
  candidate.profile.id === route.modelProfileRef &&
  candidate.profile.version === route.modelProfileVersion &&
  candidate.qualification.id === route.qualificationId &&
  route.purpose === purpose &&
  candidate.profile.modelId === route.modelId &&
  candidate.profile.providerKind === route.providerKind &&
  hostOf(candidate.profile.endpointUrl) === route.destinationHost &&
  (purpose !== 'embed' ||
    (route.embedding?.dimension === candidate.qualification.dimension &&
      route.embedding?.vectorSpaceVersion === candidate.qualification.vectorSpaceVersion));

export function createKnowledgeModelGateway(deps: KnowledgeModelGatewayDeps) {
  const now = deps.now ?? (() => new Date());
  return (principal: KnowledgeModelPrincipal): KnowledgeModelPort => {
    const context = principal.context;
    const allowed = (
      candidate: KnowledgeModelCandidate,
      purpose: KnowledgeModelPurpose,
      classification: Classification,
      bundle: TenantPolicyBundle | null,
    ) => {
      const qualification = candidate.qualification;
      if (candidate.qualifying) {
        if (
          qualification.state !== 'requested' ||
          qualification.profileId !== candidate.profile.id ||
          qualification.profileVersion !== candidate.profile.version ||
          qualification.purpose !== purpose ||
          candidate.profile.status !== 'probing' ||
          classification !== 'public'
        )
          return null;
      } else if (
        !qualifiedFor(qualification, candidate.profile, purpose) ||
        candidate.profile.status !== 'active'
      )
        return null;
      return decideEgress({
        dataClass: classification,
        purpose,
        requiredRegion: null,
        profile: {
          ...egressFacts(candidate.profile),
          active: candidate.qualifying ? true : candidate.profile.status === 'active',
        },
        bundle,
        now: now(),
      });
    };
    const call = async (
      organizationId: string,
      route: ModelRoute,
      operation: KnowledgeOperation,
      signal: AbortSignal,
      metadata: ModelCallMetadata,
    ) => {
      if (
        organizationId !== context.organizationId ||
        !route.qualificationId ||
        route.purpose !== operation.purpose ||
        !metadata ||
        !Array.isArray(metadata.inputs) ||
        metadata.inputs.length > 1000 ||
        !/^[0-9a-f]{64}$/.test(metadata.operationKey)
      )
        throw denied();
      try {
        metadata = {
          operationKey: metadata.operationKey,
          inputs: normalizeModelInputs(metadata.inputs),
        };
      } catch {
        throw denied();
      }
      if (
        operation.purpose === 'embed' &&
        (operation.inputs.length < 1 ||
          operation.inputs.length > 128 ||
          operation.inputs.some((value) => typeof value !== 'string' || !value))
      )
        throw denied();
      if (
        operation.purpose === 'rerank' &&
        (typeof operation.query !== 'string' ||
          !operation.query ||
          operation.passages.length < 1 ||
          operation.passages.length > RETRIEVAL_CANDIDATES ||
          operation.passages.some((value) => typeof value !== 'string' || !value))
      )
        throw denied();
      if (
        operation.purpose === 'answer' &&
        (operation.messages.length > 1000 ||
          !operation.messages.some((value) => value.role === 'task') ||
          operation.messages.some(
            (value) =>
              typeof value.text !== 'string' ||
              !value.text ||
              !['policy', 'task', 'evidence'].includes(value.role),
          ))
      )
        throw denied();
      if (signal.aborted) throw unavailable();
      const entitlement = await deps.entitlements.check(context, 'model.call');
      if (!entitlement.ok) throw denied();
      const candidate = (await deps.store.candidates(principal, operation.purpose)).find((value) =>
        matches(value, route, operation.purpose),
      );
      if (!candidate) throw new ModelCallFailed('NO_APPROVED_MODEL');
      const profile = candidate.profile;
      if (
        entitlement.commercialMode !== 'cloud' &&
        profile.billingOwner === 'ensemus' &&
        !profile.crossBillingApproved
      )
        throw denied();
      const baseline = route.classification ?? 'restricted';
      let classification = strongestClass([
        baseline,
        ...metadata.inputs.map((value) => value.classification),
        ...(operation.purpose === 'answer'
          ? operation.messages.map((value) => value.classification)
          : []),
      ]);
      let messages: readonly KnowledgeMessage[] =
        operation.purpose === 'answer'
          ? operation.messages
          : operation.purpose === 'rerank'
            ? rankingMessages(operation.query, operation.passages, classification)
            : operation.inputs.map((text, index) => ({
                role: 'evidence',
                partId: `E${index}`,
                text,
                classification,
              }));
      const canaries = await deps.canaries();
      if (
        scanForSecrets(
          messages.map((message) => ({ id: message.partId, text: message.text })),
          canaries,
        ).hits.length
      )
        classification = 'restricted';
      const decision = allowed(
        candidate,
        operation.purpose,
        classification,
        await deps.bundle(principal),
      );
      if (!decision || decision.decision !== 'allow') throw denied();
      if (classification !== baseline)
        messages = messages.map((message) => ({
          ...message,
          classification: strongestClass([classification, message.classification]),
        }));
      const endpoint = checkEndpoint(profile.providerKind, profile.endpointUrl, {
        privateEndpoints: deps.privateEndpoints,
      });
      const protocol = protocolOf(profile.endpointUrl);
      if (!endpoint.ok || !protocol) throw denied();
      const fetch = deps.guard.fetchFor({
        host: endpoint.host,
        port: endpoint.port,
        protocol,
        viaPrivateAllowlist: endpoint.viaPrivateAllowlist,
      });
      const responseSchema =
        operation.purpose === 'rerank' ? rankingSchema(operation.passages.length) : null;
      // The full serialized data envelope bounds input bytes conservatively; output is explicitly
      // approved. No rate, token allowance or budget is supplied by the gateway.
      const inputTokens = Buffer.byteLength(
        JSON.stringify({
          messages,
          responseSchema,
          model: profile.modelId,
          ...(operation.purpose === 'embed' ? { dimension: operation.dimension } : {}),
        }),
        'utf8',
      );
      const outputTokens =
        operation.purpose === 'embed'
          ? 0
          : Math.min(candidate.bounds.maxOutputTokens, profile.limits.maxOutputTokens);
      if (
        inputTokens > candidate.bounds.maxInputTokens ||
        inputTokens > profile.limits.maxInputTokens ||
        candidate.deadlineAt.getTime() <= now().getTime()
      )
        throw new ModelCallFailed('BUDGET_EXHAUSTED');
      const requestHash = operationHash(operation);
      const claim = await deps.store.prepare(principal, {
        candidate,
        purpose: operation.purpose,
        classification,
        requestHash,
        metadata,
        ceiling: { inputTokens, outputTokens },
        policyVersion: decision.policyVersion,
        ...(candidate.qualifying ? { qualificationProofHash: requestHash } : {}),
      });
      if (claim.state !== 'prepared') {
        if (claim.state === 'dispatched') await deps.store.recoverUnknown(principal, claim.callId);
        throw unavailable();
      }
      const timeoutMs = Math.min(
        candidate.bounds.timeoutSeconds * 1000,
        candidate.deadlineAt.getTime() - now().getTime(),
      );
      if (timeoutMs <= 0) {
        await deps.store.settle(principal, claim.callId, {
          usage: null,
          mayHaveBilled: false,
          reasonCode: 'DEADLINE_REACHED',
        });
        throw unavailable();
      }
      let duplicate = false,
        claimed = false;
      let result: AdapterResult | Awaited<ReturnType<EmbeddingAdapter['embed']>>;
      const send = async (apiKey: Buffer | null) => {
        if (!(await deps.store.dispatch(principal, claim.callId))) {
          duplicate = true;
          throw unavailable();
        }
        claimed = true;
        try {
          return operation.purpose === 'embed'
            ? await deps.embeddings.embed(
                {
                  providerKind: profile.providerKind,
                  modelId: profile.modelId,
                  endpointUrl: profile.endpointUrl,
                  apiKey,
                  fetch,
                  timeoutMs,
                  inputs: operation.inputs,
                  dimension: operation.dimension,
                },
                signal,
              )
            : await deps.adapter.generate(
                {
                  providerKind: profile.providerKind,
                  modelId: profile.modelId,
                  endpointUrl: profile.endpointUrl,
                  apiKey,
                  fetch,
                  timeoutMs,
                  messages,
                  tools: [],
                  responseSchema,
                  maxOutputTokens: outputTokens,
                },
                signal,
              );
        } catch {
          return {
            kind: 'failure' as const,
            failure: 'unknown' as const,
            mayHaveBilled: true,
            usage: null,
          };
        }
      };
      try {
        if (profile.secretRef !== null)
          result = await deps.credentials.withKey(
            {
              organizationId: context.organizationId,
              profileId: profile.id,
              endpointUrl: profile.endpointUrl,
              secretRef: profile.secretRef,
              providerKind: profile.providerKind,
            },
            send,
          );
        else if (profile.providerKind === 'local_openai_compatible') result = await send(null);
        else throw unavailable();
      } catch {
        if (!duplicate)
          await deps.store.settle(principal, claim.callId, {
            usage: null,
            mayHaveBilled: claimed,
            reasonCode: 'CREDENTIAL_OR_DISPATCH_UNAVAILABLE',
          });
        throw unavailable();
      }
      const settled = await deps.store.settle(principal, claim.callId, {
        usage: result.usage,
        mayHaveBilled: result.kind === 'failure' ? result.mayHaveBilled : true,
        reasonCode: result.kind === 'failure' ? `ADAPTER_${result.failure.toUpperCase()}` : null,
      });
      const usage = { ...settled, classification };
      if (result.kind === 'failure' || signal.aborted) throw unavailable();
      if (
        result.usage &&
        (result.usage.inputTokens > inputTokens || result.usage.outputTokens > outputTokens)
      )
        throw unavailable();
      await deps.store.assertResultFresh(principal, claim.callId);
      if (result.kind === 'embedded')
        return { kind: 'embed' as const, vectors: result.vectors, usage };
      if (
        result.kind !== 'final' ||
        scanForSecrets([{ id: 'output', text: result.text }], canaries).hits.length
      )
        throw unavailable();
      if (operation.purpose === 'rerank') {
        let value: unknown;
        try {
          value = JSON.parse(result.text);
        } catch {
          throw unavailable();
        }
        if (
          typeof value !== 'object' ||
          value === null ||
          !('order' in value) ||
          Object.keys(value).length !== 1 ||
          !validRanking(value.order, operation.passages.length)
        )
          throw unavailable();
        return { kind: 'rerank' as const, order: value.order, usage };
      }
      return { kind: 'answer' as const, text: result.text, usage };
    };
    return {
      recordsCalls: true,
      async route(request) {
        if (request.organizationId !== context.organizationId)
          return { decision: 'deny', reasonCode: 'EGRESS_DENIED', policyVersion: 'unavailable' };
        try {
          const bundle = await deps.bundle(principal);
          for (const candidate of await deps.store.candidates(principal, request.purpose)) {
            const decision = allowed(candidate, request.purpose, request.classification, bundle);
            if (!decision || decision.decision !== 'allow') continue;
            const q = candidate.qualification,
              p = candidate.profile,
              destinationHost = hostOf(p.endpointUrl);
            if (!destinationHost) continue;
            if (
              request.spaceHint &&
              (request.spaceHint.modelId !== p.modelId ||
                request.spaceHint.dimension !== q.dimension ||
                request.spaceHint.vectorSpaceVersion !== q.vectorSpaceVersion ||
                request.spaceHint.modelProfileRef !== p.id ||
                request.spaceHint.modelProfileVersion !== p.version ||
                request.spaceHint.qualificationId !== q.id)
            )
              continue;
            return {
              decision: 'allow',
              route: {
                modelProfileRef: p.id,
                modelProfileVersion: p.version,
                modelId: p.modelId,
                providerKind: p.providerKind,
                destinationHost,
                policyVersion: decision.policyVersion,
                qualificationId: q.id,
                purpose: request.purpose,
                classification: request.classification,
                ...(request.purpose === 'embed' && q.dimension && q.vectorSpaceVersion
                  ? {
                      embedding: {
                        dimension: q.dimension,
                        vectorSpaceVersion: q.vectorSpaceVersion,
                      },
                    }
                  : {}),
              },
            };
          }
          return {
            decision: 'deny',
            reasonCode: 'NO_APPROVED_MODEL',
            policyVersion: 'unavailable',
          };
        } catch {
          return { decision: 'deny', reasonCode: 'EGRESS_DENIED', policyVersion: 'unavailable' };
        }
      },
      async embed(org, route, inputs, signal, metadata) {
        if (!route.embedding) throw new ModelCallFailed('SPACE_MISMATCH');
        const result = await call(
          org,
          route,
          { purpose: 'embed', inputs: [...inputs], dimension: route.embedding.dimension },
          signal,
          metadata,
        );
        if (result.kind !== 'embed') throw unavailable();
        return { vectors: result.vectors, usage: result.usage };
      },
      async rerank(org, route, query, passages, signal, metadata) {
        const result = await call(
          org,
          route,
          { purpose: 'rerank', query, passages: [...passages] },
          signal,
          metadata,
        );
        if (result.kind !== 'rerank') throw unavailable();
        return { order: result.order, usage: result.usage };
      },
      async answer(org, route, messages, signal, metadata) {
        const result = await call(
          org,
          route,
          { purpose: 'answer', messages: messages.map((value) => ({ ...value })) },
          signal,
          metadata,
        );
        if (result.kind !== 'answer') throw unavailable();
        return { text: result.text, usage: result.usage };
      },
    };
  };
}
