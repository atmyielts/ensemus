// UX-12, UX-13, UX-15: what the pages say and what a repeated form does, through real forms with
// JavaScript off, against built images.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWork, locationOf, move, sectionOf, workPage } from '../helpers/flows';
import {
  createOrganization,
  type Form,
  formOn,
  join,
  type Person,
  post,
  read,
  signUp,
  submit,
} from '../helpers/forms';
import { eventsPath, openStreams } from '../helpers/streams';

const POLL = { timeout: 15_000, interval: 100 };
const MEGABYTE = 1024 * 1024;

describe('what forms and pages do', () => {
  let owner: Person;
  let member: Person;
  let org: string;
  const streams = openStreams();
  const people = () => `/o/${org}/people`;
  const clients = () => `/o/${org}/clients`;

  beforeAll(async () => {
    owner = await signUp('Olive Owner');
    org = await createOrganization(owner, `Behaviour ${randomUUID()}`);
    member = await join(owner, org, 'Mia Member');
  });

  afterAll(() => streams.closeAll());

  describe('one rendered form, sent twice with scripts off', () => {
    const occurrences = (html: string, text: string) => html.split(text).length - 1;

    it('adds one client', async () => {
      const name = `Client ${randomUUID()}`;
      const form = await formOn(clients(), owner.jar, /name="displayName"/);
      await post(clients(), owner.jar, form, { displayName: name });
      await post(clients(), owner.jar, form, { displayName: name });
      const { html } = await read(clients(), owner.jar);
      expect(occurrences(sectionOf(html, 'clients-heading'), name)).toBe(1);
    });

    it('adds one project', async () => {
      const name = `Project ${randomUUID()}`;
      const form = await formOn(clients(), owner.jar, /Add project/);
      await post(clients(), owner.jar, form, { name });
      await post(clients(), owner.jar, form, { name });
      const { html } = await read(clients(), owner.jar);
      expect(occurrences(sectionOf(html, 'projects-heading'), `>${name}<`)).toBe(1);
    });

    it('adds one team', async () => {
      const name = `Team ${randomUUID()}`;
      const form = await formOn(people(), owner.jar, /Create team/);
      await post(people(), owner.jar, form, { name });
      await post(people(), owner.jar, form, { name });
      const { html } = await read(people(), owner.jar);
      expect(occurrences(sectionOf(html, 'teams-heading'), `<strong>${name}</strong>`)).toBe(1);
    });

    it('attaches one file', async () => {
      const id = await createWork(owner, org, { title: `Upload ${randomUUID()}` });
      const form = await formOn(workPage(org, id), owner.jar, /name="file"/);
      const send = (text: string) =>
        post(workPage(org, id), owner.jar, form, {
          file: new File([text], 'twice.txt', { type: 'text/plain' }),
        });
      await send('the same bytes');
      await send('the same bytes');
      const files = () => read(workPage(org, id), owner.jar);
      expect(occurrences(sectionOf((await files()).html, 'files-heading'), '>twice.txt<')).toBe(1);
      // Other bytes from that same form are another file, and are not dropped.
      await send('other bytes');
      expect(occurrences(sectionOf((await files()).html, 'files-heading'), '>twice.txt<')).toBe(2);
    });

    it('keeps what was typed when the form is sent again with something else', async () => {
      const path = `/o/${org}/work/new`;
      const form = await formOn(path, owner.jar, /name="title"/);
      const send = (title: string) =>
        post(path, owner.jar, form, { title, classification: 'internal' });
      const [first, second] = [`Typed A ${randomUUID()}`, `Typed B ${randomUUID()}`];
      const a = await send(first);
      const b = await send(second);
      expect(locationOf(b)).not.toBe(locationOf(a));
      expect((await read(locationOf(a), owner.jar)).html).toContain(first);
      expect((await read(locationOf(b), owner.jar)).html).toContain(second);
    });

    it('makes the organization that was typed, not the earlier one', async () => {
      const person = await signUp('Two Names');
      const form = await formOn('/', person.jar, /Create organization/);
      const [first, second] = [`First ${randomUUID()}`, `Second ${randomUUID()}`];
      const a = await post('/', person.jar, form, { name: first });
      const b = await post('/', person.jar, form, { name: second });
      expect(locationOf(b)).not.toBe(locationOf(a));
      const { html } = await read('/', person.jar);
      expect(html).toContain(first);
      expect(html).toContain(second);
    });
  });

  it('names the limit when a file is too large', async () => {
    const id = await createWork(owner, org, { title: `Too big ${randomUUID()}` });
    const page = workPage(org, id);
    const refused = await submit(page, owner.jar, /name="file"/, {
      file: new File([Buffer.alloc(25 * MEGABYTE + 1)], 'big.bin'),
    });
    expect(locationOf(refused)).toBe(`${page}?error=FILE_TOO_LARGE`);
    const { html } = await read(locationOf(refused), owner.jar);
    expect(html).toContain('That file is larger than 25 MB');
    expect(sectionOf(html, 'files-heading')).not.toContain('big.bin');
  });

  it('does not say everything is listed on Home when it is not', async () => {
    const person = await join(owner, org, 'Busy Person');
    for (let i = 0; i < 13; i += 1) {
      await createWork(person, org, { title: `Late ${i} ${randomUUID()}`, dueAt: '2020-01-02' });
    }
    const mine = sectionOf((await read(`/o/${org}`, person.jar)).html, 'mine-heading');
    expect(mine).not.toContain('Everything you are on is listed above');
    expect(mine).toContain('there is more');
    expect(mine).toContain(`href="/o/${org}/work"`);
  });

  describe('the sentence about a plan', () => {
    const PRESS = 'presses Run the plan';
    const progress = async (id: string) =>
      sectionOf((await read(workPage(org, id), owner.jar)).html, 'progress-heading');

    it('only says it has to be started while it does', async () => {
      const id = await createWork(owner, org, {
        title: `Planned ${randomUUID()}`,
        executionPlan: 'checklist',
      });
      expect(await progress(id)).toContain(PRESS);
      await move(owner, org, id, 'ready');
      expect(await progress(id)).toContain(PRESS);
      await move(owner, org, id, 'running');
      expect(await progress(id)).not.toContain(PRESS);
      expect(await progress(id)).toContain('started by hand');
      await move(owner, org, id, 'verifying');
      expect(await progress(id)).not.toContain(PRESS);
    });
  });

  it('says who owns each item in the work list, and how its evidence stands (UX-13)', async () => {
    const title = `Listed ${randomUUID()}`;
    const none = await createWork(owner, org, { title: `${title} none` });
    const asked = await createWork(member, org, {
      title: `${title} asked`,
      criteria: 'artifact_exists',
    });
    const { html } = await read(`/o/${org}/work`, owner.jar);
    const row = (id: string) =>
      new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*/work/${id}"(?:(?!</tr>)[\\s\\S])*</tr>`)
        .exec(html)?.[0]
        .replaceAll('<!-- -->', '');
    // The owner is named under each title, labelled for screen readers; Done when has its own column.
    expect(html).toMatch(/>\s*Done when\s*<\/th>/);
    expect(row(none)).toContain('Owner: </span>Olive Owner');
    expect(row(none)).toContain('Owner confirms');
    expect(row(asked)).toContain('Owner: </span>Mia Member');
    expect(row(asked)).toContain('1 of 1 still needed');

    await submit(workPage(org, asked), member.jar, /name="file"/, {
      file: new File(['proof'], 'proof.txt', { type: 'text/plain' }),
    });
    const after = (await read(`/o/${org}/work`, owner.jar)).html;
    expect(after).toContain('In place');
  });

  it('shows who is on a team to those on it, and to owners and admins (UX-15)', async () => {
    const [mine, theirs] = [`Mine ${randomUUID()}`, `Theirs ${randomUUID()}`];
    const someone = await join(owner, org, 'Quentin Elsewhere');
    await submit(people(), owner.jar, /Create team/, { name: mine });
    await submit(people(), owner.jar, /Create team/, { name: theirs });
    const addTo = (team: string) => (form: Form) =>
      form.html.replaceAll('<!-- -->', '').includes(`Add to ${team}`);
    const pick = async (team: string, person: Person) => {
      const form = await formOn(people(), owner.jar, addTo(team));
      const option = new RegExp(`<option value="([^"]+)">${person.name}<`).exec(form.html)?.[1];
      await post(people(), owner.jar, form, { membershipId: option as string });
    };
    await pick(mine, member);
    await pick(theirs, someone);

    const seen = sectionOf((await read(people(), member.jar)).html, 'teams-heading');
    expect(seen).toContain(`<strong>${mine}</strong>`);
    expect(seen).toContain(`<strong>${theirs}</strong>`);
    expect(seen).toContain('Mia Member');
    expect(seen).not.toContain('Quentin Elsewhere');
    expect(seen).toContain('1 person.');
    expect(seen).not.toContain('@');

    expect(sectionOf((await read(people(), owner.jar)).html, 'teams-heading')).toContain(
      'Quentin Elsewhere',
    );
  });

  describe('following a Work Unit', () => {
    it('tells a page about a file, without the version moving', async () => {
      const id = await createWork(owner, org, { title: `Followed ${randomUUID()}` });
      const stream = await streams.follow(owner.jar, `${eventsPath(org, id)}?include=evidence`);
      const evidence = () => stream.received.filter((event) => event.event === 'evidence');
      await expect.poll(() => evidence().length, POLL).toBe(1);
      await submit(workPage(org, id), owner.jar, /name="file"/, {
        file: new File(['proof'], 'proof.txt', { type: 'text/plain' }),
      });
      await expect.poll(() => evidence().length, POLL).toBe(2);
      expect(evidence()[1]?.data).not.toBe(evidence()[0]?.data);
      expect(evidence().every((event) => event.id === undefined)).toBe(true);
      expect(stream.received.filter((event) => event.event === 'status')).toEqual([
        { event: 'status', id: '1', data: '1' },
      ]);
      expect(stream.raw()).not.toContain('proof.txt');
    });

    it('sends nothing but status to whoever did not ask', async () => {
      const id = await createWork(owner, org, { title: `Plain ${randomUUID()}` });
      const stream = await streams.follow(owner.jar, eventsPath(org, id));
      await expect.poll(() => stream.received.length, POLL).toBe(1);
      await submit(workPage(org, id), owner.jar, /name="file"/, {
        file: new File(['proof'], 'proof.txt', { type: 'text/plain' }),
      });
      await new Promise((done) => setTimeout(done, 2_500));
      expect(stream.received).toEqual([{ event: 'status', id: '1', data: '1' }]);
    });

    it('refuses an include it does not know', async () => {
      const id = await createWork(owner, org, { title: `Odd ${randomUUID()}` });
      const stream = await streams.follow(owner.jar, `${eventsPath(org, id)}?include=everything`);
      expect(stream.status).toBe(400);
    });
  });
});
