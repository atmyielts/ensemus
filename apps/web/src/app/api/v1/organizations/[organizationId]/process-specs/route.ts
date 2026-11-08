import { listProcessSpecs } from '@ensemus/application/process-specs';
import { processSpecListSchema } from '@ensemus/contracts/studio';
import { apiRoute, organizationParams } from '@/server/api';
import { processSpecDto } from '@/server/process-run-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(organizationParams, async ({ database, context }) => {
  const items = (await listProcessSpecs(database, context)).map(processSpecDto);
  return Response.json(processSpecListSchema.parse({ items, limited: items.length === 200 }));
});
