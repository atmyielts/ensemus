import { idSchema, publishSkillVersion } from '@ensemus/application';
import { apiRoute, etag, organizationParams, readIfMatch } from '@/server/api';
import { skillVersionDto } from '@/server/skill-dto';
import { getSkillFeatureGate } from '@/server/skill-runtime';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(
  organizationParams.extend({ skillVersionId: idSchema }),
  async ({ database, context, request, params }) => {
    const version = await publishSkillVersion(database, context, getSkillFeatureGate(), {
      skillVersionId: params.skillVersionId,
      expectedVersion: readIfMatch(request),
    });
    return Response.json(skillVersionDto(version), { headers: { ETag: etag(version.version) } });
  },
);
