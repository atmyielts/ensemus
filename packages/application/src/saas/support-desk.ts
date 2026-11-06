// The desk's side, as `ensemus_support`, which cannot read anything else in the database. Owned by the
// support slice (OPS-22, OPS-24). It runs from the operator's command, and there is no web path to it.
import type { EnsemusDrizzle } from '@ensemus/database/support';
import type { TicketStatus } from '@ensemus/saas/support';

export type DeskDb = EnsemusDrizzle;

export function listDeskQueue(
  _db: DeskDb,
  _input: { status?: TicketStatus; limit: number },
): Promise<
  readonly { organizationId: string; ticketId: string; status: string; updatedAt: Date }[]
> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Sets `first_response_at` the first time, which is how response times are measured and not promised. */
export function replyAsDesk(
  _db: DeskDb,
  _input: { organizationId: string; ticketId: string; agentRef: string; body: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Files a request, which grants nothing. Refused unless the deployment has break-glass turned on. */
export function requestBreakGlass(
  _db: DeskDb,
  _input: {
    organizationId: string;
    ticketId: string;
    requestedBy: string;
    reasonCode: string;
    scopeType: 'work_unit' | 'artifact' | 'client' | 'project';
    scopeId: string;
    requestedMinutes: number;
  },
  _config: import('@ensemus/saas/support').BreakGlassConfig,
): Promise<{ requestId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}
