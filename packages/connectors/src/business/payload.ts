// EXP-02: schema and writable-field checks at the final connector boundary.
import {
  recordUpdatePayloadSchema,
  ticketCommentAddPayloadSchema,
  invoiceDraftCreatePayloadSchema,
} from '@ensemus/contracts/business-records';
import {
  ACCOUNTING_CONNECTOR_TYPE,
  ACCOUNTING_INVOICE_DRAFT_TOOL,
  CRM_RECORD_UPDATE_TOOL,
  TICKETING_RECORD_UPDATE_TOOL,
  ACCOUNTING_RECORD_UPDATE_TOOL,
  TICKETING_COMMENT_ADD_TOOL,
  TICKETING_CONNECTOR_TYPE,
  checkRecordChange,
  connectorTypeOfStream,
  isToolOf,
  type BusinessConnectorType,
} from '@ensemus/domain/business-connector';
/** One exact allowlisted effect. Strictly parsed again before the connector can contact its adapter. */
export function parseBusinessActionPayload(
  type: BusinessConnectorType,
  tool: string,
  raw: unknown,
) {
  if (!isToolOf(type, tool)) return null;
  if (
    [CRM_RECORD_UPDATE_TOOL, TICKETING_RECORD_UPDATE_TOOL, ACCOUNTING_RECORD_UPDATE_TOOL].includes(
      tool,
    )
  ) {
    const parsed = recordUpdatePayloadSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.record.expected_version === null ||
      connectorTypeOfStream(parsed.data.record.stream) !== type ||
      !checkRecordChange(parsed.data.record.stream, parsed.data.changes).ok
    )
      return null;
    return parsed.data;
  }
  if (type === TICKETING_CONNECTOR_TYPE && tool === TICKETING_COMMENT_ADD_TOOL) {
    const parsed = ticketCommentAddPayloadSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  if (type === ACCOUNTING_CONNECTOR_TYPE && tool === ACCOUNTING_INVOICE_DRAFT_TOOL) {
    const parsed = invoiceDraftCreatePayloadSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }
  return null;
}
