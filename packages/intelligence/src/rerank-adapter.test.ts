import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRerankAdapter, rankedOrder, type RerankAdapterCall } from './rerank-adapter';

const KEY = 'generated-rerank-key-0001';
const PROMPT = 'GENERATED-PRIVATE-QUESTION';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Sent = { url: string; init: RequestInit | undefined; body: Record<string, unknown> };

function call(
  overrides: Partial<RerankAdapterCall> = {},
  reply: (sent: Sent) => Response | Promise<Response> = () =>
    json(200, {
      id: 'r',
      results: [
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.5 },
        { index: 1, relevance_score: 0.1 },
      ],
      meta: { billed_units: { search_units: 1 } },
    }),
) {
  const sent: Sent[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const entry = {
      url: String(input),
      init,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    sent.push(entry);
    return reply(entry);
  }) as typeof globalThis.fetch;
  const value: RerankAdapterCall = {
    providerKind: 'cohere_hosted',
    modelId: 'rerank-v3.5',
    endpointUrl: 'https://api.cohere.com/v2',
    apiKey: Buffer.from(KEY),
    timeoutMs: 2_000,
    query: PROMPT,
    documents: ['first', 'second', 'third'],
    fetch,
    ...overrides,
  };
  return { value, sent };
}

const rerank = (value: RerankAdapterCall, signal = new AbortController().signal) =>
  createRerankAdapter().rerank(value, signal);

afterEach(() => vi.unstubAllEnvs());

