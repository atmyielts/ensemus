import { listMyOutcomeDrafts } from '@ensemus/application/outcomes';
import { composeOutcomeSchema } from '@ensemus/contracts/experience';
import { apiRoute, organizationParams, readJson, etag } from '@/server/api';
import { composeOnce, outcomeDto } from '@/server/experience-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(organizationParams, async ({ database, context }) =>
  Response.json({ items: (await listMyOutcomeDrafts(database, context)).map(outcomeDto) }),
);
export const POST = apiRoute(organizationParams, async ({ database, context, request }) => {
  const body = await readJson(request, composeOutcomeSchema),
    draft = await composeOnce(
      database,
      context,
      request.headers.get('idempotency-key') ?? '',
      body,
    );
  return Response.json(outcomeDto(draft), { status: 201, headers: { ETag: etag(draft.version) } });
});
