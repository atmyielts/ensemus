import { listImportedPeople } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';
import { importedPersonDto } from '@/server/sovereign-dto';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  const people = await listImportedPeople(database, context);
  return Response.json({ items: people.map(importedPersonDto) });
});
