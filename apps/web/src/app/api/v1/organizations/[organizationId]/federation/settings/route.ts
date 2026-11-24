import { getFederationSettings, setFederationEnabled } from '@ensemus/application';
import { setFederationSettingsSchema } from '@ensemus/contracts/federation';
import { organizationParams, readJson } from '@/server/api';
import {
  federationEntitlement,
  federationJson,
  federationRoute,
  settingsDto,
} from '@/server/federation-api';

export const GET = federationRoute(organizationParams, async ({ database, context }) =>
  federationJson(settingsDto(await getFederationSettings(database, context))),
);

export const PUT = federationRoute(organizationParams, async ({ database, context, request }) => {
  const body = await readJson(request, setFederationSettingsSchema);
  const updated = await setFederationEnabled(
    database,
    context,
    {
      enabled: body.enabled,
      expectedVersion: body.expected_version,
    },
    federationEntitlement(database),
  );
  return federationJson(settingsDto(updated));
});
