import type { OrganizationExportView } from '@ensemus/application';
import type { ExportFailureCode, ExportStatus } from '@ensemus/domain/portability';
import { Empty, formatBytes, formatDateTime } from './ui';

const STATUS: Record<ExportStatus, { label: string; tone: string }> = {
  requested: { label: 'Waiting to start', tone: '' },
  running: { label: 'In progress', tone: 'active' },
  ready: { label: 'Ready', tone: 'done' },
  failed: { label: 'Failed', tone: 'bad' },
  expired: { label: 'Removed', tone: '' },
};

const FAILURE_WORDS: Record<ExportFailureCode, string> = {
  STORE_UNAVAILABLE: 'File storage could not be reached. Ask for a new export once it is back.',
  BYTES_MISSING: 'A file this export needed was missing from storage.',
  BYTES_CHANGED:
    'A file in storage no longer matched what was recorded for it, so the export stopped rather than copying it. Your operator should look at this.',
  RECORD_REFUSED:
    'A record did not pass the checks an archive holds to, so the export stopped rather than writing it.',
  TOO_MANY_PARTS: 'This organization has more than one archive can hold.',
  SECTION_FAILED: 'One part of the organization could not be read, so the export stopped.',
};

/** Why there is no download, in words. A person should never be left looking at a missing button. */
function whyNoDownload(item: OrganizationExportView): string | null {
  switch (item.status) {
    case 'requested':
    case 'running':
      return 'The download appears here when it is ready.';
    case 'failed':
      return item.failureCode ? FAILURE_WORDS[item.failureCode] : 'This export did not finish.';
    case 'expired':
      return 'The archive was removed from storage because it expired or data or access changed. This record stays. Ask for a new export if you need one.';
    case 'ready':
      return item.downloadable
        ? null
        : 'Data or access changed after this export started, so this copy can no longer be downloaded. Ask for a new export.';
  }
}

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

function LeftOut({ excluded }: { excluded: OrganizationExportView['excluded'] }) {
  const { restrictedWork, restrictedArtifacts, restrictedClients } = excluded;
  if (restrictedWork + restrictedArtifacts + restrictedClients === 0) {
    return <>Nothing restricted was found to leave out.</>;
  }
  return (
    <>
      {count(restrictedWork, 'piece of restricted work', 'pieces of restricted work')},{' '}
      {count(restrictedArtifacts, 'restricted file', 'restricted files')} and{' '}
      {count(restrictedClients, 'restricted client', 'restricted clients')}.
    </>
  );
}

/** Every archive this organization has asked for, what happened to it, and what it left out. */
export function ExportList({
  organizationId,
  exports,
}: {
  organizationId: string;
  exports: readonly OrganizationExportView[];
}) {
  if (exports.length === 0) {
    return <Empty>No exports yet. Your first one will appear here.</Empty>;
  }
  return (
    <ul className="list">
      {exports.map((item) => {
        const status = STATUS[item.status];
        const why = whyNoDownload(item);
        return (
          <li key={item.id} className="block" data-export={item.id}>
            <div className="row">
              <strong>Asked for {formatDateTime(item.requestedAt)}</strong>
              <span className={`badge ${status.tone}`}>{status.label}</span>
            </div>
            <dl className="gap-above">
              <dt>Sealed to key</dt>
              <dd>{item.recipientKeyId}</dd>
              <dt>Holds</dt>
              <dd>
                {count(item.recordCount, 'record', 'records')} in{' '}
                {count(item.partCount, 'part', 'parts')}, {formatBytes(item.archiveBytes)}
              </dd>
              <dt>Left out</dt>
              <dd>
                <LeftOut excluded={item.excluded} />
              </dd>
              {item.finishedAt && (
                <>
                  <dt>Finished</dt>
                  <dd>{formatDateTime(item.finishedAt)}</dd>
                </>
              )}
              {item.expiresAt && item.status === 'ready' && (
                <>
                  <dt>Stays in storage until</dt>
                  <dd>{formatDateTime(item.expiresAt)}</dd>
                </>
              )}
            </dl>
            {why && <p className="muted gap-above">{why}</p>}
            {item.status === 'ready' && item.downloadable && (
              <p className="gap-above">
                {/* A plain link, so it works with no JavaScript, and is never fetched ahead of time. */}
                <a
                  className="button"
                  href={`/api/v1/organizations/${organizationId}/exports/${item.id}/archive`}
                  download
                >
                  Download archive
                </a>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
