import type { OrganizationImportView } from '@ensemus/application';
import type {
  ImportFailureCode,
  ImportStatus,
  ImportWarningCode,
} from '@ensemus/domain/portability';
import { formatDateTime } from './ui';

const STATUS: Record<ImportStatus, { label: string; tone: string }> = {
  requested: { label: 'Waiting for your operator', tone: 'attention' },
  running: { label: 'In progress', tone: 'active' },
  completed: { label: 'Done', tone: 'done' },
  completed_with_warnings: { label: 'Done, with warnings', tone: 'attention' },
  failed: { label: 'Failed', tone: 'bad' },
};

// Every warning has words, or this does not typecheck. A count with no sentence would be a silent loss.
const WARNING_WORDS: Record<ImportWarningCode, string> = {
  RESTRICTED_EXCLUDED_AT_SOURCE:
    'restricted records were left out when the archive was made, so they are not here.',
  TOMBSTONED_SKIPPED:
    'files had been deleted at the source, so they were not brought back, and they stay deleted here.',
  PERSON_NOT_LINKED:
    'people are not linked to a member here yet. What they owned is held by whoever asked for this import until you link them.',
  CONNECTION_NEEDS_CREDENTIAL:
    'connections came with no credential, and stay off until someone here sets them up again.',
  SECTION_NOT_SUPPORTED:
    'sections of the archive are not something this release can read, so they were not imported.',
  BYTES_MISSING: 'files had no contents in the archive, so only their records could be noted.',
  RELATION_DANGLING:
    'links pointed at something the archive does not hold, so those links were left out.',
  WORK_PAUSED_ON_IMPORT:
    'pieces of work were moving when the archive was made. Nothing restarted: each one waits here as blocked, for a person.',
  DEFINITION_REQUIRES_REVIEW:
    'definitions or historical records need review before they can be used here.',
  SOURCE_REQUIRES_REINGEST:
    'uploaded originals need local processing before they can be searched. Their old search index was not copied.',
  PROVIDER_RECONNECTION_REQUIRED:
    'provider-backed documents remain reference material until the connection and its current permissions have been checked again.',
  CORE_ONLY_ARCHIVE:
    'archive uses the older core-only format. It does not carry the complete agent and knowledge inventory.',
  FILES_AWAIT_REVIEW:
    'files were placed in separate review storage. Their original input permissions could not be proven, so they were not added to work.',
  FILE_LINK_REQUIRES_REUPLOAD:
    'file links were left inactive. Review the downloaded file and attach it yourself to the right work when appropriate.',
};

const FAILURE_WORDS: Record<ImportFailureCode, string> = {
  ARCHIVE_UNREADABLE: 'The archive could not be read as an archive.',
  WRONG_KEY: 'The private key given does not open this archive. It was sealed to a different key.',
  MANIFEST_INVALID: 'The list of contents inside the archive could not be trusted.',
  PART_MISSING: 'The archive does not hold exactly what its list of contents says it holds.',
  PART_CHANGED: 'A part of the archive does not match its recorded checksum.',
  PATH_REFUSED: 'The archive holds a path this format never makes, so it was refused.',
  RECORD_REFUSED: 'A record in the archive did not pass the checks it has to pass.',
  FORMAT_NOT_SUPPORTED: 'This archive was made by a newer release than this one can read.',
  TARGET_NOT_EMPTY: 'This organization is no longer empty, so an archive cannot go into it.',
  STORE_UNAVAILABLE:
    'File storage could not be confirmed. Your operator must inspect uncertain writes before retrying; they are held and never sent again automatically.',
};

const kindLabel = (kind: string) => kind.replaceAll('_', ' ');

/** How an import stands: what your operator does next, what arrived, and every warning in words. */
export function ImportSummary({
  organizationId,
  view,
}: {
  organizationId: string;
  view: OrganizationImportView;
}) {
  const status = STATUS[view.status];
  const applied = Object.entries(view.appliedCounts);
  const warnings = (Object.entries(view.warningCounts) as [ImportWarningCode, number][]).filter(
    ([, count]) => count > 0,
  );
  const waiting = view.status === 'requested' || view.status === 'failed';
  return (
    <div data-import={view.id}>
      <div className="row">
        <strong>Asked for {formatDateTime(view.requestedAt)}</strong>
        <span className={`badge ${status.tone}`}>{status.label}</span>
      </div>
      {view.failureCode && (
        <p className="notice error gap-above" role="alert">
          {FAILURE_WORDS[view.failureCode]}
        </p>
      )}
      {waiting && (
        <div className="gap-above">
          <p>
            {view.status === 'failed'
              ? 'Completed steps may already be present. Your operator must review the failure before resuming the same archive. Uncertain file writes stay held and are never sent again automatically.'
              : 'Your operator runs the import on their own machine, with the organization-import command, so the private key that opens the archive never reaches this page or this service.'}
          </p>
          <dl className="gap-above">
            <dt>Organization ID</dt>
            <dd>{organizationId}</dd>
            <dt>Import ID</dt>
            <dd>{view.id}</dd>
          </dl>
        </div>
      )}
      {(view.sourceRelease || view.exportedAt) && (
        <dl className="gap-above">
          {view.exportedAt && (
            <>
              <dt>Archive made</dt>
              <dd>{formatDateTime(view.exportedAt)}</dd>
            </>
          )}
          {view.sourceRelease && (
            <>
              <dt>Made by release</dt>
              <dd>{view.sourceRelease}</dd>
            </>
          )}
          {view.finishedAt && (
            <>
              <dt>Finished</dt>
              <dd>{formatDateTime(view.finishedAt)}</dd>
            </>
          )}
        </dl>
      )}
      {applied.length > 0 && (
        <div className="table-wrap gap-above">
          <table>
            <caption className="visually-hidden">What arrived, by kind of record</caption>
            <thead>
              <tr>
                <th scope="col">Kind of record</th>
                <th scope="col">Imported</th>
              </tr>
            </thead>
            <tbody>
              {applied.map(([kind, count]) => (
                <tr key={kind}>
                  <td>{kindLabel(kind)}</td>
                  <td>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {warnings.length > 0 && (
        <>
          <h3 className="gap-above">Warnings</h3>
          <ul>
            {warnings.map(([code, count]) => (
              <li key={code} data-warning={code}>
                <strong>{count}</strong> {WARNING_WORDS[code]}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
