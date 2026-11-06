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
});
