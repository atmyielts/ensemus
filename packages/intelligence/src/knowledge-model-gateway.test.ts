import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeModelGateway } from './knowledge-model-gateway';
import { operationKey } from '@ensemus/knowledge/model-operations';
import type {
  KnowledgeCallStore,
  KnowledgeModelCandidate,
  KnowledgeModelPrincipal,
  PrepareKnowledgeCall,
} from '@ensemus/application/ai-knowledge-ports';
import type { TenantContext } from '@ensemus/application/ai-ports';
import type { ResidencyGate } from '@ensemus/application';
import type { KnowledgeModelPurpose } from '@ensemus/domain/knowledge-models';
import { protocolForPurpose } from '@ensemus/domain/knowledge-models';
import { ModelCallFailed } from '@ensemus/knowledge/ports';
import { agentContext, byomProfile } from './router/doubles.test-support';
import type { RerankAdapterCall, RerankAdapterResult } from './rerank-adapter';
import type { AdapterResult } from './types';

const endpoint = 'http://generated-model.internal:8080/v1';
function fixture(
  options: {
    priorState?: string;
    duplicate?: boolean;
    prepareDenied?: boolean;
    freshDenied?: boolean;
    profileChanged?: boolean;
    keyDenied?: boolean;
    checkResidency?: ResidencyGate['check'];
    canary?: string;
    denyRestricted?: boolean;
    output?: AdapterResult;
    /** A Cohere profile, which ranks on its native endpoint, and what that answers. */
    native?: { result?: RerankAdapterResult };
  } = {},
) {
  const context = { ...agentContext(), actorType: 'delegated' } as unknown as TenantContext;
  const principal: KnowledgeModelPrincipal = { kind: 'job', context, jobId: 'generated-job' };
  let calls = 0,
    embeds = 0,
    generates = 0,
    prepared = 0,
    settled = 0,
    recovered = 0,
    dispatched = 0,
    lent = 0,
    reranked = 0;
  let rerankCall: RerankAdapterCall | undefined;
  let preparedInput: PrepareKnowledgeCall | undefined;
  const candidate = (purpose: KnowledgeModelPurpose): KnowledgeModelCandidate => ({
    profile: byomProfile({
      id: 'generated-profile',
      version: options.profileChanged ? 2 : 1,
      providerKind: 'local_openai_compatible',
      endpointUrl: endpoint,
      billingOwner: 'customer',
      secretRef: options.keyDenied ? 'generated-key' : null,
      destination: 'customer_private_inference',
      retentionBasis: 'self_hosted',
      region: null,
      capabilities: ['text', 'structured_output'],
      allowedClasses: ['public', 'internal', 'confidential', 'restricted'],
      allowedPurposes: ['embed', 'rerank', 'answer'],
      limits: { maxInputTokens: 10000, maxOutputTokens: 64 },
      ...(options.native
        ? {
            providerKind: 'cohere_hosted' as const,
            modelId: 'rerank-v3.5',
            endpointUrl: 'https://api.cohere.com/v2',
            secretRef: 'generated-key',
            destination: 'customer_byom_public_api' as const,
            retentionBasis: 'unreviewed' as const,
            capabilities: ['text' as const],
            allowedPurposes: ['rerank' as const],
          }
        : {}),
    }),
    qualification: {
      id: `qualified-${purpose}`,
      profileId: 'generated-profile',
      profileVersion: 1,
      purpose,
      protocol: protocolForPurpose(purpose),
      state: 'passed',
      dimension: purpose === 'embed' ? 3 : null,
      vectorSpaceVersion: purpose === 'embed' ? 'generated-v1' : null,
    },
    rateCard: {
      id: 'generated-card',
      version: 1,
      inputMicrosPerMtok: 17,
      outputMicrosPerMtok: 31,
      source: 'tenant_estimate',
    },
    approvalId: 'generated-approval',
    bounds: {
      maxCalls: 7,
      maxInputTokens: 10000,
      maxOutputTokens: 64,
      maxTotalTokens: 20000,
      maxCostMicros: 5000,
      timeoutSeconds: 37,
    },
    deadlineAt: new Date(Date.now() + 37000),
    qualifying: false,
  });
  const store: KnowledgeCallStore = {
    async candidates(_principal, purpose) {
      calls++;
      return [candidate(purpose)];
    },
    async prepare(_principal, input) {
      prepared++;
      preparedInput = input;
      if (options.prepareDenied) throw new ModelCallFailed('BUDGET_EXHAUSTED');
      return { callId: 'generated-call', state: options.priorState ?? 'prepared' };
    },
    async dispatch() {
      dispatched++;
      return !options.duplicate;
    },
    async settle(_principal, _id, input) {
      settled++;
      return {
        inputTokens: input.usage?.inputTokens ?? 0,
        outputTokens: input.usage?.outputTokens ?? 0,
        costMicros: input.mayHaveBilled ? 1 : 0,
        callId: 'generated-call',
      };
    },
    async recoverUnknown() {
      recovered++;
    },
    async assertResultFresh() {
      if (options.freshDenied) throw new ModelCallFailed('EGRESS_DENIED');
    },
  };
  const model = createKnowledgeModelGateway({
    residency: {
      check: options.checkResidency ?? (async () => ({ allowed: true, requiredRegion: null })),
    },
    store,
    entitlements: {
      check: async () => ({ ok: true, billable: false, commercialMode: 'sovereign' }),
    },
    credentials: {
      withKey: async (_ref, use) => {
        lent++;
        if (options.keyDenied) throw new Error('GENERATED_KEY_TEXT');
        return use(Buffer.from('generated'));
      },
    },
    guard: {
      fetchFor: () => async () => {
        throw new Error('TEST_NETWORK_FORBIDDEN');
      },
    },
    privateEndpoints: [endpoint],
    canaries: async () => (options.canary ? [options.canary] : []),
    bundle: async () =>
      options.denyRestricted
        ? {
            version: 'generated-policy',
            denyClasses: { customer_private_inference: ['restricted'] },
          }
        : null,
    reranks: {
      rerank: async (call) => {
        reranked++;
        rerankCall = call;
        return (
          options.native?.result ?? {
            kind: 'ranked',
            order: [1, 0],
            usage: { inputTokens: 9, outputTokens: 0 },
          }
        );
      },
    },
    embeddings: {
      embed: async (call) => {
        embeds++;
        return {
          kind: 'embedded',
          vectors: call.inputs.map(() => [1, 0, 0]),
          usage: { inputTokens: 3, outputTokens: 0 },
        };
      },
    },
    adapter: {
      generate: async () => {
        generates++;
        return (
          options.output ?? {
            kind: 'final',
            text: '{"order":[1,0]}',
            usage: { inputTokens: 11, outputTokens: 5 },
          }
        );
      },
    },
  })(principal);
  const metadata = { operationKey: operationKey(['generated-operation']), inputs: [] };
  return {
    context,
    model,
    metadata,
    get preparedInput() {
      return preparedInput;
    },
    get rerankCall() {
      return rerankCall;
    },
    counts: () => ({
      calls,
      embeds,
      generates,
      prepared,
      settled,
      recovered,
      dispatched,
      lent,
      reranked,
    }),
  };
}
describe('genuine Knowledge model gateway controls', () => {
  it.each([false, true])(
    'fences an unknown embedding location before provider dispatch (after preparation: %s)',
    async (afterPreparation) => {
      const check = vi
        .fn<ResidencyGate['check']>()
        .mockResolvedValue({
          allowed: false,
          requiredRegion: 'test-region-a',
          code: 'TARGET_REGION_UNKNOWN',
        });
      if (afterPreparation) check.mockResolvedValueOnce({ allowed: true, requiredRegion: null });
      const f = fixture({ checkResidency: check });
      const route = await f.model.route({
        organizationId: f.context.organizationId,
        purpose: 'embed',
        classification: 'internal',
      });
      if (route.decision !== 'allow') throw new Error('TEST_ROUTE_REFUSED');
      await expect(
        f.model.embed(
          f.context.organizationId,
          route.route,
          ['generated passage'],
          new AbortController().signal,
          f.metadata,
        ),
      ).rejects.toMatchObject({ code: 'EGRESS_DENIED' });
      expect(check).toHaveBeenLastCalledWith(f.context, {
        surface: 'embeddings',
        classification: 'internal',
        targetRegion: null,
      });
      expect(f.counts()).toMatchObject({
        prepared: Number(afterPreparation),
        settled: Number(afterPreparation),
        dispatched: 0,
        embeds: 0,
        lent: 0,
      });
    },
  );
  it('uses the actual embedding adapter under embed and structured ranking under rerank', async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    const e = await f.model.route({
      organizationId: f.context.organizationId,
      purpose: 'embed',
      classification: 'internal',
    });
    expect(e.decision).toBe('allow');
    if (e.decision !== 'allow') return;
    expect(
      await f.model.embed(f.context.organizationId, e.route, ['generated'], signal, f.metadata),
    ).toMatchObject({ vectors: [[1, 0, 0]], usage: { callId: 'generated-call' } });
    expect(f.preparedInput?.purpose).toBe('embed');
    expect(f.counts()).toMatchObject({ embeds: 1, generates: 0 });
    const r = await f.model.route({
      organizationId: f.context.organizationId,
      purpose: 'rerank',
      classification: 'internal',
    });
    if (r.decision !== 'allow') throw new Error('TEST_ROUTE_REFUSED');
    expect(
      await f.model.rerank(
        f.context.organizationId,
        r.route,
        'generated question',
        ['first', 'second'],
        signal,
        f.metadata,
      ),
    ).toMatchObject({ order: [1, 0] });
    expect(f.preparedInput?.purpose).toBe('rerank');
    expect(f.counts()).toMatchObject({ embeds: 1, generates: 1 });
  });
  it('does not treat a profile name at another version as a qualification', async () => {
    const f = fixture({ profileChanged: true });
    expect(
      await f.model.route({
        organizationId: f.context.organizationId,
        purpose: 'embed',
        classification: 'internal',
      }),
    ).toMatchObject({ decision: 'deny' });
    expect(f.counts()).toMatchObject({ prepared: 0, embeds: 0, generates: 0 });
  });
  it.each(['dispatched', 'unknown', 'response_received', 'accepted', 'refused'])(
    'never resends a durable %s attempt',
    async (state) => {
      const f = fixture({ priorState: state }),
        r = await f.model.route({
          organizationId: f.context.organizationId,
          purpose: 'embed',
          classification: 'internal',
        });
      if (r.decision !== 'allow') throw new Error('TEST_ROUTE_REFUSED');
      await expect(
        f.model.embed(
          f.context.organizationId,
          r.route,
          ['generated'],
          new AbortController().signal,
          f.metadata,
        ),
      ).rejects.toThrow('MODEL_UNAVAILABLE');
      expect(f.counts()).toMatchObject({
        embeds: 0,
        generates: 0,
        dispatched: 0,
        recovered: state === 'dispatched' ? 1 : 0,
      });
    },
  );
  it('does not settle another live worker’s duplicate claim as a free refusal', async () => {
    const f = fixture({ duplicate: true }),
      r = await f.model.route({
        organizationId: f.context.organizationId,
        purpose: 'embed',
        classification: 'internal',
      });
    if (r.decision !== 'allow') throw new Error('TEST_ROUTE_REFUSED');
    await expect(
      f.model.embed(
        f.context.organizationId,
        r.route,
        ['generated'],
        new AbortController().signal,
        f.metadata,
      ),
    ).rejects.toThrow();
    expect(f.counts()).toMatchObject({ embeds: 0, settled: 0, dispatched: 1 });
  });
  it('refuses an unavailable budget before key or model use', async () => {
    const f = fixture({ prepareDenied: true }),
      r = await f.model.route({
        organizationId: f.context.organizationId,
        purpose: 'embed',
        classification: 'internal',
      });
    if (r.decision !== 'allow') throw new Error('TEST_ROUTE_REFUSED');
    await expect(
      f.model.embed(
        f.context.organizationId,
        r.route,
        ['generated'],
        new AbortController().signal,
        f.metadata,
      ),
    ).rejects.toThrow('BUDGET_EXHAUSTED');
    expect(f.counts()).toMatchObject({ lent: 0, dispatched: 0, embeds: 0 });
  });
  it('raises secret-bearing material and reapplies the actual tenant bundle before dispatch', async () => {
    const canary = 'GENERATED_PRIVATE_CANARY',
      f = fixture({ canary, denyRestricted: true }),
      r = await f.model.route({
        organizationId: f.context.organizationId,
        purpose: 'embed',
        classification: 'internal',
      });
    if (r.decision !== 'allow') throw new Error('TEST_ROUTE_REFUSED');
    await expect(
      f.model.embed(
        f.context.organizationId,
        r.route,
        [canary],
        new AbortController().signal,
        f.metadata,
      ),
    ).rejects.toThrow('EGRESS_DENIED');
    expect(f.counts()).toMatchObject({ prepared: 0, embeds: 0, lent: 0 });
  });
  it('accounts paid output but refuses invalid structured positions and a late ACL closure', async () => {
    for (const f of [
      fixture({
        output: {
          kind: 'final',
          text: '{"order":[0,0]}',
          usage: { inputTokens: 3, outputTokens: 2 },
        },
      }),
      fixture({ freshDenied: true }),
    ]) {
      const r = await f.model.route({
        organizationId: f.context.organizationId,
        purpose: 'rerank',
        classification: 'internal',
      });
      if (r.decision !== 'allow') throw new Error('TEST_ROUTE_REFUSED');
      await expect(
        f.model.rerank(
          f.context.organizationId,
          r.route,
          'generated',
          ['first', 'second'],
          new AbortController().signal,
          f.metadata,
        ),
      ).rejects.toThrow();
      expect(f.counts()).toMatchObject({ generates: 1, settled: 1 });
    }
  });
  it('releases an unstarted key failure without provider use or provider text', async () => {
    const f = fixture({ keyDenied: true }),
      r = await f.model.route({
        organizationId: f.context.organizationId,
        purpose: 'embed',
        classification: 'internal',
      });
    if (r.decision !== 'allow') throw new Error('TEST_ROUTE_REFUSED');
    await expect(
      f.model.embed(
        f.context.organizationId,
        r.route,
        ['generated'],
        new AbortController().signal,
        f.metadata,
      ),
    ).rejects.toThrow('MODEL_UNAVAILABLE');
    expect(f.counts()).toMatchObject({ dispatched: 0, settled: 1, embeds: 0, lent: 1 });
  });
  it('rejects another tenant without resolving candidates', async () => {
    const f = fixture();
    expect(
      await f.model.route({
        organizationId: 'different-tenant',
        purpose: 'answer',
        classification: 'internal',
      }),
    ).toMatchObject({ decision: 'deny' });
    expect(f.counts().calls).toBe(0);
  });
  describe('native rerank, for a kind that has one', () => {
    const rerank = async (f: ReturnType<typeof fixture>, passages = ['first', 'second']) => {
      const r = await f.model.route({
        organizationId: f.context.organizationId,
        purpose: 'rerank',
        classification: 'public',
      });
      if (r.decision !== 'allow') throw new Error('TEST_ROUTE_REFUSED');
      return f.model.rerank(
        f.context.organizationId,
        r.route,
        'generated question',
        passages,
        new AbortController().signal,
        f.metadata,
      );
    };

    it('ranks on the native endpoint, with the lent key, no prompt and no output allowance', async () => {
      const f = fixture({ native: {} });
      expect(await rerank(f)).toMatchObject({ order: [1, 0], usage: { inputTokens: 9 } });
      expect(f.counts()).toMatchObject({ reranked: 1, generates: 0, embeds: 0, lent: 1 });
      expect(f.rerankCall).toMatchObject({
        providerKind: 'cohere_hosted',
        modelId: 'rerank-v3.5',
        endpointUrl: 'https://api.cohere.com/v2',
        query: 'generated question',
        documents: ['first', 'second'],
      });
      expect(f.preparedInput?.ceiling.outputTokens).toBe(0);
    });

    it('keeps the prompt ranking for every other kind', async () => {
      const f = fixture();
      const r = await f.model.route({
        organizationId: f.context.organizationId,
        purpose: 'rerank',
        classification: 'internal',
      });
      if (r.decision !== 'allow') throw new Error('TEST_ROUTE_REFUSED');
      await f.model.rerank(
        f.context.organizationId,
        r.route,
        'generated question',
        ['first', 'second'],
        new AbortController().signal,
        f.metadata,
      );
      expect(f.counts()).toMatchObject({ reranked: 0, generates: 1 });
    });

    it.each<[string, RerankAdapterResult]>([
      ['a ranking that repeats a passage', { kind: 'ranked', order: [0, 0], usage: null }],
      ['a ranking out of range', { kind: 'ranked', order: [2, 0], usage: null }],
      ['a failure', { kind: 'failure', failure: 'rate_limited', mayHaveBilled: true, usage: null }],
    ])('refuses %s, and settles the call as billed', async (_label, result) => {
      const f = fixture({ native: { result } });
      await expect(rerank(f)).rejects.toThrow('MODEL_UNAVAILABLE');
      expect(f.counts()).toMatchObject({ reranked: 1, settled: 1, generates: 0 });
    });
  });
});
