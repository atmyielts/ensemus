import { previewGrantInvitation } from '@ensemus/application';
import { redeemInvitationSchema } from '@ensemus/contracts/federation';
import { organizationParams, readJson } from '@/server/api';
import { federationJson, federationRoute, invitationDto } from '@/server/federation-api';

export const POST = federationRoute(organizationParams, async ({ database, context, request }) => {
  const body = await readJson(request, redeemInvitationSchema);
  return federationJson(invitationDto(await previewGrantInvitation(database, context, body)));
});
