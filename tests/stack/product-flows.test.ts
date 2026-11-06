// ID-01, ID-02, UX-12 to UX-15, WORK-04, WORK-05, NEXT-01, NEXT-03, SEC-12: the product end to end
// through its real forms and pages, against built images, with JavaScript off.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  formOn,
  type Form,
  type Jar,
  join,
  PASSWORD,
  type Person,
  post,
  read,
  signUp,
  submit,
  tokenIn,
  type Values,
  visit,
} from '../helpers/forms';
import { compose, urls } from '../helpers/stack';

const PLAN_TIMEOUT = 45_000;
const BASE_URL = 'https://x.invalid';

/** Status as the page states it to a person, not as the database holds it. */
const statusOn = (html: string) =>
  /<dt>Status<\/dt><dd><span class="badge[^"]*">([^<]+)</.exec(html)?.[1];

const locationOf = (response: Response) => response.headers.get('location') ?? '';

/** Only what a person sees, leaving out scripts and the framework's own data in the page. */
const mainOf = (html: string) => /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? '';

describe('the product through its forms', () => {
  let su: pg.Client;
  const tenantName = `Acme ${randomUUID()}`;
  const rivalName = `Rival ${randomUUID()}`;
  let owner: Person;
  let member: Person;
  let reviewer: Person;
  let rival: Person;
  let org: string;
  let rivalOrg: string;

  const people = (organization: string) => `/o/${organization}/people`;
  const workPage = (id: string, organization = org) => `/o/${organization}/work/${id}`;

  /** Invites through the people page, and returns the token from the link in its response. */
  async function invite(by: Person, organization: string, email: string, role = 'member') {
    const response = await submit(people(organization), by.jar, /name="email"/, { email, role });
    expect(response.status).toBe(200);
    // The credential is in this one response, and in no URL.
    expect(locationOf(response)).toBe('');
    const token = tokenIn(await response.text());
    if (!token) throw new Error('No invitation link in the response');
    return token;
  }

  /** What an email verification would do, once the product has mail to send it with. */
  const verifyEmail = (email: string) =>
    su.query('update identity.users set email_verified = true where email = $1', [email]);

  const accept = async (person: Person, token: string) => {
    await verifyEmail(person.email);
    return submit(`/invite/${token}`, person.jar, /Accept invitation/);
  };

  async function membershipOf(person: Person, organization = org): Promise<string> {
    const { rows } = await su.query(
      `select m.id from org.memberships m join identity.users u on u.id = m.user_id
       where u.email = $1 and m.organization_id = $2`,
      [person.email, organization],
    );
    if (!rows[0]) throw new Error('No membership');
    return rows[0].id;
  }

  async function createWork(person: Person, values: Values, organization = org) {
    const response = await submit(`/o/${organization}/work/new`, person.jar, /name="title"/, {
      classification: 'internal',
      ...values,
    });
    const id = /\/work\/([0-9a-f-]{36})$/.exec(locationOf(response))?.[1];
    if (!id) throw new Error(`Work not created: ${locationOf(response)}`);
    return id;
  }

  const toStatus = (to: string) => (form: Form) => form.hidden.get('to') === to;

  async function move(person: Person, id: string, to: string, organization = org) {
    const page = workPage(id, organization);
    const response = await submit(page, person.jar, toStatus(to));
    expect(response.status).toBe(303);
    expect(locationOf(response)).toBe(page);
  }

  async function upload(person: Person, id: string, file: File) {
    const page = workPage(id);
    const response = await submit(page, person.jar, /name="file"/, { file });
    expect(response.status).toBe(303);
    expect(locationOf(response)).toBe(page);
    const { html } = await read(page, person.jar);
    const name = file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const link = new RegExp(`href="([^"]+/files/[0-9a-f-]{36})">${name}<`).exec(html)?.[1];
    if (!link) throw new Error(`No link to ${file.name}`);
    return link;
  }

  const artifactIn = (link: string) => link.slice(link.lastIndexOf('/') + 1);

  async function workRow(id: string) {
    const { rows } = await su.query(
      'select status, version::int as version from work.work_units where id = $1',
      [id],
    );
    return rows[0];
  }

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    owner = await signUp('Olive Owner');
    org = await createOrganization(owner, tenantName);
    member = await join(owner, org, 'Milo Member');
    reviewer = await join(owner, org, 'Remy Reviewer');
    rival = await signUp('Rita Rival');
    rivalOrg = await createOrganization(rival, rivalName);
  });

  afterAll(() => su?.end());

  describe('first organization (ID-01)', () => {
    it('states the responsibility for data and models for this mode before anything exists', async () => {
      const person = await signUp('New Owner');
      const { status, html } = await read('/', person.jar);
      expect(status).toBe(200);
      expect(html).toContain('Who is responsible for your data');
      expect(html).toContain('AI features are not active yet');
      const mode = process.env.ENSEMUS_MODE ?? 'sovereign';
      const expected: Record<string, string> = {
        cloud: 'Ensemus supplies the approved AI model providers',
        byom: 'This is not zero-knowledge',
        sovereign: 'on infrastructure it controls',
      };
      expect(html).toContain(expected[mode]);
      expect(mainOf(html)).not.toMatch(/SOC ?2|ISO ?27001|HIPAA|certified/i);
    });

    it('brings a new owner into a working organization', async () => {
      const person = await signUp('Second Owner');
      const name = `Org ${randomUUID()}`;
      const id = await createOrganization(person, name);
      const home = await read(`/o/${id}`, person.jar);
      expect(home.status).toBe(200);
      expect(home.html).toContain(name);
      expect(home.html).toContain('Hello, Second');
      expect(await visit(`/o/${id}/work/new`, person.jar).then((r) => r.status)).toBe(200);
    });

    it('goes straight to an only organization, and lists several with the role in each', async () => {
      const person = await signUp('Two Orgs');
      // Kept from before the first one exists, since the setup form then stops being offered.
      const form = await formOn('/', person.jar, /Create organization/);
      const [first, second] = [`Org A ${randomUUID()}`, `Org B ${randomUUID()}`];
      const created = await post('/', person.jar, form, { name: first });
      const only = await visit('/', person.jar);
      expect([303, 307]).toContain(only.status);
      expect(only.headers.get('location')).toBe(locationOf(created));

      // A form of its own, since one form makes one organization.
      await post('/', person.jar, form, { name: second, requestKey: randomUUID() });
      const { status, html } = await read('/', person.jar);
      expect(status).toBe(200);
      expect(html).toContain(first);
      expect(html).toContain(second);
      expect(html).toContain(`href="${locationOf(created)}"`);
      expect(html).toContain('>Owner<');
    });

    it('makes one organization from one form, however many times it is sent', async () => {
      const person = await signUp('Double Click');
      const form = await formOn('/', person.jar, /Create organization/);
      const name = `Once ${randomUUID()}`;
      const [first, second] = await Promise.all([
        post('/', person.jar, form, { name }),
        post('/', person.jar, form, { name }),
      ]);
      const third = await post('/', person.jar, form, { name });
      expect(locationOf(first)).toMatch(/^\/o\/[0-9a-f-]{36}$/);
      expect(locationOf(second)).toBe(locationOf(first));
      expect(locationOf(third)).toBe(locationOf(first));
      const { rows } = await su.query(
        `select count(*)::int as n from org.memberships m
         join identity.users u on u.id = m.user_id where u.email = $1`,
        [person.email],
      );
      expect(rows[0].n).toBe(1);
      expect((await read(locationOf(first), person.jar)).status).toBe(200);
    });

    it('shows that it is working on every form before you are in', async () => {
      const person = await signUp('Pending Forms');
      const token = await invite(owner, org, person.email);
      for (const [page, jar, match] of [
        ['/sign-in', undefined, /Sign in/],
        ['/sign-up', undefined, /Create account/],
        ['/', person.jar, /Create organization/],
        [`/invite/${token}`, person.jar, /Accept invitation/],
      ] as const) {
        const form = await formOn(page, jar, match);
        expect(form.html, page).toContain('class="pending"');
        expect(form.html, page).toContain('type="submit"');
      }
    });

    it('shows a plain page for what does not exist', async () => {
      const { status, html } = await read(`/nothing-here-${randomUUID()}`);
      expect(status).toBe(404);
      expect(html).toContain('Page not found');
      expect(html).toContain('href="/"');
    });
  });

  describe('invitations (ID-02)', () => {
    it('invites through the people page, and joins through the invitation page', async () => {
      const person = await signUp('Ivy Invited');
      const token = await invite(owner, org, person.email);

      const response = await accept(person, token);
      expect(response.status).toBe(303);
      expect(locationOf(response)).toBe(`/o/${org}`);
      const home = await read(`/o/${org}`, person.jar);
      expect(home.status).toBe(200);
      expect(home.html).toContain(tenantName);
      // It grants the organization and role it names, and nothing else.
      const { rows } = await su.query('select role, status from org.memberships where id = $1', [
        await membershipOf(person),
      ]);
      expect(rows[0]).toEqual({ role: 'member', status: 'active' });
      expect((await read(`/o/${rivalOrg}`, person.jar)).status).toBe(404);
    });

    it('never puts the link in a URL, and shows it only in the response that made it', async () => {
      const person = await signUp('Ivy Unseen');
      const token = await invite(owner, org, person.email);
      // Reloading, or going back, finds no trace of it.
      expect((await read(people(org), owner.jar)).html).not.toContain(token);
      // The old address form does nothing now, so a crafted link cannot show a false notice.
      const crafted = await read(`${people(org)}?invited=${'c'.repeat(43)}`, owner.jar);
      expect(mainOf(crafted.html)).not.toContain('c'.repeat(43));
      expect(mainOf(crafted.html)).not.toContain('Invitation link');
    });

    it('makes an account with an unproven address wait for someone to confirm it', async () => {
      const person = await signUp('Una Unverified');
      const token = await invite(owner, org, person.email, 'admin');
      const asked = await submit(`/invite/${token}`, person.jar, /Accept invitation/);
      expect(locationOf(asked)).toBe(`/invite/${token}?state=waiting`);
      expect((await read(locationOf(asked), person.jar)).html).toContain(
        'Waiting for confirmation',
      );
      // Holding the link and the address got them nothing yet.
      expect((await read(`/o/${org}`, person.jar)).status).toBe(404);

      const confirming = (form: Form) => form.html.includes(`Confirm ${person.email}`);
      // Confirming has to be meant.
      const unticked = await submit(people(org), owner.jar, confirming);
      expect(locationOf(unticked)).toBe(`${people(org)}?error=INVALID_INPUT`);
      expect((await read(`/o/${org}`, person.jar)).status).toBe(404);

      const confirmed = await submit(people(org), owner.jar, confirming, { confirm: 'yes' });
      expect(locationOf(confirmed)).toBe(people(org));
      expect((await read(`/o/${org}`, person.jar)).status).toBe(200);
    });

    it('stops working once the person who sent it is disabled', async () => {
      const inviter = await join(owner, org, 'Mallory Inviter');
      const made = await submit(
        people(org),
        owner.jar,
        (f) =>
          f.hidden.get('membershipId') === undefined
            ? false
            : f.html.includes(`Save access for ${inviter.name}`),
        { role: 'admin' },
      );
      expect(locationOf(made)).toBe(people(org));
      const alias = await signUp('Mallory Alias');
      const token = await invite(inviter, org, alias.email, 'admin');
      const target = await membershipOf(inviter);
      await submit(
        people(org),
        owner.jar,
        (f) => f.hidden.get('membershipId') === target && />Disable</.test(f.html),
        { confirm: 'yes' },
      );
      const after = await accept(alias, token);
      expect(locationOf(after)).toBe(`/invite/${token}?error=INVITATION_INVALID`);
      expect((await read(`/o/${org}`, alias.jar)).status).toBe(404);
    });

    it('reveals nothing about the organization before it is accepted', async () => {
      const person = await signUp('Nora Nosy');
      const token = await invite(owner, org, person.email);
      for (const jar of [undefined, person.jar, (await signUp('Someone Else')).jar]) {
        const { status, html } = await read(`/invite/${token}`, jar);
        expect(status).toBe(200);
        expect(html).not.toContain(tenantName);
        expect(html).not.toContain(org);
        expect(html).not.toContain(owner.email);
        expect(html).not.toContain(owner.name);
      }
      const anonymous = await read(`/invite/${token}`);
      expect(anonymous.html).not.toContain(person.email);
      // A guessed token gets the same page as a real one.
      const guess = await read(`/invite/${'g'.repeat(43)}`);
      expect(guess.status).toBe(200);
      expect(mainOf(guess.html).replaceAll('g'.repeat(43), 'TOKEN')).toBe(
        mainOf(anonymous.html).replaceAll(token, 'TOKEN'),
      );
    });

    it('keeps its place through sign-up and through sign-in', async () => {
      const here = (token: string) => `/invite/${token}`;
      const encoded = (token: string) => encodeURIComponent(here(token));

      const newcomer = `newcomer-${randomUUID()}@example.invalid`;
      const forNewcomer = await invite(owner, org, newcomer);
      const page = await read(here(forNewcomer));
      expect(page.html).toContain(`href="/sign-up?next=${encoded(forNewcomer)}"`);
      expect(page.html).toContain(`href="/sign-in?next=${encoded(forNewcomer)}"`);
      const form = await formOn(`/sign-up?next=${encoded(forNewcomer)}`, undefined, /password/);
      expect(form.hidden.get('next')).toBe(here(forNewcomer));
      const jar: Jar = { cookie: '' };
      const created = await post(`/sign-up?next=${encoded(forNewcomer)}`, jar, form, {
        name: 'Newcomer',
        email: newcomer,
        password: PASSWORD,
      });
      expect(locationOf(created)).toBe(here(forNewcomer));
      await verifyEmail(newcomer);
      const joined = await submit(here(forNewcomer), jar, /Accept invitation/);
      expect(locationOf(joined)).toBe(`/o/${org}`);

      const person = await signUp('Back Again');
      const forPerson = await invite(owner, org, person.email);
      const out = await submit(here(forPerson), person.jar, /Use a different account/);
      expect(locationOf(out)).toBe(`/sign-in?next=${encoded(forPerson)}`);
      const fresh: Jar = { cookie: '' };
      const signInPage = `/sign-in?next=${encoded(forPerson)}`;
      const wrong = await submit(signInPage, fresh, /name="password"/, {
        email: person.email,
        password: 'not the right password',
      });
      expect(locationOf(wrong)).toBe(`/sign-in?error=invalid&next=${encoded(forPerson)}`);
      const back = await submit(signInPage, fresh, /name="password"/, {
        email: person.email,
        password: PASSWORD,
      });
      expect(locationOf(back)).toBe(here(forPerson));
    });

    it('never returns anywhere but an invitation on this site', async () => {
      const person = await signUp('Open Redirect');
      const token = 'a'.repeat(43);
      const hostile = [
        '//evil.example',
        'https://evil.example',
        `https://evil.example/invite/${token}`,
        `//evil.example/invite/${token}`,
        '/\\evil.example',
        `/invite/${token}/../../sign-in`,
        `/invite/..%2F..%2F${token}`,
        `/invite/${token}?then=https://evil.example`,
        `/invite/${token}#fragment`,
        `/invite/${token}\n`,
        '/o/anything',
        '',
      ];
      for (const next of hostile) {
        const page = `/sign-in?next=${encodeURIComponent(next)}`;
        const form = await formOn(page, undefined, /name="password"/);
        expect(form.hidden.has('next'), next).toBe(false);
        expect((await read(page)).html).not.toMatch(/href="[^"]*evil\.example/);
        // The hidden field is the client's to forge, so the action checks it again.
        const response = await post(page, { cookie: '' }, form, {
          next,
          email: person.email,
          password: PASSWORD,
        });
        expect(locationOf(response), next).toBe('/');
      }
    });

    it('works once, and only for the person it was sent to', async () => {
      const person = await signUp('Only Once');
      const stranger = await signUp('Not Invited');
      const token = await invite(owner, org, person.email);
      const stolen = await accept(stranger, token);
      expect(locationOf(stolen)).toBe(`/invite/${token}?error=INVITATION_INVALID`);
      expect((await read(locationOf(stolen), stranger.jar)).html).toContain(
        'This invitation is not valid',
      );
      expect((await read(`/o/${org}`, stranger.jar)).status).toBe(404);

      expect(locationOf(await accept(person, token))).toBe(`/o/${org}`);
      const again = await accept(person, token);
      expect(locationOf(again)).toBe(`/invite/${token}?error=INVITATION_INVALID`);
    });

    it('stops working once withdrawn or expired, with the same answer as a guess', async () => {
      const withdrawn = await signUp('Withdrawn');
      const expired = await signUp('Expired');
      const withdrawnToken = await invite(owner, org, withdrawn.email);
      const expiredToken = await invite(owner, org, expired.email);
      const { rows } = await su.query(
        'select id from org.invitations where email = $1 and organization_id = $2',
        [withdrawn.email, org],
      );
      const response = await submit(
        people(org),
        owner.jar,
        (form) => form.hidden.get('invitationId') === rows[0].id,
      );
      expect(response.status).toBe(303);
      await su.query(
        `update org.invitations set expires_at = now() - interval '1 second'
         where email = $1 and organization_id = $2`,
        [expired.email, org],
      );

      const invalid = (token: string) => `/invite/${token}?error=INVITATION_INVALID`;
      expect(locationOf(await accept(withdrawn, withdrawnToken))).toBe(invalid(withdrawnToken));
      expect(locationOf(await accept(expired, expiredToken))).toBe(invalid(expiredToken));
      const guess = 'x'.repeat(43);
      expect(locationOf(await accept(expired, guess))).toBe(invalid(guess));
      expect((await read(`/o/${org}`, withdrawn.jar)).status).toBe(404);
      expect((await read(`/o/${org}`, expired.jar)).status).toBe(404);
    });

    it('leaves no token in the logs', async () => {
      const person = await signUp('Log Check');
      const token = await invite(owner, org, person.email);
      await read(`/invite/${token}`);
      await accept(person, token);
      for (const service of ['web', 'proxy']) {
        expect(compose('logs', '--no-log-prefix', service)).not.toContain(token);
      }
    });
  });

  describe('work through its pages (UX-13, WORK-01 to WORK-03)', () => {
    it('creates work, then moves it to done through its page', async () => {
      const title = `Work ${randomUUID()}`;
      const id = await createWork(owner, { title, objective: 'Move through each status.' });
      const page = workPage(id);
      const start = await read(page, owner.jar);
      expect(start.status).toBe(200);
      expect(start.html).toContain(title);
      expect(start.html).toContain('Move through each status.');
      expect(statusOn(start.html)).toBe('Waiting to start');
      expect((await read(`/o/${org}/work`, member.jar)).html).toContain(title);

      for (const [to, label] of [
        ['ready', 'Ready'],
        ['running', 'In progress'],
        ['verifying', 'Checking'],
        ['completed', 'Done'],
      ] as const) {
        await move(owner, id, to);
        expect(statusOn((await read(page, owner.jar)).html)).toBe(label);
      }
      // With nothing asked for, the record says plainly whose word it rests on.
      const done = mainOf((await read(page, owner.jar)).html).replaceAll('<!-- -->', '');
      expect(done).toContain(
        `Confirmed by ${owner.name} as accountable owner. No evidence was requested.`,
      );
      expect(done).not.toContain('Its results are under Files');
    });

    it('needs the accountable owner to confirm work that asks for no evidence (QA-006)', async () => {
      const id = await createWork(owner, { title: `Confirm ${randomUUID()}` });
      const page = workPage(id);
      await submit(page, owner.jar, /Add someone/, { membershipId: await membershipOf(member) });
      await move(owner, id, 'ready');
      await move(owner, id, 'running');
      // Going straight to done is not on offer, and a forged request does not get there either.
      const running = await formOn(page, owner.jar, toStatus('verifying'));
      const skipped = await post(page, owner.jar, running, { to: 'completed' });
      expect(locationOf(skipped)).toBe(`${page}?error=INVALID_TRANSITION`);
      await move(owner, id, 'verifying');

      // Someone else on the work can change it, and cannot say it is done.
      const theirs = await read(page, member.jar);
      expect(theirs.html).not.toContain('Confirm this is done');
      expect(mainOf(theirs.html).replaceAll('<!-- -->', '')).toContain(
        `Only ${owner.name}, as accountable owner, can confirm this is done.`,
      );
      const back = await formOn(page, member.jar, toStatus('running'));
      const forged = await post(page, member.jar, back, { to: 'completed' });
      expect(locationOf(forged)).toBe(`${page}?error=OWNER_CONFIRMATION_REQUIRED`);
      expect(statusOn((await read(page, owner.jar)).html)).toBe('Checking');

      const mine = await read(page, owner.jar);
      expect(mine.html).toContain('Confirm this is done');
      expect(mine.html).toContain('the only check on this work');
      await move(owner, id, 'completed');

      const api = await visit(`/api/v1/organizations/${org}/work-units/${id}`, owner.jar);
      expect(api.status).toBe(200);
      expect(await api.json()).toMatchObject({
        status: 'completed',
        completion: {
          basis: 'owner_confirmed',
          confirmed_by_membership_id: await membershipOf(owner),
        },
      });
    });

    it('reports evidence, not a person’s word, when criteria were met', async () => {
      const id = await createWork(owner, {
        title: `Evidence ${randomUUID()}`,
        criteria: ['artifact_exists'],
      });
      await upload(owner, id, new File(['x'], 'result.txt', { type: 'text/plain' }));
      for (const to of ['ready', 'running', 'verifying', 'completed']) await move(owner, id, to);
      const api = await visit(`/api/v1/organizations/${org}/work-units/${id}`, owner.jar);
      expect(await api.json()).toMatchObject({ completion: { basis: 'evidence' } });
      expect((await read(workPage(id), owner.jar)).html).not.toContain('No evidence was requested');
    });

    it('needs a reason to try failed work again, even from a forged form', async () => {
      const id = await createWork(owner, { title: `Retry ${randomUUID()}` });
      const page = workPage(id);
      await move(owner, id, 'ready');
      await move(owner, id, 'running');
      await move(owner, id, 'failed');
      const refused = await submit(page, owner.jar, toStatus('ready'));
      expect(locationOf(refused)).toBe(`${page}?error=REASON_REQUIRED`);
      expect(statusOn((await read(page, owner.jar)).html)).toBe('Failed');
      const retried = await submit(page, owner.jar, toStatus('ready'), {
        reason: 'The supplier answered',
      });
      expect(locationOf(retried)).toBe(page);
      expect((await read(page, owner.jar)).html).toContain('The supplier answered');
    });

    it('explains a stopped prerequisite someone cannot see, without naming it', async () => {
      const secret = `Hidden prerequisite ${randomUUID()}`;
      const hidden = await createWork(owner, { title: secret, classification: 'restricted' });
      const id = await createWork(member, { title: `Waiting ${randomUUID()}` });
      const page = workPage(id);
      const added = await submit(page, owner.jar, /Add dependency/, { prerequisiteId: hidden });
      expect(locationOf(added)).toBe(page);

      // Still able to finish: it holds the work up, and nothing can remove it.
      const waiting = await read(page, member.jar);
      expect(mainOf(waiting.html).replaceAll('<!-- -->', '')).toContain(
        'This is also waiting on one piece of work you do not have access to.',
      );
      expect(waiting.html).not.toContain('Stop waiting on stopped work');
      expect(waiting.html).not.toContain('>Mark ready<');
      expect(waiting.html).toContain('This cannot be marked ready');

      await submit(workPage(hidden), owner.jar, toStatus('cancelled'), {
        confirm: 'yes',
        reason: 'No longer needed',
      });
      const stopped = await read(page, member.jar);
      expect(stopped.html).toContain('One of these was stopped, so it can never finish.');
      expect(stopped.html).toContain('Stop waiting on stopped work');
      expect(stopped.html).not.toContain(secret);
      expect(stopped.html).not.toContain(hidden);

      const removed = await submit(page, member.jar, /Stop waiting on stopped work/);
      expect(locationOf(removed)).toBe(page);
      expect(mainOf((await read(page, member.jar)).html)).not.toContain('This is also waiting on');
      await move(member, id, 'ready');
    });

    it('explains a stale change, and the later change stands', async () => {
      const title = `Stale ${randomUUID()}`;
      const id = await createWork(owner, { title });
      const page = workPage(id);
      // Two tabs: both read the same version, and the second saves first.
      const staleMove = await formOn(page, owner.jar, toStatus('ready'));
      const staleEdit = await formOn(page, owner.jar, /Save changes/);
      const changed = `Changed ${randomUUID()}`;
      await post(page, owner.jar, staleEdit, { title: changed, objective: '', dueAt: '' });

      const refused = await post(page, owner.jar, staleMove);
      expect(locationOf(refused)).toBe(`${page}?error=VERSION_CONFLICT`);
      const { html } = await read(locationOf(refused), owner.jar);
      expect(html).toContain('Someone else changed this first');
      expect(statusOn(html)).toBe('Waiting to start');

      // The stale edit is refused, explained, and hands back what was typed along with what is new.
      const overwrite = await post(page, owner.jar, staleEdit, {
        title: 'Overwritten',
        objective: 'A long objective someone spent a while on',
        dueAt: '',
      });
      expect(locationOf(overwrite)).toBe('');
      const refusal = await overwrite.text();
      expect(refusal).toContain('This changed while you were editing');
      expect(refusal).toContain(changed);
      expect(refusal).toContain('A long objective someone spent a while on');
      const latest = await read(page, owner.jar);
      expect(latest.html).toContain(changed);
      expect(latest.html).not.toContain('Overwritten');
      expect(await workRow(id)).toEqual({ status: 'queued', version: 2 });
    });

    it('refuses a status change the rules do not allow, and says why', async () => {
      const id = await createWork(owner, {
        title: `Rules ${randomUUID()}`,
        criteria: ['artifact_exists'],
      });
      const page = workPage(id);
      const form = await formOn(page, owner.jar, toStatus('ready'));
      const skipped = await post(page, owner.jar, form, { to: 'completed' });
      expect(locationOf(skipped)).toBe(`${page}?error=INVALID_TRANSITION`);
      expect((await read(locationOf(skipped), owner.jar)).html).toContain(
        'That status change is not allowed',
      );

      await move(owner, id, 'ready');
      await move(owner, id, 'running');
      await move(owner, id, 'verifying');
      // No file yet, so the page offers no way to finish, and a forged request is refused too.
      const finishing = await read(page, owner.jar);
      expect(finishing.html).not.toContain('>Mark done<');
      const back = await formOn(page, owner.jar, toStatus('running'));
      const early = await post(page, owner.jar, back, { to: 'completed' });
      expect(locationOf(early)).toBe(`${page}?error=EVIDENCE_MISSING`);
      expect(statusOn((await read(page, owner.jar)).html)).toBe('Checking');

      await upload(owner, id, new File(['evidence'], 'evidence.txt', { type: 'text/plain' }));
      await move(owner, id, 'completed');
      expect(statusOn((await read(page, owner.jar)).html)).toBe('Done');
    });

    it('keeps what was typed when a save is refused, and names the field at fault', async () => {
      const page = `/o/${org}/work/new`;
      const response = await submit(page, owner.jar, /name="title"/, {
        title: '   ',
        objective: 'Nearly lost this',
        classification: 'internal',
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('It cannot be only spaces');
      expect(html).toContain('Nearly lost this');
    });

    it.each(['__proto__', 'constructor', 'toString'])(
      'shows an ordinary notice for error=%s, instead of crashing',
      async (code) => {
        const { status, html } = await read(`/o/${org}/work?error=${code}`, owner.jar);
        expect(status).toBe(200);
        expect(html).toContain('Something went wrong. Please try again.');
      },
    );

    it('starts from the top for a page link that is no good, and says so', async () => {
      const { status, html } = await read(`/o/${org}/work?cursor=garbage`, owner.jar);
      expect(status).toBe(200);
      expect(html).toContain('Please check the details and try again.');
    });

    it('gives each page its own title, and marks where you are', async () => {
      const title = `Title ${randomUUID()}`;
      const id = await createWork(owner, { title });
      for (const [path, expected] of [
        [`/o/${org}`, 'Home | Ensemus'],
        [`/o/${org}/work`, 'Work | Ensemus'],
        [`/o/${org}/approvals`, 'Approvals | Ensemus'],
        [people(org), 'People and teams | Ensemus'],
        [`/o/${org}/clients`, 'Clients and projects | Ensemus'],
        [`/o/${org}/inbox`, 'Inbox | Ensemus'],
        [workPage(id), `${title} | Ensemus`],
      ] as const) {
        expect((await read(path, owner.jar)).html, path).toContain(`<title>${expected}</title>`);
      }
      const { html } = await read(`/o/${org}/work`, owner.jar);
      expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Work/);
    });

    it('does not offer switching organization to someone with only one', async () => {
      const one = await signUp('Only One');
      const mine = await createOrganization(one, `Solo ${randomUUID()}`);
      expect((await read(`/o/${mine}`, one.jar)).html).not.toContain('Switch organization');
      const two = await signUp('Two Places');
      const form = await formOn('/', two.jar, /Create organization/);
      const first = await post('/', two.jar, form, { name: `A ${randomUUID()}` });
      await post('/', two.jar, form, { name: `B ${randomUUID()}`, requestKey: randomUUID() });
      expect((await read(locationOf(first), two.jar)).html).toContain('Switch organization');
    });

    it('stops work only when it is meant, with a reason that stays on the record', async () => {
      const id = await createWork(owner, { title: `Stop ${randomUUID()}` });
      const page = workPage(id);
      const stopping = toStatus('cancelled');
      expect(locationOf(await submit(page, owner.jar, stopping, { reason: 'Why' }))).toBe(
        `${page}?error=INVALID_INPUT`,
      );
      expect(locationOf(await submit(page, owner.jar, stopping, { confirm: 'yes' }))).toBe(
        `${page}?error=REASON_REQUIRED`,
      );
      expect(statusOn((await read(page, owner.jar)).html)).toBe('Waiting to start');

      const reason = `The client withdrew ${randomUUID()}`;
      await submit(page, owner.jar, stopping, { confirm: 'yes', reason });
      const { html } = await read(page, owner.jar);
      expect(statusOn(html)).toBe('Stopped');
      expect(html).toContain(reason);
      // Nothing about stopped work offers to change it, and a forged request is refused.
      expect(html).not.toContain('Save changes');
      expect(html).not.toContain('name="file"');
      // What it does say can still happen is what the page still offers.
      expect(html).toContain('it can be handed to a new owner');
      expect(html).toContain('Change owner');
    });

    it('does not call work due today overdue', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const id = await createWork(owner, { title: `Today ${randomUUID()}`, dueAt: today });
      expect((await read(workPage(id), owner.jar)).html).not.toContain('Overdue');
    });

    it('shows work to someone assigned to it on their Home', async () => {
      const title = `Assigned ${randomUUID()}`;
      const id = await createWork(owner, { title });
      expect((await read(`/o/${org}`, member.jar)).html).not.toContain(title);
      await submit(workPage(id), owner.jar, /Add someone/, {
        membershipId: await membershipOf(member),
      });
      expect((await read(`/o/${org}`, member.jar)).html).toContain(title);
      expect((await read(`/o/${org}/inbox`, member.jar)).html).toContain(
        'You were put on some work',
      );
    });

    it('never echoes text from the address bar as an error', async () => {
      const { html } = await read(
        `/o/${org}/work?error=${encodeURIComponent('<b>pwned</b>')}`,
        owner.jar,
      );
      expect(html).not.toContain('<b>pwned');
      expect(html).toContain('Something went wrong. Please try again.');
    });
  });

  describe('files (WORK-04, LIFE-01)', () => {
    it('gives back the exact bytes as a download, and 404 once deleted', async () => {
      const id = await createWork(owner, { title: `Files ${randomUUID()}` });
      const bytes = Buffer.from([0, 255, 1, 254, 0x0d, 0x0a, 0x25, 0x50, 0x44, 0x46, 7, 8, 9]);
      const link = await upload(
        owner,
        id,
        new File([bytes], 'report.bin', { type: 'application/octet-stream' }),
      );

      const download = await visit(link, owner.jar);
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);
      expect(download.headers.get('x-content-type-options')).toBe('nosniff');
      expect(download.headers.get('content-disposition')).toMatch(/^attachment\b/);
      expect(download.headers.get('content-disposition')).toContain('report.bin');
      expect(download.headers.get('cache-control')).toMatch(/no-store|private/);

      const anonymous = await visit(link);
      expect(anonymous.status).not.toBe(200);
      expect(Buffer.from(await anonymous.arrayBuffer()).includes(bytes)).toBe(false);

      const page = workPage(id);
      const deleting = (form: Form) => form.hidden.get('artifactId') === artifactIn(link);
      // Deleting has to be meant, so nothing goes on one stray click.
      const stray = await submit(page, owner.jar, deleting);
      expect(locationOf(stray)).toBe(`${page}?error=INVALID_INPUT`);
      expect((await visit(link, owner.jar)).status).toBe(200);

      const removed = await submit(page, owner.jar, deleting, { confirm: 'yes' });
      expect(locationOf(removed)).toBe(page);
      expect((await visit(link, owner.jar)).status).toBe(404);
      expect((await read(page, owner.jar)).html).not.toContain('report.bin');
    });

    it.each([
      ['page.html', 'text/html'],
      ['image.svg', 'image/svg+xml'],
      ['page.xhtml', 'application/xhtml+xml'],
    ])('never serves an uploaded %s as something a browser would render', async (name, type) => {
      const id = await createWork(owner, { title: `Active ${randomUUID()}` });
      const body = '<script>document.title = "ran"</script>';
      const link = await upload(owner, id, new File([body], name, { type }));
      const download = await visit(link, owner.jar);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type') ?? '').not.toMatch(/html|svg|xml/);
      expect(download.headers.get('content-disposition')).toMatch(/^attachment\b/);
      expect(download.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await download.text()).toBe(body);
    });

    it('cannot be used to inject a header through a file name', async () => {
      const id = await createWork(owner, { title: `Names ${randomUUID()}` });
      const page = workPage(id);
      await submit(page, owner.jar, /name="file"/, {
        file: new File(['x'], 'a"; injected="1.txt', { type: 'text/plain' }),
      });
      const { html } = await read(page, owner.jar);
      const link = /href="([^"]+\/files\/[0-9a-f-]{36})"/.exec(html)?.[1];
      if (!link) throw new Error('No file link');
      const download = await visit(link, owner.jar);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toMatch(/^attachment\b/);
      expect(download.headers.get('content-disposition')).not.toMatch(/;\s*injected=/);
    });
  });

  describe('running a plan (WORK-07)', () => {
    it('stops for a person to accept, and its own file is not the evidence', async () => {
      const id = await createWork(owner, {
        title: `Plan ${randomUUID()}`,
        criteria: ['artifact_exists'],
        executionPlan: 'checklist',
      });
      const page = workPage(id);
      await move(owner, id, 'ready');
      const before = await read(page, owner.jar);
      expect(before.html).toContain('It does not do the work, and it does not mark it done');
      const started = await submit(page, owner.jar, /Run the plan/);
      expect(locationOf(started)).toBe(page);

      await expect
        .poll(async () => statusOn((await read(page, owner.jar)).html), {
          timeout: PLAN_TIMEOUT,
          interval: 500,
        })
        .toBe('Checking');
      const { html } = await read(page, owner.jar);
      expect(html).toContain('completion-checklist.md');
      expect(html).toContain('Still needed');
      expect(html).not.toContain('>Mark done<');
      const link = /href="([^"]+\/files\/[0-9a-f-]{36})">completion-checklist\.md</.exec(html)?.[1];
      if (!link) throw new Error('No checklist link');
      const checklist = await visit(link, owner.jar).then((r) => r.text());
      expect(checklist).toContain('Completion checklist');
      expect(checklist).not.toContain('artifact_exists');

      await upload(owner, id, new File(['the result'], 'result.txt', { type: 'text/plain' }));
      await move(owner, id, 'completed');
      const done = await read(page, owner.jar);
      expect(statusOn(done.html)).toBe('Done');
      expect(done.html).toContain('In place');
      expect(done.html).toContain('Its results are under Files');
    });

    it('does not call its own checklist the results', async () => {
      const id = await createWork(owner, {
        title: `Plan only ${randomUUID()}`,
        executionPlan: 'checklist',
      });
      const page = workPage(id);
      await move(owner, id, 'ready');
      await submit(page, owner.jar, /Run the plan/);
      await expect
        .poll(async () => statusOn((await read(page, owner.jar)).html), {
          timeout: PLAN_TIMEOUT,
          interval: 500,
        })
        .toBe('Checking');
      await move(owner, id, 'completed');
      const { html } = await read(page, owner.jar);
      expect(html).toContain('completion-checklist.md');
      expect(statusOn(html)).toBe('Done');
      expect(html).toContain('This is done.');
      expect(html).not.toContain('Its results are under Files');
    });

    it('refuses a second request, which could replace the reviewer the first one named', async () => {
      const id = await createWork(owner, {
        title: `Twice ${randomUUID()}`,
        executionPlan: 'checklist',
        criteria: ['reviewer_approved'],
      });
      const page = workPage(id);
      await move(owner, id, 'ready');
      // Both read the page before either request, as two people could. The dispatcher is held back
      // so that the request is still standing when the second arrives.
      const form = await formOn(page, owner.jar, /Run the plan/);
      compose('stop', 'dispatcher');
      try {
        const first = await post(page, owner.jar, form, {
          reviewerMembershipId: await membershipOf(reviewer),
        });
        expect(locationOf(first)).toBe(page);
        const second = await post(page, owner.jar, form, {
          reviewerMembershipId: await membershipOf(member),
        });
        expect(locationOf(second)).toBe(`${page}?error=RUN_ALREADY_REQUESTED`);
        const { rows } = await su.query(
          'select plan_reviewer_membership_id as reviewer from work.work_units where id = $1',
          [id],
        );
        expect(rows[0].reviewer).toBe(await membershipOf(reviewer));
        expect((await read(page, owner.jar)).html).toContain('Ensemus asks again');
      } finally {
        compose('start', 'dispatcher');
      }
    });
  });

  describe('restricted work (UX-12, UX-14, security blueprint section 5)', () => {
    it('is invisible to a member on every page, and visible to the people on it', async () => {
      const secret = `Restricted ${randomUUID()}`;
      const visible = `Internal ${randomUUID()}`;
      const id = await createWork(owner, { title: secret, classification: 'restricted' });
      await createWork(owner, { title: visible });
      const file = await upload(
        owner,
        id,
        new File(['secret'], 'secret.txt', { type: 'text/plain' }),
      );
      const page = workPage(id);

      // Handing it over puts the reviewer on it, which is what lets them be asked to review it.
      const handed = await submit(page, owner.jar, /Change owner/, {
        membershipId: await membershipOf(reviewer),
      });
      expect(locationOf(handed)).toBe(page);
      await submit(page, owner.jar, /Request review/, {
        approverMembershipId: await membershipOf(reviewer),
      });
      const approvalId = /\/approvals\/([0-9a-f-]{36})"/.exec(
        (await read(page, owner.jar)).html,
      )?.[1];
      if (!approvalId) throw new Error('No approval link');
      const approval = `/o/${org}/approvals/${approvalId}`;

      // The people on it can see it, so what follows cannot pass just because pages are broken.
      expect((await read(page, reviewer.jar)).html).toContain(secret);
      expect((await read(approval, reviewer.jar)).html).toContain(secret);
      expect((await read(`/o/${org}/approvals`, reviewer.jar)).html).toContain(secret);
      expect((await read(`/o/${org}/work`, owner.jar)).html).toContain(secret);
      expect((await visit(file, owner.jar)).status).toBe(200);

      const list = await read(`/o/${org}/work`, member.jar);
      expect(list.status).toBe(200);
      expect(list.html).toContain(visible);
      for (const path of [
        `/o/${org}`,
        `/o/${org}/work`,
        `/o/${org}/approvals`,
        `/o/${org}/inbox`,
        `/o/${org}/people`,
      ]) {
        const { status, html } = await read(path, member.jar);
        expect(status, path).toBe(200);
        expect(html, path).not.toContain(secret);
        expect(html, path).not.toContain(id);
      }
      for (const path of [page, file, approval]) {
        const { status, html } = await read(path, member.jar);
        expect(status, path).toBe(404);
        expect(html, path).not.toContain(secret);
        expect(html, path).not.toContain('secret.txt');
      }
    });

    it('is out of reach for a member through a forged form as well', async () => {
      const secret = `Restricted ${randomUUID()}`;
      const id = await createWork(owner, { title: secret, classification: 'restricted' });
      const own = await createWork(member, { title: `Mine ${randomUUID()}` });
      const page = workPage(own);
      const form = await formOn(page, member.jar, toStatus('ready'));
      const forged = await post(page, member.jar, form, { id, version: '1' });
      expect(locationOf(forged)).toBe(`${workPage(id)}?error=NOT_FOUND`);
      expect(await workRow(id)).toEqual({ status: 'queued', version: 1 });
    });

    it('stays hidden from an organization owner who is not on it', async () => {
      const secret = `Restricted ${randomUUID()}`;
      const id = await createWork(member, { title: secret, classification: 'restricted' });
      expect((await read(`/o/${org}/work`, owner.jar)).html).not.toContain(secret);
      expect((await read(workPage(id), owner.jar)).status).toBe(404);
    });
  });

  describe('approvals (UX-14, WORK-05)', () => {
    async function askForReview(title: string, criteria: string[] = []) {
      const id = await createWork(owner, { title, criteria });
      const page = workPage(id);
      await submit(page, owner.jar, /Request review/, {
        approverMembershipId: await membershipOf(reviewer),
      });
      const approvalId = /\/approvals\/([0-9a-f-]{36})"/.exec(
        (await read(page, owner.jar)).html,
      )?.[1];
      if (!approvalId) throw new Error('No approval link');
      return { id, page, approval: `/o/${org}/approvals/${approvalId}` };
    }

    const deciding = (decision: string) => (form: Form) => form.hidden.get('decision') === decision;

    it('approves the exact action through the approvals page, and only once', async () => {
      const title = `Approve ${randomUUID()}`;
      const { id, page, approval } = await askForReview(title, ['reviewer_approved']);

      const list = await read(`/o/${org}/approvals`, reviewer.jar);
      expect(list.html).toContain(title);
      expect(list.html).toContain(`href="${approval}"`);
      const shown = await read(approval, reviewer.jar);
      expect(statusOn(shown.html)).toBe('Waiting');
      // In plain words: the work by name, and what is at stake. Internal names only on request.
      const visible = mainOf(shown.html).replace(/<details[\s\S]*?<\/details>/g, '');
      expect(visible).toMatch(/<dt>Destination<\/dt><dd>[\s\S]*?<a[^>]*>[^<]*Approve /);
      expect(visible).toContain('<dt>Risk</dt>');
      expect(visible).toContain('<dt>What this affects</dt>');
      expect(visible).not.toContain(`work_unit:${id}`);
      expect(visible).not.toContain('work.review');
      expect(mainOf(shown.html)).toMatch(/<details[\s\S]*Technical details[\s\S]*work_unit:/);

      const form = await formOn(approval, reviewer.jar, deciding('approve'));
      const tampered = await post(approval, reviewer.jar, form, { shownHash: 'a'.repeat(64) });
      expect(locationOf(tampered)).toBe(`${approval}?error=APPROVAL_HASH_MISMATCH`);
      expect((await read(locationOf(tampered), reviewer.jar)).html).toContain(
        'The action changed after you reviewed it',
      );
      expect(statusOn((await read(approval, reviewer.jar)).html)).toBe('Waiting');

      const decided = await post(approval, reviewer.jar, form);
      expect(locationOf(decided)).toBe(approval);
      expect(statusOn((await read(approval, reviewer.jar)).html)).toBe('Approved');
      expect((await read(`/o/${org}/approvals`, reviewer.jar)).html).not.toContain(title);

      const twice = await post(approval, reviewer.jar, form);
      expect(locationOf(twice)).toBe(`${approval}?error=APPROVAL_NOT_PENDING`);

      // The approval is the evidence this work asked for.
      await move(owner, id, 'ready');
      await move(owner, id, 'running');
      await move(owner, id, 'verifying');
      await move(owner, id, 'completed');
      expect(statusOn((await read(page, owner.jar)).html)).toBe('Done');
    });

    it('stops counting an approval once the work it covered is edited', async () => {
      const title = `Edited ${randomUUID()}`;
      const { id, page, approval } = await askForReview(title, ['reviewer_approved']);
      await submit(approval, reviewer.jar, deciding('approve'));
      await submit(page, owner.jar, /Save changes/, {
        title: `${title} changed`,
        objective: 'Something the reviewer never saw',
        dueAt: '',
      });
      await move(owner, id, 'ready');
      await move(owner, id, 'running');
      await move(owner, id, 'verifying');
      const { html } = await read(page, owner.jar);
      expect(html).toContain('Still needed');
      expect(html).toContain('Out of date');
      expect(html).not.toContain('>Mark done<');
      const back = await formOn(page, owner.jar, toStatus('running'));
      const forged = await post(page, owner.jar, back, { to: 'completed' });
      expect(locationOf(forged)).toBe(`${page}?error=EVIDENCE_MISSING`);
    });

    it('refuses releasing paused work without a decision, even through a forged form', async () => {
      const title = `Pause ${randomUUID()}`;
      const id = await createWork(owner, { title });
      const page = workPage(id);
      await move(owner, id, 'ready');
      await move(owner, id, 'running');
      await submit(page, owner.jar, /Request review/, {
        approverMembershipId: await membershipOf(reviewer),
      });
      const { html } = await read(page, owner.jar);
      expect(statusOn(html)).toBe('Waiting for approval');
      expect(html).not.toContain('Request review');
      const form = await formOn(page, owner.jar, toStatus('cancelled'));
      const forged = await post(page, owner.jar, form, { to: 'running' });
      expect(locationOf(forged)).toBe(`${page}?error=INVALID_TRANSITION`);
      expect(statusOn((await read(page, owner.jar)).html)).toBe('Waiting for approval');
    });

    it('lets only the named approver decide, and never the person who asked', async () => {
      const { approval } = await askForReview(`Who ${randomUUID()}`);
      const form = await formOn(approval, reviewer.jar, deciding('approve'));

      const asker = await read(approval, owner.jar);
      expect(asker.status).toBe(200);
      expect(asker.html).not.toContain('>Approve<');
      const byAsker = await post(approval, owner.jar, form);
      expect(locationOf(byAsker)).toBe(`${approval}?error=APPROVAL_WRONG_APPROVER`);

      const byMember = await post(approval, member.jar, form);
      expect(locationOf(byMember)).toBe(`${approval}?error=APPROVAL_WRONG_APPROVER`);
      expect(statusOn((await read(approval, reviewer.jar)).html)).toBe('Waiting');
    });

    describe('a review whose time ran out, before the periodic check gets to it', () => {
      async function overdueHold() {
        const id = await createWork(owner, { title: `Overdue ${randomUUID()}` });
        const page = workPage(id);
        await move(owner, id, 'ready');
        await move(owner, id, 'running');
        await submit(page, owner.jar, /Request review/, {
          approverMembershipId: await membershipOf(reviewer),
        });
        const approvalId = /\/approvals\/([0-9a-f-]{36})"/.exec(
          (await read(page, owner.jar)).html,
        )?.[1];
        if (!approvalId) throw new Error('No approval link');
        await su.query(
          `update work.approvals set expires_at = now() - interval '1 minute' where id = $1`,
          [approvalId],
        );
        return { id, page, approval: `/o/${org}/approvals/${approvalId}` };
      }

      it('says it will stop, how to prevent that, and lets someone else be asked', async () => {
        const { page, approval } = await overdueHold();
        const { html } = await read(page, owner.jar);
        expect(statusOn(html)).toBe('Waiting for approval');
        expect(html).toContain('so it stops at the next periodic check');
        expect(html).toContain('To keep it going, ask someone else below before then.');
        expect(html).not.toContain('It stays paused until someone decides');
        expect((await read(approval, owner.jar)).html).toContain(
          'unless someone asks for a new review first',
        );

        const asked = await submit(page, owner.jar, /Request review/, {
          approverMembershipId: await membershipOf(member),
        });
        expect(locationOf(asked)).toBe(page);
        const after = await read(page, owner.jar);
        expect(statusOn(after.html)).toBe('Waiting for approval');
        expect(after.html).not.toContain('next periodic check');
        expect(statusOn((await read(approval, owner.jar)).html)).toBe('Expired');
      });

      it('does not promise anything to someone who cannot ask', async () => {
        const { page } = await overdueHold();
        const { html } = await read(page, reviewer.jar);
        expect(html).toContain('so it stops at the next periodic check');
        expect(html).not.toContain('ask someone else below');
      });
    });

    describe('denying a review the work is paused on', () => {
      async function paused() {
        const id = await createWork(owner, { title: `Held ${randomUUID()}` });
        const page = workPage(id);
        await move(owner, id, 'ready');
        await move(owner, id, 'running');
        await submit(page, owner.jar, /Request review/, {
          approverMembershipId: await membershipOf(reviewer),
        });
        const approvalId = /\/approvals\/([0-9a-f-]{36})"/.exec(
          (await read(page, owner.jar)).html,
        )?.[1];
        if (!approvalId) throw new Error('No approval link');
        return { page, approval: `/o/${org}/approvals/${approvalId}` };
      }

      it('has to be meant, because it stops the work for good', async () => {
        const { page, approval } = await paused();
        const shown = await read(approval, reviewer.jar);
        expect(shown.html).toContain('Deny this and stop the work for good');
        expect(shown.html).toContain('name="confirm"');

        const stray = await submit(approval, reviewer.jar, deciding('deny'), { reason: 'Why not' });
        expect(locationOf(stray)).toBe(`${approval}?error=INVALID_INPUT`);
        expect(statusOn((await read(page, owner.jar)).html)).toBe('Waiting for approval');

        const silent = await submit(approval, reviewer.jar, deciding('deny'), { confirm: 'yes' });
        expect(locationOf(silent)).toBe(`${approval}?error=REASON_REQUIRED`);
        expect(statusOn((await read(page, owner.jar)).html)).toBe('Waiting for approval');

        const meant = await submit(approval, reviewer.jar, deciding('deny'), {
          confirm: 'yes',
          reason: 'This is not what the client asked for',
        });
        expect(locationOf(meant)).toBe(approval);
        const stopped = await read(page, owner.jar);
        expect(statusOn(stopped.html)).toBe('Stopped');
        expect(stopped.html).toContain('This is not what the client asked for');
      });

      it('can still be approved with one press', async () => {
        const { page, approval } = await paused();
        await submit(approval, reviewer.jar, deciding('approve'));
        expect(statusOn((await read(page, owner.jar)).html)).toBe('In progress');
      });

      it('is refused the same way for someone who was not asked', async () => {
        const { page, approval } = await paused();
        const form = await formOn(approval, reviewer.jar, deciding('deny'));
        const forged = await post(approval, member.jar, form, {
          confirm: 'yes',
          reason: 'I say no',
        });
        expect(locationOf(forged)).toBe(`${approval}?error=APPROVAL_WRONG_APPROVER`);
        expect(statusOn((await read(page, owner.jar)).html)).toBe('Waiting for approval');
      });
    });

    it('records a denial', async () => {
      const { approval } = await askForReview(`Deny ${randomUUID()}`);
      const response = await submit(approval, reviewer.jar, deciding('deny'), {
        reason: 'Not good enough',
      });
      expect(locationOf(response)).toBe(approval);
      const { html } = await read(approval, reviewer.jar);
      expect(statusOn(html)).toBe('Denied');
      // The reason is written down, where the person who has to act on it can read it.
      expect(html).toContain('Not good enough');
      expect((await read(approval, owner.jar)).html).toContain('Not good enough');
      expect((await read(`/o/${org}/inbox`, owner.jar)).html).toContain(
        'A review of your work was decided',
      );
    });
  });

  describe('forged tenant in a hidden field (NEXT-01)', () => {
    let rivalWork: string;
    let ownWork: string;

    beforeAll(async () => {
      rivalWork = await createWork(rival, { title: `Rival ${randomUUID()}` }, rivalOrg);
      ownWork = await createWork(owner, { title: `Own ${randomUUID()}` });
    });

    const count = async (table: string, column: string, value: string) => {
      const { rows } = await su.query(
        `select count(*)::int as n from ${table} where ${column} = $1`,
        [value],
      );
      return rows[0].n as number;
    };

    it('refuses creating work in another tenant', async () => {
      const page = `/o/${org}/work/new`;
      const title = `Forged ${randomUUID()}`;
      const form = await formOn(page, owner.jar, /name="title"/);
      const response = await post(page, owner.jar, form, {
        organizationId: rivalOrg,
        title,
        classification: 'internal',
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(rivalName);
      expect(await count('work.work_units', 'title', title)).toBe(0);
    });

    it('refuses inviting someone into another tenant', async () => {
      const page = people(org);
      const email = `forged-${randomUUID()}@example.invalid`;
      const form = await formOn(page, owner.jar, /name="email"/);
      const response = await post(page, owner.jar, form, {
        organizationId: rivalOrg,
        email,
        role: 'admin',
      });
      expect(response.status).toBe(404);
      expect(await count('org.invitations', 'email', email)).toBe(0);
    });

    it('refuses changing work in another tenant, either way of naming it', async () => {
      const page = workPage(ownWork);
      const form = await formOn(page, owner.jar, toStatus('ready'));
      const named = await post(page, owner.jar, form, {
        organizationId: rivalOrg,
        id: rivalWork,
        version: '1',
      });
      expect(named.status).toBe(404);
      // Their work under this tenant's ID: row-level security finds nothing to change.
      const crossed = await post(page, owner.jar, form, { id: rivalWork, version: '1' });
      expect(locationOf(crossed)).toBe(`/o/${org}/work/${rivalWork}?error=NOT_FOUND`);
      expect(await workRow(rivalWork)).toEqual({ status: 'queued', version: 1 });
      expect(await workRow(ownWork)).toEqual({ status: 'queued', version: 1 });
    });

    it('refuses uploading a file to another tenant', async () => {
      const page = workPage(ownWork);
      const form = await formOn(page, owner.jar, /name="file"/);
      const name = `forged-${randomUUID()}.txt`;
      const response = await post(page, owner.jar, form, {
        organizationId: rivalOrg,
        id: rivalWork,
        file: new File(['x'], name, { type: 'text/plain' }),
      });
      expect(response.status).toBe(404);
      expect(await count('work.artifacts', 'name', name)).toBe(0);
    });

    it('refuses disabling a member of another tenant', async () => {
      const victim = await membershipOf(rival, rivalOrg);
      const page = people(org);
      const target = await membershipOf(member);
      const form = await formOn(
        page,
        owner.jar,
        (f) => f.hidden.get('membershipId') === target && />Disable</.test(f.html),
      );
      const response = await post(page, owner.jar, form, {
        organizationId: rivalOrg,
        membershipId: victim,
      });
      expect(response.status).toBe(404);
      const { rows } = await su.query('select status from org.memberships where id = $1', [victim]);
      expect(rows[0].status).toBe('active');
    });

    it('refuses the same thing posted to the other tenant’s own page', async () => {
      const title = `Forged ${randomUUID()}`;
      const form = await formOn(`/o/${org}/work/new`, owner.jar, /name="title"/);
      const response = await post(`/o/${rivalOrg}/work/new`, owner.jar, form, {
        organizationId: rivalOrg,
        title,
        classification: 'internal',
      });
      expect(response.status).toBe(404);
      expect(await count('work.work_units', 'title', title)).toBe(0);
    });

    it('refuses a form posted from another site', async () => {
      const page = `/o/${org}/work/new`;
      const title = `Cross-site ${randomUUID()}`;
      const form = await formOn(page, owner.jar, /name="title"/);
      const response = await post(
        page,
        owner.jar,
        form,
        { title, classification: 'internal' },
        'https://evil.example',
      );
      expect(response.status).not.toBe(303);
      expect(await count('work.work_units', 'title', title)).toBe(0);
    });
  });

  describe('what the logs may hold (ADR-013, FOUND-04)', () => {
    it('keeps SQL, parameters and caller text out, even when a request fails badly', async () => {
      const canary = `CANARY${randomUUID().replaceAll('-', '')}`;
      // Text where an ID belongs, in the action that used to fail outside its error handling.
      const form = await formOn(`/o/${org}/inbox`, reviewer.jar, /name="target"/);
      const refused = await post(`/o/${org}/inbox`, reviewer.jar, form, {
        id: `x\n{"forged":"${canary}"}`,
      });
      expect(locationOf(refused)).toBe(`/o/${org}/inbox?error=INVALID_INPUT`);
      await expect
        .poll(() => compose('logs', '--no-log-prefix', 'web').includes(canary), { timeout: 1_000 })
        .toBe(false);

      const logs = compose('logs', '--no-log-prefix', 'web');
      expect(logs).not.toContain(canary);
      expect(logs).not.toContain('Failed query');
      expect(logs).not.toMatch(/params:/);
    });
  });

  describe('teams and projects (UX-15, UX-16)', () => {
    it('lets a team gain and lose people', async () => {
      const team = `Sales ${randomUUID()}`;
      await submit(people(org), owner.jar, /name="name"/, { name: team });
      expect((await read(people(org), owner.jar)).html).toContain(team);
      const added = await submit(people(org), owner.jar, (f) => f.html.includes(`Add to ${team}`), {
        membershipId: await membershipOf(member),
      });
      expect(locationOf(added)).toBe(people(org));
      const removing = (f: Form) => f.html.includes(`Remove ${member.name} from ${team}`);
      expect((await formOn(people(org), owner.jar, removing)).hidden.size).toBeGreaterThan(0);
      await submit(people(org), owner.jar, removing);
      const { html } = await read(people(org), owner.jar);
      expect(html).not.toContain(`Remove ${member.name} from ${team}`);
    });

    it('leads from a project to its work, and says the list is filtered', async () => {
      const name = `Project ${randomUUID()}`;
      const clients = `/o/${org}/clients`;
      await submit(clients, owner.jar, /Project name/, { name });
      const link = new RegExp(`href="(/o/[^"]+/work\\?project=[0-9a-f-]{36})">${name}<`).exec(
        (await read(clients, owner.jar)).html,
      )?.[1];
      if (!link) throw new Error('No link to the project');
      const projectId = new URL(link, BASE_URL).searchParams.get('project');
      const inside = `Inside ${randomUUID()}`;
      const outside = `Outside ${randomUUID()}`;
      await createWork(owner, { title: inside, projectId: projectId as string });
      await createWork(owner, { title: outside });
      const { html } = await read(link, owner.jar);
      expect(html).toContain(inside);
      expect(html).not.toContain(outside);
      expect(mainOf(html).replaceAll('<!-- -->', '')).toContain(`Showing work in ${name}`);
    });
  });

  describe('disabling a member (SEC-12, NEXT-03 on a single replica)', () => {
    it('ends their access on the very next request, while their session is still warm', async () => {
      const leaver = await join(owner, org, 'Leah Leaving');
      const id = await createWork(leaver, { title: `Theirs ${randomUUID()}` });
      const page = workPage(id);
      // Everything warm: pages seen, and a form already in hand.
      expect((await read(`/o/${org}`, leaver.jar)).status).toBe(200);
      expect((await read(`/o/${org}/work`, leaver.jar)).status).toBe(200);
      expect((await read(page, leaver.jar)).status).toBe(200);
      const form = await formOn(page, leaver.jar, toStatus('ready'));
      const home = await visit('/', leaver.jar);
      expect(home.headers.get('location')).toBe(`/o/${org}`);

      const target = await membershipOf(leaver);
      // Disabling has to be meant, so a form sent without the box ticked changes nothing.
      const stray = await submit(
        people(org),
        owner.jar,
        (f) => f.hidden.get('membershipId') === target && />Disable</.test(f.html),
      );
      expect(locationOf(stray)).toBe(`${people(org)}?error=INVALID_INPUT`);
      expect((await read(`/o/${org}`, leaver.jar)).status).toBe(200);

      const disabled = await submit(
        people(org),
        owner.jar,
        (f) => f.hidden.get('membershipId') === target && />Disable</.test(f.html),
        { confirm: 'yes' },
      );
      expect(locationOf(disabled)).toBe(people(org));

      for (const path of [`/o/${org}`, `/o/${org}/work`, page, `/o/${org}/approvals`]) {
        const { status, html } = await read(path, leaver.jar);
        expect(status, path).toBe(404);
        expect(html, path).not.toContain(tenantName);
      }
      const late = await post(page, leaver.jar, form);
      expect(late.status).toBe(404);
      expect(await workRow(id)).toEqual({ status: 'queued', version: 1 });

      // The session itself is fine, but the organization is no longer offered as a way in.
      const after = await read('/', leaver.jar);
      expect(after.status).toBe(200);
      expect(after.html).not.toContain(tenantName);
      expect(after.html).toContain('Create organization');

      // The record stays, shown as disabled, and the work stays with the organization.
      expect((await read(people(org), owner.jar)).html).toContain('Disabled');
      expect((await read(page, owner.jar)).status).toBe(200);
    });
  });
});
