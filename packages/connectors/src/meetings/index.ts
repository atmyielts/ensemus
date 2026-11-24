// Owned by the meetings-connector slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D5. A sync
// reads titles and permissions and no text, because nobody has agreed to anything yet. A note's text is read
// once, on request, after everyone has.
import {
  ADAPTER_BASE_PATH,
  adapterNotesSchema,
  adapterPageSchema,
  meetingNotesConnectorConfigSchema,
} from '@ensemus/contracts/business-adapter';
import { MAX_NOTES_BYTES } from '@ensemus/domain/meeting';
import { adapterExchange, AdapterNotContacted, transportFor } from '../business';
import { CursorExpired, SyncUnavailable, type Connector, type ConnectorContext } from '../index';
import { MEETING_NOTES_CONNECTOR_MANIFEST } from '../manifest-business';

export const MEETING_NOTES_CONNECTOR_TYPE = 'meeting_notes_http';
export const MEETING_NOTES_STREAM = 'meetings.notes';

/** Not secret, and never a host: the gateway decides where this connects. */
export type MeetingNotesConfig = {
  tlsServerName?: string;
};

export type MeetingNotesRead = { text: string; externalVersion: string | null };

export interface MeetingNotesConnector extends Connector<MeetingNotesConfig> {
  readonly notes: {
    /**
     * Reads one note's text. Throws MeetingNotesUnavailable with a fixed code. The caller has already
     * rechecked consent and the source approval under the meeting's lock.
     */
    read(
      context: ConnectorContext<MeetingNotesConfig>,
      request: { externalId: string },
    ): Promise<MeetingNotesRead>;
  };
}

export class MeetingNotesUnavailable extends Error {
  override name = 'MeetingNotesUnavailable';
  constructor(
    readonly code:
      'CONNECTOR_UNAVAILABLE' | 'SOURCE_NOT_FOUND' | 'SOURCE_TOO_LARGE' | 'PROVIDER_NOT_APPROVED',
  ) {
    super(code);
  }
}

export const isMeetingNotesConnector = (
  connector: Connector | undefined,
): connector is MeetingNotesConnector =>
  connector !== undefined &&
  connector.manifest.type === MEETING_NOTES_CONNECTOR_TYPE &&
  'notes' in connector;

export function createMeetingNotesConnector(options: {
  tls: 'required' | 'none';
  ca?: string;
  beforeCommitMs?: number;
  answerMs?: number;
}): MeetingNotesConnector {
  const transport = transportFor(options);
  const get = (context: ConnectorContext<MeetingNotesConfig>, path: string) =>
    adapterExchange(context, transport, {
      method: 'GET',
      path: ADAPTER_BASE_PATH + path,
      serverName: context.config.tlsServerName ?? null,
    });

  return {
    manifest: MEETING_NOTES_CONNECTOR_MANIFEST,
    parseConfig(raw) {
      const parsed = meetingNotesConnectorConfigSchema.safeParse(raw);
      if (!parsed.success) throw new Error('CONFIG_INVALID');
      return parsed.data.tlsServerName ? { tlsServerName: parsed.data.tlsServerName } : {};
    },
    sync: {
      async readPage(context, request) {
        if (request.stream !== MEETING_NOTES_STREAM) throw new SyncUnavailable('SYNC_UNAVAILABLE');
        const query = new URLSearchParams({ limit: String(request.pageSize) });
        if (request.cursor !== null) query.set('cursor', request.cursor);
        if (request.fullSync) query.set('full', '1');
        const answer = await get(
          context,
          `/streams/${MEETING_NOTES_STREAM}/records?${query}`,
        ).catch((error: unknown) => {
          if (error instanceof AdapterNotContacted && error.code === 'CREDENTIAL_UNAVAILABLE')
            throw new SyncUnavailable('CREDENTIAL_UNAVAILABLE');
          throw new SyncUnavailable('SYNC_UNAVAILABLE');
        });
        if (answer.status === 410) throw new CursorExpired();
        if (answer.status === 401 || answer.status === 403)
          throw new SyncUnavailable('SYNC_AUTH_FAILED');
        if (answer.status === 429) throw new SyncUnavailable('SYNC_RATE_LIMITED');
        if (answer.status !== 200) throw new SyncUnavailable('SYNC_UNAVAILABLE');
        const page = adapterPageSchema.safeParse(answer.json);
        if (!page.success) throw new SyncUnavailable('SYNC_PAGE_INVALID');
        return {
          resources: page.data.records.map((record) => ({
            externalId: record.id,
            resourceType: MEETING_NOTES_STREAM,
            externalVersion: record.version,
            ...(typeof record.fields.title === 'string' && record.fields.title.trim()
              ? { displayName: record.fields.title.replaceAll('\0', '').slice(0, 500) }
              : {}),
            classification: record.classification === 'restricted' ? 'restricted' : 'confidential',
            acl: record.acl.map((grant) => ({
              principalKind: grant.principal_kind,
              principalExternalId: grant.principal_external_id,
              access: grant.access,
            })),
          })),
          deletedExternalIds: page.data.deleted,
          nextCursor: page.data.next_cursor,
          hasMore: page.data.has_more,
        };
      },
    },
    notes: {
      async read(context, { externalId }) {
        // Dot segments have special meaning even through some path-normalizing reverse proxies.
        if (!externalId || externalId === '.' || externalId === '..')
          throw new MeetingNotesUnavailable('SOURCE_NOT_FOUND');
        const answer = await Promise.resolve()
          .then(() => get(context, `/notes/${encodeURIComponent(externalId)}`))
          .catch(() => {
            throw new MeetingNotesUnavailable('CONNECTOR_UNAVAILABLE');
          });
        if (answer.status === 404) throw new MeetingNotesUnavailable('SOURCE_NOT_FOUND');
        if (answer.status === 413) throw new MeetingNotesUnavailable('SOURCE_TOO_LARGE');
        if (answer.status === 401 || answer.status === 403)
          throw new MeetingNotesUnavailable('PROVIDER_NOT_APPROVED');
        if (answer.status !== 200) throw new MeetingNotesUnavailable('CONNECTOR_UNAVAILABLE');
        const raw = answer.json as { text?: unknown } | null;
        if (typeof raw?.text === 'string' && Buffer.byteLength(raw.text) > MAX_NOTES_BYTES)
          throw new MeetingNotesUnavailable('SOURCE_TOO_LARGE');
        const notes = adapterNotesSchema.safeParse(raw);
        if (
          !notes.success ||
          !notes.data.text.trim() ||
          notes.data.text.includes('\0') ||
          notes.data.version?.includes('\0')
        )
          throw new MeetingNotesUnavailable('CONNECTOR_UNAVAILABLE');
        return { text: notes.data.text, externalVersion: notes.data.version };
      },
    },
  };
}
