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
