import { idSchema, listSkillVersions, uploadSkillBundle } from '@ensemus/application';
import { SKILL_BUNDLE_MEDIA_TYPE, SKILL_BUNDLE_MAX_BYTES } from '@ensemus/domain/skill';
import { apiRoute, etag, organizationParams, readSkillBundleBody } from '@/server/api';
import { getStore } from '@/server/runtime';
import { skillVersionDto } from '@/server/skill-dto';
import { getSkillFeatureGate } from '@/server/skill-runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(
  organizationParams.extend({ skillPackageId: idSchema }),
  async ({ database, context, params }) => {
    const rows = await listSkillVersions(database, context, params.skillPackageId);
    return Response.json({ items: rows.map(skillVersionDto) });
  },
);

export const POST = apiRoute(
  organizationParams.extend({ skillPackageId: idSchema }),
  async ({ database, context, params, request }) => {
    const bytes = await readSkillBundleBody(
      request,
      SKILL_BUNDLE_MEDIA_TYPE,
      SKILL_BUNDLE_MAX_BYTES,
    );
    const version = await uploadSkillBundle(database, getStore(), context, getSkillFeatureGate(), {
      packageId: params.skillPackageId,
      bytes,
    });
    return Response.json(skillVersionDto(version), {
      status: 202,
      headers: { ETag: etag(version.version) },
    });
  },
);
