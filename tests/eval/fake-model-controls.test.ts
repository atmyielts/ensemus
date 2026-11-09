import { createEmbeddingAdapter, createEndpointGuard } from '@ensemus/intelligence';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fakeModelRequests,
  scriptFakeModel,
  startFakeModel,
  type FakeModel,
} from '../conformance/fake-model';

describe('test-only private model controls', () => {
  let fake: FakeModel | undefined;
  afterEach(async () => fake?.close());
  const call = async (model: string) => {
    const response = await fetch(`${fake!.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Synthetic prompt.' }] }),
    });
    return { status: response.status, body: await response.json() };
  };

  it('keeps concurrent model scripts independent and preserves captured request evidence', async () => {
    fake = await startFakeModel();
    expect(fake.host).toBe('127.0.0.1');
    await scriptFakeModel(fake.url, 'fake:first', [
      {
        tool: {
          name: 'artifact_draft_create',
          args: { name: 'Draft', text: 'Synthetic', evidence: [] },
        },
      },
      { text: 'First done.' },
    ]);
    await scriptFakeModel(fake.url, 'fake:second', [{ text: 'Second done.' }]);
    const [first, second] = await Promise.all([call('fake:first'), call('fake:second')]);
    expect(JSON.stringify(first.body)).toContain('artifact_draft_create');
    expect(JSON.stringify(second.body)).toContain('Second done.');
    expect(JSON.stringify((await call('fake:first')).body)).toContain('First done.');
    expect((await fakeModelRequests(fake.url, 'fake:first')).requests).toHaveLength(2);
    expect((await fakeModelRequests(fake.url, 'fake:second')).requests).toHaveLength(1);
    expect(fake.hits).toBe(3);
    expect((await call('fake:first')).status).toBe(500); // Exhaustion must never silently become success.
  });

  it('returns the scripted raw provider error while the control itself is not counted as a call', async () => {
    fake = await startFakeModel();
    await scriptFakeModel(fake.url, 'fake:error', [
      { error: { status: 500, message: 'SYNTHETIC_PROVIDER_ERROR' } },
    ]);
    expect(fake.hits).toBe(0);
    const reply = await call('fake:error');
    expect(reply.status).toBe(500);
    expect(JSON.stringify(reply.body)).toContain('SYNTHETIC_PROVIDER_ERROR');
    expect(fake.hits).toBe(1);
  });

  it('a busy model cannot mark a new model’s complete bounded capture as truncated', async () => {
    fake = await startFakeModel();
    for (let index = 0; index < 130; index += 1) await call('fake:text');
    await scriptFakeModel(fake.url, 'fake:isolated', [{ text: 'The current model result.' }]);
    await call('fake:isolated');
    const own = await fakeModelRequests(fake.url, 'fake:isolated');
    expect(own.requests).toHaveLength(1);
    expect(own.total).toBe(1);
    expect(own.historyTruncated).toBe(false);
    expect((await fakeModelRequests(fake.url, 'fake:text')).historyTruncated).toBe(true);
  });

  it('rejects unknown keys, unsafe tool names, oversized bodies and excessive reply lists', async () => {
    fake = await startFakeModel();
    const send = (body: unknown) =>
      fetch(`${fake!.url}/__fake/scripts`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
    expect((await send({ model: 'fake:bad', replies: [{ text: 'x' }], extra: true })).status).toBe(
      400,
    );
    expect(
      (await send({ model: 'fake:bad', replies: [{ tool: { name: 'bad.name', args: {} } }] }))
        .status,
    ).toBe(400);
    expect(
      (
        await send({
          model: 'fake:bad',
          replies: Array.from({ length: 17 }, () => ({ text: 'x' })),
        })
      ).status,
    ).toBe(400);
    expect(
      (await send({ model: 'fake:bad', replies: [{ text: 'x'.repeat(270000) }] })).status,
    ).toBe(413);
    expect(fake.hits).toBe(0);
  });

  // The stack's agent worker qualifies an embedding profile against this fake (tests/stack/api-coverage).
  it('answers the real embedding adapter, through the real guard, with repeatable vectors', async () => {
    fake = await startFakeModel();
    const embed = (inputs: string[]) =>
      createEmbeddingAdapter().embed(
        {
          providerKind: 'local_openai_compatible',
          modelId: 'generated-embedding-model',
          endpointUrl: fake!.baseUrl,
          apiKey: null,
          fetch: createEndpointGuard().fetchFor({
            host: fake!.host,
            port: fake!.port,
            protocol: 'http:',
            viaPrivateAllowlist: true,
          }),
          timeoutMs: 5000,
          inputs,
          dimension: 4,
        },
        new AbortController().signal,
      );
    const first = await embed(['Synthetic one.', 'Synthetic two.']);
    if (first.kind !== 'embedded') throw new Error(`TEST_EMBED_FAILED:${first.failure}`);
    expect(first.vectors).toHaveLength(2);
    expect(first.vectors.every((vector) => vector.length === 4)).toBe(true);
    expect(first.vectors[0]).not.toEqual(first.vectors[1]);
    expect(first.usage).toEqual({ inputTokens: 8, outputTokens: 0 });
    const again = await embed(['Synthetic one.']);
    if (again.kind !== 'embedded') throw new Error(`TEST_EMBED_FAILED:${again.failure}`);
    expect(again.vectors[0]).toEqual(first.vectors[0]);
    const sent = fake.requests.at(-1)?.body as { dimensions?: unknown; input?: unknown };
    expect(sent.dimensions).toBe(4);
    expect(fake.hits).toBe(2);
  });

  it('refuses an embedding request without inputs or a dimension, and counts it', async () => {
    fake = await startFakeModel();
    const send = (body: unknown) =>
      fetch(`${fake!.baseUrl}/embeddings`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
    expect((await send({ model: 'm', input: ['text'] })).status).toBe(400);
    expect((await send({ model: 'm', input: [], dimensions: 4 })).status).toBe(400);
    expect((await send({ model: 'm', input: [''], dimensions: 4 })).status).toBe(400);
    expect((await send({ model: 'm', input: ['text'], dimensions: 0 })).status).toBe(400);
    expect(fake.hits).toBe(4);
  });
});
