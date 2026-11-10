import type { ImportedRecordView } from '@ensemus/application';
import type { ImportedRecordType } from '@ensemus/domain/portability';
import { Empty, formatDateTime } from './ui';

const RECORD_LABEL: Record<ImportedRecordType, string> = {
  approval: 'Approval',
  approval_decision: 'Approval decision',
  work_transition: 'Status change',
  external_action: 'Outside action',
  external_action_receipt: 'Outside action receipt',
  audit_event: 'Audit record',
};

/**
 * History that came with a piece of work. It is a record of what happened elsewhere, so nothing here can be
 * acted on: no decision can be made and nothing can be sent again. React escapes what the archive says.
 */
export function ImportHistory({ records }: { records: readonly ImportedRecordView[] }) {
  if (records.length === 0) {
    return <Empty>No history came with this work.</Empty>;
  }
  return (
    <ul className="list">
      {records.map((record) => (
        <li key={`${record.recordType}-${record.sourceId}`} className="block">
          <div className="row">
            <strong>{RECORD_LABEL[record.recordType]}</strong>
            <span className="muted">{formatDateTime(record.occurredAt)}</span>
          </div>
          <details className="gap-above">
            <summary>What was recorded</summary>
            <pre className="record-text">{JSON.stringify(record.record, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
