// Owned by the meetings-connector slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D5. A sync
// reads titles and permissions and no text, because nobody has agreed to anything yet. A note's text is read
// once, on request, after everyone has.
import type { Connector, ConnectorContext } from '../index';

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
      | 'CONNECTOR_UNAVAILABLE'
      | 'SOURCE_NOT_FOUND'
      | 'SOURCE_TOO_LARGE'
      | 'PROVIDER_NOT_APPROVED',
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

export function createMeetingNotesConnector(_options: {
  tls: 'required' | 'none';
  ca?: string;
  beforeCommitMs?: number;
  answerMs?: number;
}): MeetingNotesConnector {
  throw new Error('NOT_IMPLEMENTED');
}
