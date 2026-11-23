import { beginMeetingImport, finishMeetingImport, stopMeetingImport } from '@ensemus/application';
import { isMeetingNotesConnector, MeetingNotesUnavailable } from '@ensemus/connectors/meetings';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { ConnectorActivityDeps } from './connector-deps';
import {
  meetingImportInputSchema,
  type MeetingImportInput,
  type MeetingImportOutcome,
} from './schemas';

function activityIdentity() {
  const activity = Context.current();
  const temporalRunId = activity.info.workflowExecution?.runId;
  if (!temporalRunId) throw new Error('MEETING_ACTIVITY_RUN_REQUIRED');
  return {
    temporalRunId,
    signal: activity.cancellationSignal,
  };
}
type ActivityIdentity = typeof activityIdentity;

function safeFailure() {
  return ApplicationFailure.retryable(
    'Meeting import storage unavailable',
    'MEETING_IMPORT_UNAVAILABLE',
  );
}

/** Only this queue may hold the transport settings, lease the credential, and see the note. */
export function createMeetingImportConnectorActivities(
  deps: ConnectorActivityDeps & { activity?: ActivityIdentity },
) {
  return {
    async readMeetingNotes(raw: MeetingImportInput): Promise<MeetingImportOutcome> {
      const { organizationId, importRequestId } = meetingImportInputSchema.parse(raw);
      const context = createServiceContext(organizationId);
      const { temporalRunId, signal } = (deps.activity ?? activityIdentity)();
      const request = { importRequestId, temporalRunId };
      try {
        const begin = () => beginMeetingImport(deps.database, context, request);
        const started = await begin();
        if (started.kind === 'done') return started.status;
        if (started.kind === 'stopped') return 'refused';

        const { connection, externalId } = started.prepared;
        const connector = deps.registry.get(connection.connectorType);
        const secretId = connection.credentialSecretId;
        const stop = (error: unknown) => {
          const code =
            error instanceof MeetingNotesUnavailable ? error.code : 'CONNECTOR_UNAVAILABLE';
          return stopMeetingImport(deps.database, context, {
            ...request,
            code,
            to: code === 'PROVIDER_NOT_APPROVED' ? 'refused' : 'failed',
          });
        };
        if (!isMeetingNotesConnector(connector) || !secretId) return await stop(null);

        const notes = await (async () => {
          const config = connector.parseConfig(connection.config);
          return connector.notes.read(
            {
              organizationId,
              connectionId: connection.id,
              config,
              signal,
              network: deps.network,
              credentials: {
                withCredential: (use) =>
                  deps.secrets.withSecret(
                    { organizationId, secretId, purpose: connector.manifest.credential.purpose },
                    async (secret) => {
                      // The gateway is ready. Check again before it can write the GET.
                      const checked = await begin();
                      if (
                        checked.kind !== 'go' ||
                        checked.prepared.externalId !== externalId ||
                        checked.prepared.connection.credentialSecretId !== secretId ||
                        connector.parseConfig(checked.prepared.connection.config).tlsServerName !==
                          config.tlsServerName ||
                        signal.aborted
                      )
                        throw new MeetingNotesUnavailable('PROVIDER_NOT_APPROVED');
                      return use(secret);
                    },
                  ),
              },
            },
            { externalId },
          );
        })().catch(async (error: unknown) => ({ stopped: await stop(error) }));
        if ('stopped' in notes) return notes.stopped;
        if (signal.aborted) return await stop(null);
        const saved = await finishMeetingImport(deps.database, context, { ...request, ...notes });
        if (!('stopped' in saved)) return 'completed';
        return await stop(new MeetingNotesUnavailable('CONNECTOR_UNAVAILABLE'));
      } catch {
        // Driver/provider messages can contain source data. Keep the Temporal failure fixed.
        throw safeFailure();
      }
    },
  };
}
export type MeetingImportConnectorActivities = ReturnType<
  typeof createMeetingImportConnectorActivities
>;

export function createMeetingImportPlatformActivities(deps: {
  database: AppDatabase;
  activity?: ActivityIdentity;
}) {
  return {
    async stopUnreadImport(raw: MeetingImportInput): Promise<MeetingImportOutcome> {
      const { organizationId, importRequestId } = meetingImportInputSchema.parse(raw);
      const { temporalRunId } = (deps.activity ?? activityIdentity)();
      try {
        return await stopMeetingImport(deps.database, createServiceContext(organizationId), {
          importRequestId,
          temporalRunId,
          code: 'CONNECTOR_UNAVAILABLE',
          to: 'failed',
        });
      } catch {
        throw safeFailure();
      }
    },
  };
}
export type MeetingImportPlatformActivities = ReturnType<
  typeof createMeetingImportPlatformActivities
>;
