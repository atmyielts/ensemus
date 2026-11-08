// Test-owned standing setup through the real service and actual application role. No ready export,
// epoch, session proof, archive bytes or worker result is fabricated here.
import {
  openAppDatabase,
  organizations,
  withTenantTx,
  type Tx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { eq, sql } from 'drizzle-orm';
import { urls } from './stack';
export async function setGeneratedAccountStanding(
  organizationId: string,
  to: 'active' | 'suspended',
) {
  const database = openAppDatabase(urls.app()),
    context = createServiceContext(organizationId);
  try {
    await withTenantTx(database.db, context, async (tx) => {
      const [row] = await tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      if (!row?.name.startsWith('Generated account export'))
        throw new Error('GENERATED_ACCOUNT_TENANT_REQUIRED');
      const noRuns = async (scoped: Tx, tenant: TenantContext) => {
        const found = await scoped.execute<{ total: number }>(
          sql`select count(*)::int as total from ai.agent_runs where organization_id=${tenant.organizationId}::uuid`,
        );
        if (found.rows[0]?.total !== 0)
          throw new Error('GENERATED_ACCOUNT_MUST_HAVE_NO_AGENT_RUNS');
      };
      await noRuns(tx, context);
      await setTenantStandingInTx(
        tx,
        context,
        {
          to,
          reasonCode: 'GENERATED_ACCOUNT_EXPORT_TEST',
          actor: { type: 'operator', ref: 'generated-account-export-test' },
        },
        createStandingAgentHaltPort(),
      );
    });
  } finally {
    await database.close();
  }
}
