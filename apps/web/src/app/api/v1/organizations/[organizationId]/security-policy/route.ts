import { getSecurityPolicy, updateSecurityPolicy } from '@ensemus/application/security-policy';
import { updateSecurityPolicySchema } from '@ensemus/contracts/identity-admin';
import { apiRoute, organizationParams, readJson, readIfMatch, etag } from '@/server/api';
const dto = (policy: Awaited<ReturnType<typeof getSecurityPolicy>>) => ({
  mfa_for_administration: policy.mfaForAdministration,
  mfa_max_age_seconds: policy.mfaMaxAgeSeconds,
  sso_enforcement: policy.ssoEnforcement,
  version: policy.version,
});
export const GET = apiRoute(organizationParams, async (scope) => {
  const policy = await getSecurityPolicy(scope.database, scope.context);
  return Response.json(dto(policy), {
    headers: { etag: etag(policy.version), 'cache-control': 'no-store' },
  });
});
export const PATCH = apiRoute(organizationParams, async (scope) => {
  const body = await readJson(scope.request, updateSecurityPolicySchema);
  const policy = await updateSecurityPolicy(
    scope.database,
    scope.context,
    { sessionId: scope.sessionId },
    {
      expectedVersion: readIfMatch(scope.request),
      mfaForAdministration: body.mfa_for_administration,
      mfaMaxAgeSeconds: body.mfa_max_age_seconds,
      ssoEnforcement: body.sso_enforcement,
    },
  );
  return Response.json(dto(policy), {
    headers: { etag: etag(policy.version), 'cache-control': 'no-store' },
  });
});
