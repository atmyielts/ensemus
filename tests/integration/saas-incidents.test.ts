import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { openAppDatabase } from '@ensemus/database';
import { getStatusPage } from '@ensemus/application/saas/status';
import {
  openIncident,
  updateIncident,
  resolveIncident,
  recordVulnerabilityReport,
  moveVulnerabilityReport,
  recordDrill,
} from '@ensemus/application/saas/operator-incidents';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, TEST_OPERATOR } from '../helpers/saas';
import { urls } from '../helpers/stack';

describe('public incident data has a column and role boundary', () => {
  const database = openAppDatabase(urls.app()),
    client = new pg.Client({ connectionString: urls.superuser() });
  let operator: Parameters<typeof openIncident>[0];
  const canary = `private-${randomUUID()}`;
  beforeAll(async () => {
    await client.connect();
    await client.query('set role ensemus_operator');
    operator = drizzle(client, { casing: 'snake_case' }) as unknown as typeof operator;
  });
  afterAll(async () => {
    await client.query('reset role');
    await client.end();
    await database.close();
  });
  const create = (isDrill = false) =>
    openIncident(operator, {
      operatorRef: TEST_OPERATOR,
      severity: 'high',
      origin: 'model_provider',
      providerKind: 'test-provider',
      publicTitle: `Test ${randomUUID()}`,
      commanderRef: canary,
      isDrill,
      startedAt: new Date(),
    });
  it('application and support roles cannot operate incidents even with a supplied actor', async () => {
    const input = {
      operatorRef: TEST_OPERATOR,
      severity: 'medium' as const,
      origin: 'unknown' as const,
      providerKind: null,
      publicTitle: 'Test',
      commanderRef: 'test-commander',
      isDrill: false,
      startedAt: new Date(),
    };
    await database.db.run((tx) =>
      expect(openIncident(tx as unknown as typeof operator, input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      }),
    );
    await expect(
      asRole('ensemus_support', (connection) =>
        connection.query(
          "insert into operations.incidents (severity,origin,public_title,commander_ref,started_at) values ('medium','unknown','Test','test',now())",
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('drafts, drills, private author and postmortem references never enter the public projection', async () => {
    const draft = await create(),
      drill = await create(true),
      published = await create();
    await expect(
      updateIncident(operator, {
        incidentId: drill.incidentId,
        state: 'investigating',
        publicMessage: 'Test drill',
        authorRef: canary,
        publish: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await updateIncident(operator, {
      incidentId: published.incidentId,
      state: 'identified',
      publicMessage: 'Test public update',
      authorRef: canary,
      publish: true,
    });
    const page = await getStatusPage(database.db, { limit: 100 });
    expect(
      page.open.some((row) => row.id === draft.incidentId || row.id === drill.incidentId),
    ).toBe(false);
    expect(page.open.some((row) => row.id === published.incidentId)).toBe(true);
    expect(JSON.stringify(page)).not.toContain(canary);
    for (const query of [
      sql`select commander_ref from operations.incidents`,
      sql`select postmortem_ref from operations.incidents`,
      sql`select author_ref from operations.incident_updates`,
      sql`select details_ref from operations.vulnerability_reports`,
      sql`select staffed_by_ref from support.coverage_schedules`,
      sql`select drafted_by from support.coverage_schedules`,
    ])
      await expect(database.db.run((tx) => tx.execute(query))).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    await expect(
      resolveIncident(operator, {
        incidentId: published.incidentId,
        authorRef: TEST_OPERATOR,
        postmortemRef: null,
        message: 'Test resolved',
      }),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    await resolveIncident(operator, {
      incidentId: published.incidentId,
      authorRef: TEST_OPERATOR,
      postmortemRef: canary,
      message: 'Test resolved',
    });
    expect(JSON.stringify(await getStatusPage(database.db, { limit: 100 }))).not.toContain(canary);
  });
  it('records reference-only disclosure transitions with optimistic versions and named drill evidence', async () => {
    const { reportId } = await recordVulnerabilityReport(operator, {
      operatorRef: TEST_OPERATOR,
      channelRef: 'test-channel',
      detailsRef: canary,
      receivedAt: new Date(),
      isExercise: true,
    });
    await expect(
      moveVulnerabilityReport(operator, {
        operatorRef: TEST_OPERATOR,
        reportId,
        state: 'disclosed',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await moveVulnerabilityReport(operator, {
      operatorRef: TEST_OPERATOR,
      reportId,
      state: 'triaged',
      severity: 'high',
      expectedVersion: 1,
    });
    await expect(
      moveVulnerabilityReport(operator, {
        operatorRef: TEST_OPERATOR,
        reportId,
        state: 'fixing',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await moveVulnerabilityReport(operator, {
      operatorRef: TEST_OPERATOR,
      reportId,
      state: 'fixing',
      expectedVersion: 2,
    });
    await expect(
      moveVulnerabilityReport(operator, {
        operatorRef: TEST_OPERATOR,
        reportId,
        state: 'fixed',
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    await moveVulnerabilityReport(operator, {
      operatorRef: TEST_OPERATOR,
      reportId,
      state: 'fixed',
      fixedInRef: 'test-fix',
      expectedVersion: 3,
    });
    await moveVulnerabilityReport(operator, {
      operatorRef: TEST_OPERATOR,
      reportId,
      state: 'fixing',
      expectedVersion: 4,
    });
    await expect(
      moveVulnerabilityReport(operator, {
        operatorRef: TEST_OPERATOR,
        reportId,
        state: 'fixed',
        expectedVersion: 5,
      }),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    await moveVulnerabilityReport(operator, {
      operatorRef: TEST_OPERATOR,
      reportId,
      state: 'fixed',
      fixedInRef: 'test-revised-fix',
      expectedVersion: 5,
    });
    await moveVulnerabilityReport(operator, {
      operatorRef: TEST_OPERATOR,
      reportId,
      state: 'disclosed',
      expectedVersion: 6,
    });
    await expect(
      recordDrill(operator, {
        operatorRef: TEST_OPERATOR,
        kind: 'incident',
        scenarioRef: 'test-drill',
        roles: {},
        startedAt: new Date(),
        finishedAt: new Date(),
        outcome: 'passed',
        evidenceRef: canary,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
