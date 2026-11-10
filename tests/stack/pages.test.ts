// UX-12, UX-13, UX-14, UX-17: what Home, Work Unit detail, the approval page and the inbox tell a
// person, read from the pages they get. Against built images, with JavaScript off.
import { randomUUID } from 'node:crypto';
import { connectClient } from '@ensemus/workflows/client';
import { reminderScheduleIdFor } from '@ensemus/workflows/schemas';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWork,
  locationOf,
  mainOf,
  membershipOf,
  move,
  sectionOf,
  statusOn,
  workPage,
} from '../helpers/flows';
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
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { secret, urls } from '../helpers/stack';

describe('what the pages say', () => {
  let su: pg.Client;
  let owner: Person;
  let member: Person;
  let reviewer: Person;
  let org: string;

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    owner = await signUp('Olive Owner');
    org = await createOrganization(owner, `Pages ${randomUUID()}`);
    member = await join(owner, org, 'Milo Member');
    reviewer = await join(owner, org, 'Remy Reviewer');
  });

  afterAll(() => su?.end());

  const page = (id: string) => workPage(org, id);
  const home = (person: Person) => read(`/o/${org}`, person.jar);

  async function askForReview(id: string) {
    const here = page(id);
    const asked = await submit(here, owner.jar, /Request review/, {
      approverMembershipId: await membershipOf(su, reviewer, org),
    });
    expect(locationOf(asked)).toBe(here);
    const approval = /\/approvals\/([0-9a-f-]{36})"/.exec((await read(here, owner.jar)).html)?.[1];
    if (!approval) throw new Error('No approval link');
    return { approvalId: approval, path: `/o/${org}/approvals/${approval}` };
  }

  describe('Home (UX-12)', () => {
    it('says what to do when there is nothing yet', async () => {
      const person = await signUp('Nia New');
      const own = await createOrganization(person, `Empty ${randomUUID()}`);
      const { status, html } = await read(`/o/${own}`, person.jar);
      expect(status).toBe(200);
      const main = mainOf(html);
      expect(main).toContain('Hello, Nia');
      expect(main).toContain(
        'You are not on any open work. Start by describing the outcome you want.',
      );
      expect(main).toContain(`href="/o/${own}/work/new"`);
      expect(main).not.toContain('Needs attention');
      expect(main).not.toContain('Waiting for your approval');
    });

    it('puts what is blocked, failed or late in the attention queue, and nothing else', async () => {
      const suffix = randomUUID();
      const person = await join(owner, org, 'Ali Attention');
      const make = (title: string, extra = {}) =>
        createWork(person, org, { title: `${title} ${suffix}`, ...extra });
      const blocked = await make('Blocked');
      await move(person, org, blocked, 'ready', 'running', 'blocked');
      const failed = await make('Failed');
      await move(person, org, failed, 'ready', 'running', 'failed');
      await make('Late', { dueAt: '2020-01-02' });
      await make('Later', { dueAt: '2099-01-02' });
      await make('Quiet');
      const done = await make('Finished', { dueAt: '2020-01-02' });
      await move(person, org, done, 'ready', 'running', 'verifying', 'completed');

      const { html } = await home(person);
      const attention = sectionOf(html, 'attention-heading');
      for (const title of ['Blocked', 'Failed', 'Late']) {
        expect(attention).toContain(`${title} ${suffix}`);
      }
      expect(attention).toContain('Was due 2 Jan 2020');
      expect(attention).toContain('You own this');
      for (const title of ['Later', 'Quiet', 'Finished']) {
        expect(attention).not.toContain(`${title} ${suffix}`);
      }
      const mine = sectionOf(html, 'mine-heading');
      for (const title of ['Later', 'Quiet']) {
        expect(mine).toContain(`${title} ${suffix}`);
      }
      // Already listed under Needs attention, straight above, or finished.
      for (const title of ['Blocked', 'Failed', 'Late', 'Finished']) {
        expect(mine).not.toContain(`${title} ${suffix}`);
      }
    });

    it('shows nobody else’s trouble, and no work they may not see', async () => {
      const title = `Private trouble ${randomUUID()}`;
      const id = await createWork(owner, org, { title, classification: 'restricted' });
      await move(owner, org, id, 'ready', 'running', 'blocked');
      const internal = `Someone else's trouble ${randomUUID()}`;
      const other = await createWork(owner, org, { title: internal });
      await move(owner, org, other, 'ready', 'running', 'blocked');

      expect((await home(owner)).html).toContain(title);
      const seen = await home(member);
      expect(seen.html).not.toContain(title);
      expect(sectionOf(seen.html, 'attention-heading')).not.toContain(internal.slice(-20));
    });

    it('lists an approval waiting on this person, and not on anyone else', async () => {
      const title = `Decide me ${randomUUID()}`;
      const id = await createWork(owner, org, { title });
      const { path } = await askForReview(id);
      const waiting = sectionOf((await home(reviewer)).html, 'approvals-heading');
      expect(waiting).toContain(title);
      expect(waiting).toContain(`href="${path}"`);
      expect(waiting).toContain('Expires ');
      expect(sectionOf((await home(member)).html, 'approvals-heading')).not.toContain(title);
      expect(sectionOf((await home(owner)).html, 'approvals-heading')).not.toContain(title);
    });
  });

  describe('a Work Unit (UX-13)', () => {
    it('names its accountable owner, and the new one after a handover', async () => {
      const id = await createWork(owner, org, { title: `Owned ${randomUUID()}` });
      const owned = (html: string) =>
        /<dt>Accountable owner<\/dt><dd>([^<]*)<\/dd>/.exec(sectionOf(html, 'owner-heading'))?.[1];
      expect(owned((await read(page(id), member.jar)).html)).toBe(owner.name);
      await submit(page(id), owner.jar, /Change owner/, {
        membershipId: await membershipOf(su, member, org),
      });
      expect(owned((await read(page(id), owner.jar)).html)).toBe(member.name);
    });

    it('adds and removes a dependency through its page, and holds the work meanwhile', async () => {
      const first = `First ${randomUUID()}`;
      const prerequisite = await createWork(owner, org, { title: first });
      const id = await createWork(owner, org, { title: `Second ${randomUUID()}` });
      const here = page(id);

      const added = await submit(here, owner.jar, /Add dependency/, {
        prerequisiteId: prerequisite,
      });
      expect(locationOf(added)).toBe(here);
      const waiting = await read(here, owner.jar);
      const dependencies = sectionOf(waiting.html, 'dependencies-heading');
      expect(dependencies).toContain(`href="${page(prerequisite)}"`);
      expect(dependencies).toContain(first);
      expect(dependencies).toContain('Waiting to start');
      const actions = sectionOf(waiting.html, 'actions-heading');
      expect(actions).toContain('This cannot be marked ready until what it depends on is done.');
      expect(actions).not.toContain('Mark ready');
      // The other side says what is waiting on it.
      expect(
        sectionOf((await read(page(prerequisite), owner.jar)).html, 'dependencies-heading'),
      ).toContain('Waiting on this');

      const removed = await submit(here, owner.jar, (form: Form) =>
        form.html.includes(`Stop waiting on ${first}`),
      );
      expect(locationOf(removed)).toBe(here);
      const clear = await read(here, owner.jar);
      const after = sectionOf(clear.html, 'dependencies-heading');
      expect(after).toContain('<p class="muted">Nothing.</p>');
      expect(after).not.toContain(`Stop waiting on ${first}`);
      expect(sectionOf(clear.html, 'actions-heading')).toContain('Mark ready');
    });

    it('explains a loop in plain words, from a forged form', async () => {
      const a = await createWork(owner, org, { title: `A ${randomUUID()}` });
      const b = await createWork(owner, org, { title: `B ${randomUUID()}` });
      await submit(page(a), owner.jar, /Add dependency/, { prerequisiteId: b });
      const form = await formOn(page(b), owner.jar, /Add dependency/);
      const refused = await post(page(b), owner.jar, form, { prerequisiteId: a });
      expect(locationOf(refused)).toBe(`${page(b)}?error=DEPENDENCY_CYCLE`);
      expect((await read(locationOf(refused), owner.jar)).html).toContain(
        'That dependency would create a loop.',
      );
    });

    it('offers no dependency controls to someone who may not change the work', async () => {
      const id = await createWork(owner, org, { title: `Look only ${randomUUID()}` });
      const { status, html } = await read(page(id), member.jar);
      expect(status).toBe(200);
      const main = sectionOf(html, 'dependencies-heading');
      // The section is there and only its controls are not, rather than the page being something else.
      expect(main).toContain('Has to finish first');
      expect(main).not.toContain('Add dependency');
    });
  });

  describe('an approval (UX-14)', () => {
    const summary = (html: string) => sectionOf(html, 'summary-heading');

    it('names the exact files it covers, each linked', async () => {
      const id = await createWork(owner, org, { title: `Files ${randomUUID()}` });
      for (const name of ['contract.pdf', 'annex.txt']) {
        const file = new File(['content'], name, { type: 'text/plain' });
        await submit(page(id), owner.jar, /name="file"/, { file });
      }
      const { path } = await askForReview(id);
      const { html } = await read(path, reviewer.jar);
      const covers = sectionOf(html, 'covers-heading');
      expect(covers).toContain('The title and objective of');
      expect(covers).toMatch(/href="[^"]+\/files\/[0-9a-f-]{36}">contract\.pdf</);
      expect(covers).toMatch(/href="[^"]+\/files\/[0-9a-f-]{36}">annex\.txt</);
      expect(covers).not.toContain('has since been deleted');
      expect(summary(html)).toContain('This work, and 2 files.');
    });

    it('says when a file it covered has been deleted, and how many', async () => {
      const id = await createWork(owner, org, { title: `Gone ${randomUUID()}` });
      for (const name of ['keeps.txt', 'goes.txt']) {
        const file = new File(['content'], name, { type: 'text/plain' });
        await submit(page(id), owner.jar, /name="file"/, { file });
      }
      const { path } = await askForReview(id);
      await submit(path, reviewer.jar, (form: Form) => form.hidden.get('decision') === 'approve');
      const deleted = await submit(
        page(id),
        owner.jar,
        (form: Form) => form.hidden.has('artifactId') && form.html.includes('goes.txt'),
        { confirm: 'yes' },
      );
      expect(locationOf(deleted)).toBe(page(id));

      const covers = sectionOf((await read(path, reviewer.jar)).html, 'covers-heading');
      expect(covers).toContain('keeps.txt');
      expect(covers).not.toContain('goes.txt');
      expect(covers).toContain('One file this covered has since been deleted.');
    });

    it('states the risk of work it is holding, and of work it is not', async () => {
      const paused = await createWork(owner, org, { title: `Held ${randomUUID()}` });
      await move(owner, org, paused, 'ready', 'running');
      const held = await askForReview(paused);
      const heldRisk = summary((await read(held.path, reviewer.jar)).html);
      expect(heldRisk).toContain(
        'This work is paused until you decide. Approving lets it carry on, and denying stops it for good.',
      );
      expect(heldRisk).toContain('Nothing outside Ensemus changes.');

      const quiet = await createWork(owner, org, { title: `Not held ${randomUUID()}` });
      const plain = await askForReview(quiet);
      const plainRisk = summary((await read(plain.path, reviewer.jar)).html);
      expect(plainRisk).toContain('it does not start or stop anything');
      expect(plainRisk).not.toContain('paused until you decide');
      expect(plainRisk).not.toContain('sensitive');
    });

    it('warns about sensitive work', async () => {
      const id = await createWork(owner, org, {
        title: `Sensitive ${randomUUID()}`,
        classification: 'confidential',
      });
      await submit(page(id), owner.jar, /Add someone/, {
        membershipId: await membershipOf(su, reviewer, org),
      });
      const { path } = await askForReview(id);
      expect(summary((await read(path, reviewer.jar)).html)).toContain(
        'This work is sensitive, so check that nothing here should stay with fewer people.',
      );
    });

    it('shows when it runs out, and that it has', async () => {
      const id = await createWork(owner, org, { title: `Clock ${randomUUID()}` });
      const { approvalId, path } = await askForReview(id);
      await su.query(
        `update work.approvals set expires_at = '2031-03-04T05:06:00Z' where id = $1`,
        [approvalId],
      );
      const open = await read(path, reviewer.jar);
      expect(summary(open.html)).toContain('<dt>Valid until</dt><dd>4 Mar 2031, 05:06 UTC</dd>');
      expect(statusOn(open.html)).toBe('Waiting');

      await su.query(
        `update work.approvals set expires_at = '2021-03-04T05:06:00Z' where id = $1`,
        [approvalId],
      );
      const late = await read(path, reviewer.jar);
      expect(summary(late.html)).toContain('<dt>Expired</dt><dd>4 Mar 2021, 05:06 UTC</dd>');
      expect(statusOn(late.html)).toBe('Expired');
      expect(mainOf(late.html)).toContain('this can no longer be approved');
      expect(formsWithDecision(late.html)).toBe(false);
    });
  });

  describe('reminders (UX-17)', () => {
    let temporal: Awaited<ReturnType<typeof connectClient>>;

    beforeAll(async () => {
      temporal = await connectClient({
        address: '127.0.0.1:57233',
        namespace: 'default',
        codecKey: secret('temporal_codec_key'),
      });
    });

    afterAll(() => temporal?.close());

    const POLL = { timeout: 60_000, interval: 500 };

    it('come from the real Temporal schedule, and bring the item back to the top', async () => {
      const handle = temporal.client.schedule.getHandle(reminderScheduleIdFor(org));
      // The dispatcher makes it from the event organization.created committed.
      await expect
        .poll(
          () =>
            handle.describe().then(
              () => true,
              () => false,
            ),
          POLL,
        )
        .toBe(true);
      const described = await handle.describe();
      expect(described.spec.intervals?.[0]?.every).toBe(15 * 60 * 1000);
      const before = described.info.numActionsTaken;

      const id = await createWork(owner, org, { title: `Unanswered ${randomUUID()}` });
      const { approvalId } = await askForReview(id);
      const recipient = await membershipOf(su, reviewer, org);
      // As if this had been waiting long enough, with a full page of newer things arriving since.
      await su.query(
        `update platform.notifications
         set remind_at = now() - interval '1 minute', created_at = now() - interval '2 days'
         where target_ref = $1`,
        [`approval:${approvalId}`],
      );
      await inFixtureTenant(su, org, () =>
        su.query(
          `insert into platform.notifications
             (organization_id, recipient_membership_id, kind, target_ref)
           select $1, $2, 'work.assigned', 'work_unit:' || gen_random_uuid()
           from generate_series(1, 55)`,
          [org, recipient],
        ),
      );
      const inbox = `/o/${org}/inbox`;
      // The inbox streams in after its loading state, so these read the whole response. The rows are
      // the only list items holding one of these forms.
      const rows = async () =>
        [...(await read(inbox, reviewer.jar)).html.matchAll(/<li>(?:(?!<\/li>)[\s\S])*?<\/li>/g)]
          .map(([row]) => row.replaceAll('<!-- -->', ''))
          .filter((row) => row.includes('name="target"'));
      const crowded = (await read(inbox, reviewer.jar)).html.replaceAll('<!-- -->', '');
      expect(crowded).toContain('this shows 50 of them');
      expect(await rows()).toHaveLength(50);
      expect((await rows()).join()).not.toContain('An approval needs your decision');

      await handle.trigger(ScheduleOverlapPolicy.ALLOW_ALL);

      const remindersSent = async () => {
        const { rows } = await su.query(
          'select reminders_sent from platform.notifications where target_ref = $1',
          [`approval:${approvalId}`],
        );
        return rows[0].reminders_sent as number;
      };
      await expect.poll(remindersSent, POLL).toBe(1);
      expect((await handle.describe()).info.numActionsTaken).toBeGreaterThan(before);

      const [top] = await rows();
      expect(top).toContain('An approval needs your decision');
      expect(top).toContain('>Reminder<');
      expect(top).toContain('>New<');
    });

    it('says nothing goes out by email yet', async () => {
      expect((await read(`/o/${org}/inbox`, reviewer.jar)).html).toContain(
        'nothing is sent by email yet',
      );
    });
  });
});

const formsWithDecision = (html: string) => html.includes('name="decision"');
