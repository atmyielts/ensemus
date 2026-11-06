// Test doubles for the model port. Lint keeps this out of apps/ and workers/, so none of it can reach a
// shipped image. Foundation wrote this because every slice tests against it: it counts calls, so a test can
// assert that a denial contacted nobody.
import type {
  AnswerResult,
  EmbedResult,
  KnowledgeMessage,
  KnowledgeModelPort,
  ModelRoute,
  RerankResult,
  RouteDecision,
  RouteRequest,
} from '../ports';

export const FAKE_POLICY_VERSION = 'test-policy-1';

export const fakeRoute = (overrides: Partial<ModelRoute> = {}): ModelRoute => ({
  modelProfileRef: '00000000-0000-4000-8000-000000000e01',
  modelProfileVersion: 1,
  modelId: 'fake-embedding',
  providerKind: 'local_openai_compatible',
  destinationHost: 'fake-model.invalid',
  policyVersion: FAKE_POLICY_VERSION,
  embedding: { dimension: 4, vectorSpaceVersion: 'v1' },
  ...overrides,
});

export type ScriptedModelPort = KnowledgeModelPort & {
  /** Each call, in order. A denial should leave only `route` here. */
  readonly calls: { method: 'route' | 'embed' | 'rerank' | 'answer'; purpose?: string }[];
};

/** The same text always gets the same vector, with nothing outside this process involved. */
export function deterministicVector(text: string, dimension: number): number[] {
  const vector = Array.from({ length: dimension }, () => 0);
  for (let i = 0; i < text.length; i += 1) {
    const slot = i % dimension;
    vector[slot] = (vector[slot] ?? 0) + text.charCodeAt(i) / 1000;
  }
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

export function createScriptedModelPort(script: {
  route?: (request: RouteRequest) => RouteDecision;
  embed?: (inputs: readonly string[]) => EmbedResult;
  rerank?: (query: string, passages: readonly string[]) => RerankResult;
  answer?: (messages: readonly KnowledgeMessage[]) => AnswerResult;
}): ScriptedModelPort {
  const calls: ScriptedModelPort['calls'] = [];
  const usage = { inputTokens: 1, outputTokens: 1, costMicros: null };
  return {
    calls,
    async route(request) {
      calls.push({ method: 'route', purpose: request.purpose });
      return script.route?.(request) ?? { decision: 'allow', route: fakeRoute() };
    },
    async embed(_organizationId, route, inputs) {
      calls.push({ method: 'embed' });
      return (
        script.embed?.(inputs) ?? {
          vectors: inputs.map((text) => deterministicVector(text, route.embedding?.dimension ?? 4)),
          usage,
        }
      );
    },
    async rerank(_organizationId, _route, query, passages) {
      calls.push({ method: 'rerank' });
      return script.rerank?.(query, passages) ?? { order: passages.map((_, i) => i), usage };
    },
    async answer(_organizationId, _route, messages) {
      calls.push({ method: 'answer' });
      return script.answer?.(messages) ?? { text: '', usage };
    },
  };
}
