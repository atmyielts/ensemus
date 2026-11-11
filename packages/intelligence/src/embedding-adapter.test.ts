import { describe, expect, it, vi } from 'vitest';
import {
  createEmbeddingAdapter,
  indexedEmbeddings,
  orderedEmbeddings,
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

describe('Gemini native embeddings', () => {
  const gemini = (
    inputs: readonly string[],
    reply: (url: string, body: Record<string, unknown>) => Response,
  ) => {
    const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const call: EmbeddingAdapterCall = {
      providerKind: 'gemini_hosted',
      modelId: 'gemini-embedding-001',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: Buffer.from('generated-gemini-key'),
      timeoutMs: 2000,
      inputs,
      dimension: 3,
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push({ url: String(url), headers: new Headers(init?.headers), body });
        return reply(String(url), body);
      },
    };
    return { call, sent };
  };
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  it('uses batchEmbedContents for several texts, in input order, with the key in its header', async () => {
    const { call, sent } = gemini(['generated first', 'generated second'], () =>
      ok({ embeddings: [{ values: [1, 0, 0] }, { values: [0, 1, 0] }] }),
    );
    const result = await createEmbeddingAdapter().embed(call, new AbortController().signal);
    expect(result).toEqual({
      kind: 'embedded',
      vectors: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      usage: null,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
    );
    expect(sent[0]?.headers.get('x-goog-api-key')).toBe('generated-gemini-key');
    expect(sent[0]?.body).toMatchObject({
      requests: [
        { model: 'models/gemini-embedding-001', outputDimensionality: 3 },
        { model: 'models/gemini-embedding-001', outputDimensionality: 3 },
      ],
    });
  });

  it('uses embedContent for one text', async () => {
    const { call, sent } = gemini(['generated only'], () =>
      ok({ embedding: { values: [0, 0, 1] } }),
    );
    const result = await createEmbeddingAdapter().embed(call, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'embedded', vectors: [[0, 0, 1]] });
    expect(sent[0]?.url).toMatch(/:embedContent$/);
  });

  it.each([
    ['one vector short', { embeddings: [{ values: [1, 0, 0] }] }],
    ['a vector of the wrong size', { embeddings: [{ values: [1, 0] }, { values: [0, 1, 0] }] }],
    ['a zero vector', { embeddings: [{ values: [0, 0, 0] }, { values: [0, 1, 0] }] }],
    ['the wrong shape', { data: [] }],
  ])('refuses %s, as billed', async (_label, body) => {
    const { call } = gemini(['generated first', 'generated second'], () => ok(body));
    expect(await createEmbeddingAdapter().embed(call, new AbortController().signal)).toMatchObject({
      kind: 'failure',
      failure: 'malformed_response',
      mayHaveBilled: true,
    });
  });

  it('never takes a key from the environment, and refuses a model ID that is a path', async () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'GENERATED-ENV-KEY');
    try {
      for (const overrides of [{ apiKey: null }, { modelId: 'tunedModels/other' }]) {
        const { call, sent } = gemini(['generated'], () => ok({}));
        const result = await createEmbeddingAdapter().embed(
          { ...call, ...overrides },
          new AbortController().signal,
        );
        expect(result).toMatchObject({ kind: 'failure', mayHaveBilled: false });
        expect(sent).toHaveLength(0);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('maps a 429 to rate_limited, with one request', async () => {
    const { call, sent } = gemini(
      ['generated'],
      () =>
        new Response(JSON.stringify({ error: { code: 429, message: 'generated quota text' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await createEmbeddingAdapter().embed(call, new AbortController().signal);
    expect(result).toEqual({
      kind: 'failure',
      failure: 'rate_limited',
      mayHaveBilled: true,
      usage: null,
    });
    expect(sent).toHaveLength(1);
  });

  it('keeps every kind with no embedding endpoint here off the network', async () => {
    for (const providerKind of [
      'azure_openai',
      'bedrock_hosted',
      'cohere_hosted',
      'voyage_hosted',
    ] as const) {
      const { call, sent } = gemini(['generated'], () => ok({}));
      expect(
        await createEmbeddingAdapter().embed(
          { ...call, providerKind },
          new AbortController().signal,
        ),
      ).toMatchObject({ failure: 'bad_request', mayHaveBilled: false });
      expect(sent).toHaveLength(0);
    }
  });

  it('checks the count and size of positional vectors', () => {
    expect(orderedEmbeddings([[1, 0, 0]], 1, 3)).toEqual([[1, 0, 0]]);
    expect(orderedEmbeddings([[1, 0, 0]], 2, 3)).toBeNull();
    expect(orderedEmbeddings('nope', 1, 3)).toBeNull();
  });
});
