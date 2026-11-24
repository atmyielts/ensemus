import { idSchema, yankSkillVersion } from '@ensemus/application';
import { yankSkillVersionSchema } from '@ensemus/contracts/skills';
import { apiRoute, etag, organizationParams, readIfMatch, readJson } from '@/server/api';
import { skillVersionDto } from '@/server/skill-dto';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(
  organizationParams.extend({ skillVersionId: idSchema }),
  async ({ database, context, request, params }) => {
    const expectedVersion = readIfMatch(request);
    const body = await readJson(request, yankSkillVersionSchema);
    const version = await yankSkillVersion(database, context, {
      skillVersionId: params.skillVersionId,
      expectedVersion,
      code: body.code,
    });
    return Response.json(skillVersionDto(version), { headers: { ETag: etag(version.version) } });
  },
);
