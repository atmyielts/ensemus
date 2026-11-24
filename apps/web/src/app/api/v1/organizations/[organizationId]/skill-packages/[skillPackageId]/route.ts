import { getSkillPackage, idSchema, updateSkillPackage } from '@ensemus/application';
import { updateSkillPackageSchema } from '@ensemus/contracts/skills';
import { apiRoute, etag, organizationParams, readIfMatch, readJson } from '@/server/api';
import { skillPackageDto } from '@/server/skill-dto';

export const dynamic = 'force-dynamic';

const paramsSchema = organizationParams.extend({ skillPackageId: idSchema });

export const GET = apiRoute(paramsSchema, async ({ context, database, params }) => {
  const row = await getSkillPackage(database, context, params.skillPackageId);
  return Response.json(skillPackageDto(row), { headers: { ETag: etag(row.version) } });
});

export const PATCH = apiRoute(paramsSchema, async ({ request, context, database, params }) => {
  const expectedVersion = readIfMatch(request);
  const body = await readJson(request, updateSkillPackageSchema);
  const row = await updateSkillPackage(database, context, {
    packageId: params.skillPackageId,
    expectedVersion,
    ...(body.display_name === undefined ? {} : { displayName: body.display_name }),
    ...(body.state === undefined ? {} : { state: body.state }),
    ...(body.content_classification === undefined
      ? {}
      : { contentClassification: body.content_classification }),
  });
  return Response.json(skillPackageDto(row), { headers: { ETag: etag(row.version) } });
});
