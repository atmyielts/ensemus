import {
  connections,
  externalResourceAcl,
  externalResources,
  memberships,
  teamMemberships,
  type Tx,
} from '@ensemus/database';
import type { Classification } from '@ensemus/domain/policy';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { rowLockTarget } from './row-lock';

export const MEETING_NOTES_SOURCE_TYPE = 'meeting_notes_http';
export const MEETING_NOTES_SOURCE_STREAM = 'meetings.notes';

export function coversMeetingSource(meeting: string, source: string) {
  const classes: readonly Classification[] = ['public', 'internal', 'confidential', 'restricted'];
  const sourceRank = classes.indexOf(source as Classification);
  return sourceRank >= 0 && sourceRank <= classes.indexOf(meeting as Classification);
}

function sourceQuery(
  tx: Tx,
  input: {
    organizationId: string;
    resourceId?: string;
    requester: string;
    connectionId?: string;
    list?: boolean;
  },
) {
  const { organizationId, resourceId, requester, connectionId, list } = input;
  return tx
    .select({
      resourceId: externalResources.id,
      externalId: externalResources.externalId,
      title: externalResources.displayName,
      connectionName: connections.displayName,
      classification: externalResources.classification,
      connectionId: externalResources.connectionId,
    })
    .from(externalResources)
    .innerJoin(
      connections,
      and(
        eq(connections.organizationId, externalResources.organizationId),
        eq(connections.id, externalResources.connectionId),
        eq(connections.connectorType, MEETING_NOTES_SOURCE_TYPE),
        eq(connections.state, 'active'),
        isNull(connections.ownerMembershipId),
      ),
    )
    .where(
      and(
        eq(externalResources.organizationId, organizationId),
        resourceId ? eq(externalResources.id, resourceId) : undefined,
        connectionId ? eq(externalResources.connectionId, connectionId) : undefined,
        eq(externalResources.stream, MEETING_NOTES_SOURCE_STREAM),
        eq(externalResources.resourceType, MEETING_NOTES_SOURCE_STREAM),
        isNull(externalResources.deletedAt),
        list
          ? inArray(externalResources.classification, ['public', 'internal', 'confidential'])
          : undefined,
        inArray(externalResources.aclState, ['mapped', 'partial']),
        sql`exists (
        select 1 from ${memberships} m
        join ${externalResourceAcl} grant_row on grant_row.organization_id=m.organization_id
        where m.organization_id=${organizationId}::uuid and m.id=${requester}::uuid and m.status='active'
          and grant_row.resource_id=${externalResources.id}
          and grant_row.access in ('read','write','owner')
          and (grant_row.membership_id=m.id or exists (
            select 1 from ${teamMemberships} tm where tm.organization_id=m.organization_id
              and tm.membership_id=m.id and tm.team_id=grant_row.team_id
          ))
      )`,
      ),
    );
}

/** A resource ID chooses only synchronized metadata the current organizer can actually read. */
export async function findMeetingSource(
  tx: Tx,
  input: { organizationId: string; resourceId: string; requester: string; connectionId?: string },
) {
  const [source] = await sourceQuery(tx, input).for('share', {
    of: rowLockTarget(externalResources),
  });
  return source;
}

export async function recentMeetingSources(
  tx: Tx,
  input: { organizationId: string; requester: string },
) {
  const rows = await sourceQuery(tx, { ...input, list: true })
    .orderBy(desc(externalResources.updatedAt), desc(externalResources.id))
    .limit(50);
  return rows.map(({ resourceId, title, connectionName }) => ({
    resourceId,
    title,
    connectionName,
  }));
}
