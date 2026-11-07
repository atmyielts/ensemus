import { describe, expect, it } from 'vitest';
import {
  createEmbeddingAdapter,
  indexedEmbeddings,
  type EmbeddingAdapterCall,
} from './embedding-adapter';
const response = (data: unknown, usage: unknown = { prompt_tokens: 13 }) =>
  new Response(JSON.stringify({ object: 'list', data, model: 'generated-embedding', usage }), {
    headers: { 'content-type': 'application/json' },
  });
const base: EmbeddingAdapterCall = {
  providerKind: 'local_openai_compatible',
  modelId: 'generated-embedding',
  endpointUrl: 'http://generated-model.invalid/v1',
  apiKey: null,
  timeoutMs: 2000,
  inputs: ['generated first', 'generated second'],
  dimension: 3,
  fetch: async () =>
    response([
      { index: 1, embedding: [1, 0, 0] },
      { index: 0, embedding: [0, 1, 0] },
    ]),
};
describe('actual native embedding adapter', () => {
  it('sends exactly one native request and orders explicit response indices', async () => {
    let calls = 0;
    const result = await createEmbeddingAdapter().embed(
      {
        ...base,
        fetch: async (url, init) => {
          calls++;
          expect(String(url)).toBe('http://generated-model.invalid/v1/embeddings');
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.input).toEqual(base.inputs);
          expect(body.dimensions).toBe(3);
          return base.fetch(url, init);
        },
      },
      new AbortController().signal,
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      kind: 'embedded',
      vectors: [
        [0, 1, 0],
        [1, 0, 0],
      ],
      usage: { inputTokens: 13, outputTokens: 0 },
    });
  });
  it('refuses missing, duplicate, malformed and wrong-dimension positions', () => {
    for (const data of [
      [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }],
      [
        { index: 0, embedding: [1, 0, 0] },
        { index: 0, embedding: [0, 1, 0] },
      ],
      [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [0, 1, 0] },
      ],
      [
        { index: 0, embedding: [0, 0, 0] },
        { index: 1, embedding: [0, 1, 0] },
      ],
    ])
      expect(indexedEmbeddings({ data }, 2, 3)).toBeNull();
  });
  it('does not retry unknown paid failures or expose provider text', async () => {
    let calls = 0;
    const canary = 'GENERATED-PRIVATE-PROVIDER-TEXT';
    const result = await createEmbeddingAdapter().embed(
      {
        ...base,
        fetch: async () => {
          calls++;
          throw new Error(canary);
        },
      },
      new AbortController().signal,
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({ kind: 'failure', mayHaveBilled: true });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
  it('refuses unsupported protocol, absent hosted key and cancellation before network', async () => {
    let calls = 0;
    const call = {
      ...base,
      fetch: async () => {
        calls++;
        return response([]);
      },
    };
    await createEmbeddingAdapter().embed(
      { ...call, providerKind: 'anthropic_hosted' },
      new AbortController().signal,
    );
    await createEmbeddingAdapter().embed(
      { ...call, providerKind: 'openai_hosted' },
      new AbortController().signal,
    );
    await createEmbeddingAdapter().embed(call, AbortSignal.abort());
    expect(calls).toBe(0);
  });
});
