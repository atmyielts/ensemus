import type { TicketSummary } from '@ensemus/application/saas/support';
import type { BreakGlassView } from '@ensemus/application/saas/break-glass';
export const ticketDto = (row: TicketSummary) => ({
  id: row.id,
  subject: row.subject,
  category: row.category,
  status: row.status,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
  version: row.version,
});
export const breakGlassDto = (row: BreakGlassView) => ({
  id: row.id,
  ticket_id: row.ticketId,
  reason_code: row.reasonCode,
  scope_type: row.scopeType,
  scope_id: row.scopeId,
  requested_minutes: row.requestedMinutes,
  state: row.state,
  operator_authorized: row.operatorAuthorized,
  customer_authorized: row.customerAuthorized,
  expires_at: row.expiresAt?.toISOString() ?? null,
  version: row.version,
});
