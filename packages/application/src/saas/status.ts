// Owned by the operations slice (OPS-23). What the public status page reads, with no session and no tenant
// bound. RLS shows only published incidents, and only these columns are granted. See ADR-032 D10.
import { incidents, incidentUpdates, type AppDatabase } from '@ensemus/database';
import {
  overallStatus,
  type IncidentOrigin,
  type IncidentSeverity,
  type IncidentState,
  type PublishedIncident,
  type ServiceStatus,
} from '@ensemus/saas/operations';
import { asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { AppError } from '../errors';

export type StatusPage = {
  overall: ServiceStatus;
  open: readonly (PublishedIncident & { id: string })[];
  recent: readonly (PublishedIncident & { id: string })[];
  updates: readonly { incidentId: string; state: string; message: string; occurredAt: Date }[];
};

export async function getStatusPage(
  database: AppDatabase,
  input: { limit: number },
): Promise<StatusPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new AppError('INVALID_INPUT');
  try {
    return await database.run(async (tx) => {
      const projection = {
        id: incidents.id,
        severity: incidents.severity,
        state: incidents.state,
        origin: incidents.origin,
        title: incidents.publicTitle,
        startedAt: incidents.startedAt,
        resolvedAt: incidents.resolvedAt,
      };
      // Every open published incident contributes, independently of the display limit. Explicit fields
      // are essential: this role deliberately cannot select the private operator columns.
      const allOpen = await tx
        .select(projection)
        .from(incidents)
        .where(ne(incidents.state, 'resolved'))
        .orderBy(desc(incidents.startedAt), asc(incidents.id));
      const recentRows = await tx
        .select(projection)
        .from(incidents)
        .where(eq(incidents.state, 'resolved'))
        .orderBy(desc(incidents.resolvedAt), asc(incidents.id))
        .limit(input.limit);
      const published = (row: (typeof allOpen)[number]) => ({
        ...row,
        severity: row.severity as IncidentSeverity,
        state: row.state as IncidentState,
        origin: row.origin as IncidentOrigin,
      });
      const open = allOpen.slice(0, input.limit).map(published),
        recent = recentRows.map(published),
        ids = [...open, ...recent].map((row) => row.id);
      const updates = ids.length
        ? await tx
            .select({
              incidentId: incidentUpdates.incidentId,
              state: incidentUpdates.state,
              message: incidentUpdates.publicMessage,
              occurredAt: incidentUpdates.occurredAt,
            })
            .from(incidentUpdates)
            .where(inArray(incidentUpdates.incidentId, ids))
            .orderBy(desc(incidentUpdates.occurredAt), asc(incidentUpdates.id))
        : [];
      return { overall: overallStatus(allOpen.map(published)), open, recent, updates };
    });
  } catch {
    return { overall: 'unknown', open: [], recent: [], updates: [] };
  }
}
