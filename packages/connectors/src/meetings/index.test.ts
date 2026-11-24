import { MAX_NOTES_BYTES } from '@ensemus/domain/meeting';
import { describe, expect, it } from 'vitest';
import { createFakeAdapter } from '../testing/business-adapter';
import { MEETING_NOTES_STREAM, createMeetingNotesConnector } from './index';

const connector = createMeetingNotesConnector({ tls: 'none', beforeCommitMs: 100, answerMs: 150 });
const context = (fake: ReturnType<typeof createFakeAdapter>) => ({
  ...fake,
  organizationId: 'generated-tenant',
  connectionId: 'generated-connection',
  config: connector.parseConfig({}),
  signal: new AbortController().signal,
});

describe('meeting notes adapter', () => {
  it('syncs bounded titles, identity and grants, discarding transcript fields', async () => {
    const canary = 'GENERATED_SYNC_MUST_NOT_KEEP_THESE_WORDS';
    const adapter = createFakeAdapter({
      streams: {
        [MEETING_NOTES_STREAM]: [
          {
            id: 'generated-note',
            version: '4',
            classification: 'internal',
            fields: { title: 'Generated title', transcript: canary, nested: { text: canary } },
            acl: [
              { principal_kind: 'user', principal_external_id: 'generated-person', access: 'read' },
            ],
          },
        ],
      },
    });
    const page = await connector.sync!.readPage(context(adapter), {
      stream: MEETING_NOTES_STREAM,
      cursor: null,
      pageSize: 20,
      fullSync: true,
    });
    expect(page.resources).toEqual([
      {
        externalId: 'generated-note',
        resourceType: MEETING_NOTES_STREAM,
        externalVersion: '4',
        displayName: 'Generated title',
        classification: 'confidential',
        acl: [{ principalKind: 'user', principalExternalId: 'generated-person', access: 'read' }],
      },
    ]);
    expect(JSON.stringify(page)).not.toContain(canary);
    expect(adapter.requests().map((request) => request.path)).toEqual([
      '/ensemus-adapter/v1/streams/meetings.notes/records?limit=20&full=1',
    ]);
    expect(connector.manifest.capabilities.actions).toEqual([]);
    expect(connector.actions).toBeUndefined();
    expect(connector.webhooks).toBeUndefined();
  });

  it('validates the TLS certificate name and rejects unrelated settings', () => {
    expect(connector.parseConfig({ tlsServerName: 'adapter.example.invalid' })).toEqual({
      tlsServerName: 'adapter.example.invalid',
    });
    expect(() =>
      connector.parseConfig({ tlsServerName: 'https://adapter.example.invalid/' }),
    ).toThrow('CONFIG_INVALID');
    expect(() => connector.parseConfig({ streams: [MEETING_NOTES_STREAM] })).toThrow(
      'CONFIG_INVALID',
    );
  });

  it('reads one opaque identifier and measures decoded UTF-8 bytes', async () => {
    const externalId = 'generated/note?revision=4';
    const fake = createFakeAdapter({
      notes: {
        [externalId]: 'Generated note',
        large: 'т'.repeat(MAX_NOTES_BYTES / 2 + 1),
      },
    });
    await expect(connector.notes.read(context(fake), { externalId })).resolves.toEqual({
      text: 'Generated note',
      externalVersion: '1',
    });
    expect(fake.requests()[0]?.path).toBe(
      '/ensemus-adapter/v1/notes/' + encodeURIComponent(externalId),
    );
    await expect(
      connector.notes.read(context(fake), { externalId: 'large' }),
    ).rejects.toMatchObject({
      code: 'SOURCE_TOO_LARGE',
    });
    await expect(
      connector.notes.read(context(fake), { externalId: 'missing' }),
    ).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    });
    await expect(connector.notes.read(context(fake), { externalId: '..' })).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
    });
    expect(fake.requests()).toHaveLength(3);
  });

  it.each([
    [{ status: 401 }, 'PROVIDER_NOT_APPROVED'],
    [{ status: 413 }, 'SOURCE_TOO_LARGE'],
    [{ raw: 'invalid generated response' }, 'CONNECTOR_UNAVAILABLE'],
    ['refuse_connection', 'CONNECTOR_UNAVAILABLE'],
  ] as const)('safely reports the provider fault %j', async (fault, code) => {
    const fake = createFakeAdapter();
    fake.next(fault);
    await expect(
      connector.notes.read(context(fake), { externalId: 'generated' }),
    ).rejects.toMatchObject({
      name: 'MeetingNotesUnavailable',
      message: code,
      code,
    });
  });
});
