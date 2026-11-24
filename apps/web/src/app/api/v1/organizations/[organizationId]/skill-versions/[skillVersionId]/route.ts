import { getSkillVersion, idSchema } from '@ensemus/application';
import { apiRoute, etag, organizationParams } from '@/server/api';
import { skillVersionDto } from '@/server/skill-dto';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(
  organizationParams.extend({ skillVersionId: idSchema }),
  async ({ database, context, params }) => {
    const row = await getSkillVersion(database, context, params.skillVersionId);
    return Response.json(skillVersionDto(row), { headers: { ETag: etag(row.version) } });
  },
);
