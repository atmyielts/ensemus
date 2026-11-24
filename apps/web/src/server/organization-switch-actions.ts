'use server';

import { requireActor } from './actor';
import { organizationsWithAccess } from './organizations';

export async function loadOrganizationChoices() {
  const { userId } = await requireActor();
  const organizations = await organizationsWithAccess(userId);
  return organizations.map(({ id, name }) => ({ id, name }));
}
