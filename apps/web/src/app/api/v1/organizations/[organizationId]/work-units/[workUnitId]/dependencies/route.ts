import { addDependency, idSchema } from '@ensemus/application';
import { z } from 'zod';
import { apiRoute, readJson, workUnitParams } from '@/server/api';

export const dynamic = 'force-dynamic';

const body = z.strictObject({ prerequisite_id: idSchema });

export const POST = apiRoute(workUnitParams, async ({ request, context, database, params }) => {
  const { prerequisite_id: prerequisiteId } = await readJson(request, body);
  await addDependency(database, context, { dependentId: params.workUnitId, prerequisiteId });
  return new Response(null, { status: 201 });
});
