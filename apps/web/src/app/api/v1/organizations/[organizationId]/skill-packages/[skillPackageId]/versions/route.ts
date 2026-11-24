import { idSchema, listSkillVersions } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';
import { skillVersionDto } from '@/server/skill-dto';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(
  organizationParams.extend({ skillPackageId: idSchema }),
  async ({ database, context, params }) => {
    const rows = await listSkillVersions(database, context, params.skillPackageId);
    return Response.json({ items: rows.map(skillVersionDto) });
  },
);