describe('Cohere-style native rerank', () => {
  it('sends one request to /rerank with every document asked for, and orders by score', async () => {
    const { value, sent } = call();
    expect(await rerank(value)).toEqual({ kind: 'ranked', order: [2, 0, 1], usage: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://api.cohere.com/v2/rerank');
    expect(sent[0]?.init?.method).toBe('POST');
    expect(sent[0]?.init?.redirect).toBe('error');
    expect(new Headers(sent[0]?.init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(sent[0]?.body).toEqual({
      model: 'rerank-v3.5',
      query: PROMPT,
      documents: ['first', 'second', 'third'],
      top_n: 3,
    });
  });
});

describe('Voyage-style native rerank', () => {
  it('asks for every document with truncation off, and reports its token usage', async () => {
    const { value, sent } = call(
      {
        providerKind: 'voyage_hosted',
        modelId: 'rerank-2.5',
        endpointUrl: 'https://api.voyageai.com/v1/',
      },
      () =>
        json(200, {
          object: 'list',
          data: [
            { index: 1, relevance_score: 0.7 },
            { index: 2, relevance_score: 0.7 },
            { index: 0, relevance_score: 0.2 },
          ],
          model: 'rerank-2.5',
          usage: { total_tokens: 42 },
        }),
    );
    expect(await rerank(value)).toEqual({
      kind: 'ranked',
      // A tie keeps index order, so the same answer always gives the same ranking.
      order: [1, 2, 0],
      usage: { inputTokens: 42, outputTokens: 0 },
    });
    expect(sent[0]?.url).toBe('https://api.voyageai.com/v1/rerank');
    expect(sent[0]?.body).toEqual({
      model: 'rerank-2.5',
      query: PROMPT,
      documents: ['first', 'second', 'third'],
      top_k: 3,
      truncation: false,
    });
  });

  it('treats nonsense usage as unknown', async () => {
    const { value } = call({ providerKind: 'voyage_hosted', modelId: 'rerank-2' }, () =>
      json(200, {
        data: [
          { index: 0, relevance_score: 1 },
          { index: 1, relevance_score: 0 },
          { index: 2, relevance_score: 0.5 },
        ],
        usage: { total_tokens: -5 },
      }),
    );
    expect(await rerank(value)).toMatchObject({ kind: 'ranked', usage: null });
  });
});

describe('a ranking is trusted for nothing', () => {
  const row = (index: unknown, relevance_score: unknown) => ({ index, relevance_score });
  it.each([
    ['too few rows', [row(0, 1), row(1, 0.5)]],
    ['too many rows', [row(0, 1), row(1, 0.5), row(2, 0.1), row(2, 0.1)]],
    ['a repeated index', [row(0, 1), row(0, 0.5), row(1, 0.1)]],
    ['an index out of range', [row(0, 1), row(1, 0.5), row(3, 0.1)]],
    ['a negative index', [row(0, 1), row(1, 0.5), row(-1, 0.1)]],
    ['a fractional index', [row(0, 1), row(1, 0.5), row(1.5, 0.1)]],
    ['an index as text', [row(0, 1), row(1, 0.5), row('2', 0.1)]],
    ['a score as text', [row(0, 1), row(1, 0.5), row(2, '0.1')]],
    ['a missing score', [row(0, 1), row(1, 0.5), { index: 2 }]],
    ['a row that is not an object', [row(0, 1), row(1, 0.5), 2]],
    ['not a list', { 0: row(0, 1) }],
  ])('refuses %s', (_label, rows) => {
    expect(rankedOrder(rows, 3)).toBeNull();
  });

  it('refuses scores that are not finite, which JSON cannot carry but a parser could make', () => {
    expect(rankedOrder([row(0, Number.NaN), row(1, 1), row(2, 0)], 3)).toBeNull();
    expect(rankedOrder([row(0, Number.POSITIVE_INFINITY), row(1, 1), row(2, 0)], 3)).toBeNull();
  });

  it.each([
    ['rows of the wrong shape', { results: [{ index: 0 }, { index: 1 }, { index: 2 }] }],
    ['the wrong list for the kind', { data: [{ index: 0, relevance_score: 1 }] }],
    ['a list instead of an object', [{ index: 0, relevance_score: 1 }]],
    ['null', null],
  ])('maps %s to malformed_response, as billed', async (_label, body) => {
    const { value } = call({}, () => json(200, body));
    expect(await rerank(value)).toEqual({
      kind: 'failure',
      failure: 'malformed_response',
      mayHaveBilled: true,
      usage: null,
    });
  });

  it('maps a body that is not JSON to malformed_response', async () => {
    const { value } = call({}, () => new Response('{"results": [', { status: 200 }));
    expect(await rerank(value)).toMatchObject({ failure: 'malformed_response' });
  });
});

describe('failures are codes, with no provider text and no retry', () => {
  it.each([
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [503, 'server_error'],
    [400, 'bad_request'],
  ] as const)('maps %i to %s', async (status, failure) => {
    const { value, sent } = call({}, () =>
      json(status, { message: `Echo: ${PROMPT} ${KEY}` }, { 'retry-after': '0' }),
    );
    const result = await rerank(value);
    // A provider that turned the request away (4xx) ran nothing, so it bills nothing.
    const mayHaveBilled = status >= 500;
    expect(result).toEqual({ kind: 'failure', failure, mayHaveBilled, usage: null });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(PROMPT);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('turns a throw from the fetch into a code, with none of its text', async () => {
    const { value } = call({}, () => {
      throw new Error(`${PROMPT} ${KEY}`);
    });
    const result = await rerank(value);
    expect(result).toMatchObject({ kind: 'failure', failure: 'unknown', mayHaveBilled: true });
    expect(JSON.stringify(result)).not.toContain(PROMPT);
  });

  it('times out as a code', async () => {
    const { value } = call({ timeoutMs: 30 }, () => new Promise<Response>(() => undefined));
    expect(await rerank(value)).toEqual({
      kind: 'failure',
      failure: 'timeout',
      mayHaveBilled: true,
      usage: null,
    });
  });

  it('cancels a call in flight as a code', async () => {
    const controller = new AbortController();
    const { value } = call({}, () => new Promise<Response>(() => undefined));
    const pending = rerank(value, controller.signal);
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toMatchObject({ failure: 'cancelled', mayHaveBilled: true });
  });
});

describe('refused before any request', () => {
  it.each<[string, Partial<RerankAdapterCall>, string]>([
    ['no lent key, whatever the environment holds', { apiKey: null }, 'auth_failed'],
    ['an empty key', { apiKey: Buffer.alloc(0) }, 'auth_failed'],
    ['a kind with no native rerank', { providerKind: 'openai_hosted' }, 'bad_request'],
    ['a model ID of the wrong shape', { modelId: 'rerank v3' }, 'bad_request'],
    ['an empty query', { query: '' }, 'bad_request'],
    ['no documents', { documents: [] }, 'bad_request'],
    ['an empty document', { documents: ['a', ''] }, 'bad_request'],
  ])('%s', async (_label, overrides, failure) => {
    vi.stubEnv('COHERE_API_KEY', 'GENERATED-ENV-KEY');
    vi.stubEnv('CO_API_KEY', 'GENERATED-ENV-KEY');
    vi.stubEnv('VOYAGE_API_KEY', 'GENERATED-ENV-KEY');
    const { value, sent } = call(overrides);
    expect(await rerank(value)).toEqual({
      kind: 'failure',
      failure,
      mayHaveBilled: false,
      usage: null,
    });
    expect(sent).toHaveLength(0);
  });

  it('sends nothing for a signal already aborted', async () => {
    const { value, sent } = call();
    expect(await rerank(value, AbortSignal.abort())).toMatchObject({
      failure: 'cancelled',
      mayHaveBilled: false,
    });
    expect(sent).toHaveLength(0);
  });
});
