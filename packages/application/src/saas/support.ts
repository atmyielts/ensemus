// Owned by the support slice (OPS-22). Published hours match real staffing, and support has no default
// access to content. See docs/06-delivery/m8-slices.md and ADR-032 D8.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { TicketCategory, TicketStatus } from '@ensemus/saas/support';

export type TicketSummary = {
  id: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type TicketDetail = TicketSummary & {
  messages: readonly {
    id: string;
    authorKind: 'customer' | 'support';
    body: string;
    createdAt: Date;
  }[];
};

/** `support.use`. A tenant's owner and admins see every ticket, and a member sees the ones they opened. */
export function listTickets(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly TicketSummary[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getTicket(
  _database: AppDatabase,
  _context: TenantContext,
  _ticketId: string,
): Promise<TicketDetail> {
  throw new Error('NOT_IMPLEMENTED');
}

/** `support.use`, in any standing, because someone suspended still has to reach a person. */
export function openTicket(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { subject: string; category: TicketCategory; body: string },
): Promise<{ ticketId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function replyToTicket(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { ticketId: string; body: string; expectedVersion: number },
): Promise<{ version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function closeTicket(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { ticketId: string; expectedVersion: number },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export type PublishedCoverage = {
  version: number;
  timezone: string;
  windows: readonly import('@ensemus/saas/support').CoverageWindow[];
} | null;

/** What the support page shows. Null says plainly that no hours have been published. */
export function getPublishedCoverage(_database: AppDatabase): Promise<PublishedCoverage> {
  throw new Error('NOT_IMPLEMENTED');
}
