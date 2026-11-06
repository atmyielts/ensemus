import { linkImportedPerson } from '@ensemus/application';
import { linkImportedPersonSchema } from '@ensemus/contracts/sovereign';
import { apiRoute, readJson } from '@/server/api';
import { importedPersonDto, importedPersonParams } from '@/server/sovereign-dto';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(importedPersonParams, async ({ request, context, database, params }) => {
  const body = await readJson(request, linkImportedPersonSchema);
  const linked = await linkImportedPerson(database, context, {
    sourceMembershipId: params.sourceMembershipId,
    membershipId: body.membership_id,
  });
  return Response.json(importedPersonDto(linked));
});
