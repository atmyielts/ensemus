// Authored actual-role path, unrun. Uses the existing real offboarding/agent-halt state machine;
// the generated empty tenant needs no provider/material byte deletion or fake physical receipt.
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDatabase } from '@ensemus/database';
import { eraseTenantRows } from '@ensemus/database/eraser';
import { beginErasure } from '@ensemus/application/saas/offboarding';
import { urls } from '../helpers/stack';
import { lifecycleTenant } from './saas-lifecycle-fixture';
import { readyToErase } from './saas-offboarding-fixture';

describe('restore authority invoker target validation preserves least privilege', () => {
  const application = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(async () => {
    await auth.connect();
  });
  afterAll(async () => {
    await auth.end();
    await application.close();
  });
  it('allows actual restricted eraser membership deletion without identity schema USAGE', async () => {
    const owner = await lifecycleTenant(application.db, auth);
    const ready = await readyToErase(application.db, owner);
    await beginErasure(application.db, ready.service, {
      offboardingId: ready.offboardingId,
      operatorRef: 'generated-restore-invoker-operator@example.invalid',
    });
    const connection = new pg.Client({ connectionString: urls.superuser() });
    await connection.connect();
    try {
      // Match the established eraser test harness: actual native session authorization, not an
      // application actor/GUC cast, and no lasting grant or factor/admission receipt seed.
      await connection.query('set session authorization ensemus_eraser');
      const scope = await connection.query(
        "select current_user as role,session_user as login,has_schema_privilege(current_user,'identity','USAGE') as identity_usage",
      );
      expect(scope.rows[0]).toEqual({
        role: 'ensemus_eraser',
        login: 'ensemus_eraser',
        identity_usage: false,
      });
      const database = drizzle(connection, { casing: 'snake_case' }) as unknown as Parameters<
        typeof eraseTenantRows
      >[0];
      const results = await eraseTenantRows(database, owner.organizationId);
      const members = results.find((row) => row.tableRef === 'org.memberships');
      expect(members).toBeDefined();
      expect(members!.rowsRemoved).toBeGreaterThan(0);
      expect(members!.rowsLeft).toBe(0);
    } finally {
      await connection.query('reset session authorization').catch(() => undefined);
      await connection.end();
    }
  });
});
