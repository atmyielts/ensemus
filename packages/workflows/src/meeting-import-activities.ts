// Owned by the meetings-connector slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D5. Only IDs and
// enums go in or out. The text stays in this worker's memory until it is stored.
import type { AppDatabase } from '@ensemus/database';
import type { ConnectorActivityDeps } from './connector-deps';
import type { MeetingImportInput, MeetingImportOutcome } from './schemas';

/** Holds a credential, so it runs on the connector queue, in the worker with no route out but the gateway. */
export function createMeetingImportConnectorActivities(_deps: ConnectorActivityDeps) {
  return {
    async readMeetingNotes(_input: MeetingImportInput): Promise<MeetingImportOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type MeetingImportConnectorActivities = ReturnType<
  typeof createMeetingImportConnectorActivities
>;

/** Reads PostgreSQL and contacts nobody, so it runs on the platform queue, even with no connector worker. */
export function createMeetingImportPlatformActivities(_deps: { database: AppDatabase }) {
  return {
    /** The connector worker never came. Ends the request with CONNECTOR_UNAVAILABLE. Safe to retry. */
    async stopUnreadImport(_input: MeetingImportInput): Promise<MeetingImportOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type MeetingImportPlatformActivities = ReturnType<
  typeof createMeetingImportPlatformActivities
>;
