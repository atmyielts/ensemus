import {
  AppError,
  createSkillPackage,
  listSkillPackages,
  requestHash,
  runIdempotent,
} from '@ensemus/application';
import { createSkillPackageSchema } from '@ensemus/contracts/skills';
import { can } from '@ensemus/domain/policy';
import { apiRoute, etag, idempotencyKeyReused, organizationParams, readJson } from '@/server/api';
import { skillPackageDto } from '@/server/skill-dto';
import { getSkillFeatureGate } from '@/server/skill-runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ request, context, database }) => {
  const cursor = new URL(request.url).searchParams.get('cursor');
  const page = await listSkillPackages(database, context, cursor === null ? {} : { after: cursor });
  return Response.json({ items: page.items.map(skillPackageDto), next_cursor: page.nextCursor });
});

export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  if (context.actorType !== 'user' || !can(context.role, 'skill.manage'))
    throw new AppError('FORBIDDEN');
  const body = await readJson(request, createSkillPackageSchema);
  const classification = body.content_classification ?? 'internal';
  const result = await runIdempotent(
    database,
    context,
    {
      key: request.headers.get('idempotency-key') ?? '',
      requestHash: requestHash([
        'POST',
        'skill-packages',
        body.name,
        body.display_name,
        classification,
      ]),
    },
    (joined) =>
      createSkillPackage(joined, context, getSkillFeatureGate(), {
        name: body.name,
        displayName: body.display_name,
        contentClassification: classification,
      }),
    (row) => ({ status: 201, body: skillPackageDto(row) }),
  );
  if (result.kind === 'conflict') throw idempotencyKeyReused();
  const row = result.body as ReturnType<typeof skillPackageDto>;
  return Response.json(row, { status: result.status, headers: { ETag: etag(row.version) } });
});
