import {
  recordUpdatePayloadSchema,
  ticketCommentAddPayloadSchema,
  invoiceDraftCreatePayloadSchema,
} from '@ensemus/contracts/business-records';
import {
  ACCOUNTING_INVOICE_DRAFT_TOOL,
  TICKETING_COMMENT_ADD_TOOL,
  businessConnectorTypeForTool,
  checkRecordChange,
  connectorTypeOfStream,
} from '@ensemus/domain/business-connector';
const words: Record<string, string> = {
  'crm.record.update': 'Update selected CRM fields',
  'ticketing.record.update': 'Update selected ticket fields',
  'ticketing.comment.add': 'Add an internal ticket note',
  'accounting.record.update': 'Update accounting annotations',
  'accounting.invoice_draft.create': 'Create an invoice draft',
};
export const businessActionWords = (tool: string) => words[tool] ?? null;
export function businessPayload(tool: string, payload: unknown) {
  const type = businessConnectorTypeForTool(tool);
  if (!type) return null;
  if (tool === ACCOUNTING_INVOICE_DRAFT_TOOL) {
    const p = invoiceDraftCreatePayloadSchema.safeParse(payload);
    return p.success ? { kind: 'invoice' as const, data: p.data } : null;
  }
  if (tool === TICKETING_COMMENT_ADD_TOOL) {
    const p = ticketCommentAddPayloadSchema.safeParse(payload);
    return p.success ? { kind: 'note' as const, data: p.data } : null;
  }
  const p = recordUpdatePayloadSchema.safeParse(payload);
  return p.success &&
    connectorTypeOfStream(p.data.record.stream) === type &&
    checkRecordChange(p.data.record.stream, p.data.changes).ok
    ? { kind: 'update' as const, data: p.data }
    : null;
}
export function BusinessActionPayload({ tool, payload }: { tool: string; payload: unknown }) {
  const p = businessPayload(tool, payload);
  if (!p)
    return (
      <p className="notice warn">
        This stored business proposal cannot be described safely. Ask for a new proposal before
        deciding.
      </p>
    );
  return (
    <section className="card stack" aria-labelledby="business-exact-heading">
      <h2 id="business-exact-heading">The exact proposed change</h2>
      {p.kind === 'update' ? (
        <>
          <dl className="details source-record-fields">
            <div>
              <dt>Source record</dt>
              <dd>{p.data.record.external_id}</dd>
            </div>
            <div>
              <dt>Expected source version</dt>
              <dd>{p.data.record.expected_version ?? 'Not provided by the source'}</dd>
            </div>
          </dl>
          <dl className="details source-record-fields">
            {Object.entries(p.data.changes).map(([name, value]) => (
              <div key={name}>
                <dt>{name.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())}</dt>
                <dd>
                  {value === null
                    ? 'Clear this field'
                    : value === ''
                      ? 'Empty text'
                      : String(value)}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : p.kind === 'note' ? (
        <>
          <p>
            Internal note on ticket{' '}
            <span className="source-reference">{p.data.ticket.external_id}</span>. This does not
            reply to the customer.
          </p>
          <p className="pre-wrap source-reference">{p.data.body}</p>
        </>
      ) : (
        <>
          <p>A draft in the accounting system. This does not post an invoice or move money.</p>
          <dl className="details source-record-fields">
            <div>
              <dt>Customer reference</dt>
              <dd>{p.data.customer_ref}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>{p.data.currency}</dd>
            </div>
            {p.data.due_on && (
              <div>
                <dt>Due date</dt>
                <dd>{p.data.due_on}</dd>
              </div>
            )}
            {p.data.reference && (
              <div>
                <dt>Reference</dt>
                <dd>{p.data.reference}</dd>
              </div>
            )}
            {p.data.memo && (
              <div>
                <dt>Memo</dt>
                <dd>{p.data.memo}</dd>
              </div>
            )}
          </dl>
          <ol className="list">
            {p.data.lines.map((line, i) => (
              <li key={i} className="block">
                <p className="source-reference">{line.description}</p>
                <dl className="details source-record-fields">
                  <div>
                    <dt>Quantity</dt>
                    <dd>{line.quantity}</dd>
                  </div>
                  <div>
                    <dt>Unit price</dt>
                    <dd>
                      {line.unit_price} {p.data.currency}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
