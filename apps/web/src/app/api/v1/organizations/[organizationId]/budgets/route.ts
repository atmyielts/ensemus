import { setBudget } from '@ensemus/application/ai-budget';
import { setBudgetSchema } from '@ensemus/contracts/ai';
import { apiRoute, organizationParams, readJson } from '@/server/api';

export const dynamic = 'force-dynamic';

/**
 * Sets the limit for one scope and month. The service checks `budget.manage`. Setting the same limit
 * again changes nothing, so this needs no idempotency key, and the spec says a 201 has no body.
 */
export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  const body = await readJson(request, setBudgetSchema);
  await setBudget(database, context, body);
  return new Response(null, { status: 201 });
});
