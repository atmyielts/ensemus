import {
  listRetentionRules,
  setRetentionRule,
  type RetentionRuleView,
} from '@ensemus/application/saas/retention';
import { setRetentionRuleSchema } from '@ensemus/contracts/saas';
import { apiRoute, organizationParams, readJson } from '@/server/api';
export const dynamic = 'force-dynamic';
const dto = (row: RetentionRuleView) => ({
  id: row.id,
  data_category: row.dataCategory,
  classification: row.classification,
  retain_days: row.retainDays,
  basis_ref: row.basisRef,
  created_at: row.createdAt.toISOString(),
});
export const GET = apiRoute(
  organizationParams,
  async ({ database, context }) =>
    Response.json({ items: (await listRetentionRules(database, context, {})).map(dto) }),
  'account',
);
export const POST = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const body = await readJson(request, setRetentionRuleSchema);
    const result = await setRetentionRule(database, context, {
      dataCategory: body.data_category,
      classification: body.classification,
      retainDays: body.retain_days,
      basisRef: body.basis_ref,
    });
    const row = (await listRetentionRules(database, context, { history: true })).find(
      (rule) => rule.id === result.ruleId,
    )!;
    return Response.json(dto(row), { status: 201 });
  },
  'account',
);
