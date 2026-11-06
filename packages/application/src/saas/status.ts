// Owned by the operations slice (OPS-23). What the public status page reads, with no session and no tenant
// bound. RLS shows only published incidents, and only these columns are granted. See ADR-032 D10.
import type { AppDatabase } from '@ensemus/database';
import type { PublishedIncident, ServiceStatus } from '@ensemus/saas/operations';

export type StatusPage = {
  overall: ServiceStatus;
  open: readonly (PublishedIncident & { id: string })[];
  recent: readonly (PublishedIncident & { id: string })[];
  updates: readonly { incidentId: string; state: string; message: string; occurredAt: Date }[];
};

export function getStatusPage(
  _database: AppDatabase,
  _input: { limit: number },
): Promise<StatusPage> {
  throw new Error('NOT_IMPLEMENTED');
}
