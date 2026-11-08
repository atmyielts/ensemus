import { listProcessRuns, startProcessRun, getProcessRun } from '@ensemus/application/process-runs';
import {
  startProcessRunSchema,
  processRunsQuerySchema,
  processRunListSchema,
} from '@ensemus/contracts/studio';
import { apiRoute, organizationParams, readQuery, readJson, etag } from '@/server/api';
import { processRunDto } from '@/server/process-run-api';
import { studioOnce } from '@/server/studio-api';
import { webProductPorts } from '@/server/product-ports';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(organizationParams, async ({ database, context, request }) => {
  const query = readQuery(request, processRunsQuerySchema),
    page = await listProcessRuns(database, context, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.after === undefined ? {} : { after: query.after }),
    });
  return Response.json(
    processRunListSchema.parse({ items: page.items.map(processRunDto), next: page.next }),
  );
});
export const POST = apiRoute(organizationParams, async ({ database, context, request }) => {
  const input = await readJson(request, startProcessRunSchema),
    key = request.headers.get('idempotency-key') ?? '';
  const id = await studioOnce(
    database,
    context,
    key,
    'process-run.start',
    input,
    (db) =>
      startProcessRun(db, context, {
        specId: input.spec_id,
        title: input.title,
        ...(input.due_at === undefined ? {} : { dueAt: new Date(input.due_at) }),
        requestKey: key,
      }),
    202,
  );
  const row = await getProcessRun(database, context, webProductPorts(), id);
  return Response.json(processRunDto(row), { status: 202, headers: { ETag: etag(row.version) } });
});
