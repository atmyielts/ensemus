import { requestStopProcessRun, getProcessRun } from '@ensemus/application/process-runs';
import { processStopBodySchema } from '@ensemus/contracts/studio';
import { apiRoute, readJson, readIfMatch, etag } from '@/server/api';
import { processRunParams, processRunDto } from '@/server/process-run-api';
import { studioOnce } from '@/server/studio-api';
import { webProductPorts } from '@/server/product-ports';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(processRunParams, async ({ database, context, params, request }) => {
  await readJson(request, processStopBodySchema);
  const input = { runId: params.processRunId, expectedVersion: readIfMatch(request) };
  const id = await studioOnce(
    database,
    context,
    request.headers.get('idempotency-key') ?? '',
    'process-run.stop',
    input,
    // The stored response comes from the service's own transaction result, which names the run.
    (db) => requestStopProcessRun(db, context, input),
    202,
  );
  const row = await getProcessRun(database, context, webProductPorts(), id);
  return Response.json(processRunDto(row), { status: 202, headers: { ETag: etag(row.version) } });
});
