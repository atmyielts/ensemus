// Small steps shared by the stack tests that drive the product through its pages.
import pg from 'pg';
import { expect } from 'vitest';
import { type Form, type Person, submit, type Values } from './forms';

export const locationOf = (response: Response) => response.headers.get('location') ?? '';

/** Only what a person sees, leaving out scripts and the framework's own data in the page. */
export const mainOf = (html: string) =>
  (/<main[\s\S]*<\/main>/.exec(html)?.[0] ?? '').replaceAll('<!-- -->', '');

/** Status as the page states it to a person, not as the database holds it. */
export const statusOn = (html: string) =>
  /<dt>Status<\/dt><dd><span class="badge[^"]*">([^<]+)</.exec(html)?.[1];

/** One card of a page, by the ID of its heading. Empty when the page does not have it. */
export const sectionOf = (html: string, heading: string) =>
  new RegExp(`<section[^>]*aria-labelledby="${heading}"[\\s\\S]*?</section>`)
    .exec(html)?.[0]
    ?.replaceAll('<!-- -->', '') ?? '';

export const toStatus = (to: string) => (form: Form) => form.hidden.get('to') === to;

export const workPage = (organization: string, id: string) => `/o/${organization}/work/${id}`;

export async function membershipOf(su: pg.Client, person: Person, organization: string) {
  const { rows } = await su.query(
    `select m.id from org.memberships m join identity.users u on u.id = m.user_id
     where u.email = $1 and m.organization_id = $2`,
    [person.email, organization],
  );
  if (!rows[0]) throw new Error('No membership');
  return rows[0].id as string;
}

export async function createWork(person: Person, organization: string, values: Values) {
  const response = await submit(`/o/${organization}/work/new`, person.jar, /name="title"/, {
    classification: 'internal',
    ...values,
  });
  const id = /\/work\/([0-9a-f-]{36})$/.exec(locationOf(response))?.[1];
  if (!id) throw new Error(`Work not created: ${locationOf(response)}`);
  return id;
}

export async function move(person: Person, organization: string, id: string, ...to: string[]) {
  const page = workPage(organization, id);
  for (const status of to) {
    const response = await submit(page, person.jar, toStatus(status));
    expect(response.status).toBe(303);
    expect(locationOf(response)).toBe(page);
  }
}
