import { getProcessRun } from '@ensemus/application/process-runs';
import { apiRoute, etag } from '@/server/api';
import { processRunParams, processRunDto } from '@/server/process-run-api';
import { webProductPorts } from '@/server/product-ports';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(processRunParams, async ({ database, context, params }) => {
  const row = await getProcessRun(database, context, webProductPorts(), params.processRunId);
  return Response.json(processRunDto(row), { headers: { ETag: etag(row.version) } });
});
