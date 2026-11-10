// Roles change the way an owner changes them: through the people page's own form. The shared world's
// people keep the roles it gave them (Bob and Carol are members), so a spec that needs an administrator
// makes one in an organization of its own, and a new member changes nothing in the shared one.
import { createOrganization, join, signUp, submit, type Person } from '../../helpers/forms';

export async function makeAdmin(owner: Person, organization: string, person: Person) {
  const saved = await submit(
    `/o/${organization}/people`,
    owner.jar,
    (form) => form.html.includes(`Save access for ${person.name}`),
    { role: 'admin' },
  );
  if (saved.status >= 400 || (saved.headers.get('location') ?? '').includes('error='))
    throw new Error(`TEST_ADMIN_NOT_SAVED_${saved.status}`);
}

/** An owner, their own organization, and an administrator in it. */
export async function organizationWithAdmin(label: string) {
  const owner = await signUp(`${label} owner`);
  const organization = await createOrganization(owner, `${label} company`);
  const admin = await join(owner, organization, `${label} administrator`);
  await makeAdmin(owner, organization, admin);
  return { owner, organization, admin };
}
