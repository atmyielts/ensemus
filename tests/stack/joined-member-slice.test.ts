// Slice 1 from where the plan starts it: someone who was invited joins the organization, and runs the
// slice end to end themselves through the real forms, ending with the evidence and the approval shown.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  type Form,
  type Person,
  post,
  read,
  formOn,
  signUp,
  submit,
  tokenIn,
  visit,
} from '../helpers/forms';
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
import { urls } from '../helpers/stack';

const RUN = { timeout: 60_000, interval: 500 };

describe('Slice 1 by someone who joined', () => {
  let su: pg.Client;
  let owner: Person;
  let joined: Person;
  let reviewer: Person;
  let org: string;
  const organization = `Joined ${randomUUID()}`;
  const people = () => `/o/${org}/people`;

  /** Invited on the people page, asks to join from the link, and an owner confirms it. */
  async function accept(person: Person) {
    const response = await submit(people(), owner.jar, /name="email"/, {
      email: person.email,
      role: 'member',
    });
    const token = tokenIn(await response.text());
    if (!token) throw new Error('No invitation link');
    const invitation = `/invite/${token}`;
    expect((await read(invitation, person.jar)).html).toContain('Accept invitation');
    const asked = await submit(invitation, person.jar, /Accept invitation/);
    expect(locationOf(asked)).toBe(`${invitation}?state=waiting`);
    // Not in yet: they asked, and nobody has confirmed it.
    expect((await read(`/o/${org}`, person.jar)).status).toBe(404);
    const confirmed = await submit(
      people(),
      owner.jar,
      (form: Form) =>
        form.html.includes(`Confirm ${person.email}`) && form.hidden.has('invitationId'),
      { confirm: 'yes' },
    );
    expect(locationOf(confirmed)).toBe(people());
  }

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    owner = await signUp('Olive Owner');
    org = await createOrganization(owner, organization);
    joined = await signUp('Jo Joined');
    reviewer = await signUp('Remy Reviewer');
  });

  afterAll(() => su?.end());

  it('joins, runs the plan, gets it reviewed, and finishes it with the evidence on show', async () => {
    // Join org.
    await accept(joined);
    await accept(reviewer);
    const { rows: roles } = await su.query(
      `select role, status from org.memberships where id = $1`,
      [await membershipOf(su, joined, org)],
    );
    expect(roles).toEqual([{ role: 'member', status: 'active' }]);

    // Read: an ordinary member, landing in the organization they joined.
    expect((await visit('/', joined.jar)).headers.get('location')).toBe(`/o/${org}`);
    const home = await read(`/o/${org}`, joined.jar);
    expect(home.status).toBe(200);
    expect(home.html).toContain(organization);

    // Create a Work Unit with a plan, and what has to be true before it is done.
    const title = `Quarterly close ${randomUUID()}`;
    const id = await createWork(joined, org, {
      title,
      objective: 'Close the quarter, with the numbers attached.',
      executionPlan: 'checklist',
      criteria: ['artifact_exists', 'reviewer_approved'],
    });
    const page = workPage(org, id);
    expect((await read(`/o/${org}/work`, joined.jar)).html).toContain(title);
    await move(joined, org, id, 'ready');

    // Outbox, dispatcher, workflow: pressing Run only records the request.
    const started = await submit(page, joined.jar, /Run the plan/, {
      reviewerMembershipId: await membershipOf(su, reviewer, org),
    });
    expect(locationOf(started)).toBe(page);
    await expect
      .poll(async () => statusOn((await read(page, joined.jar)).html), RUN)
      .toBe('Waiting for approval');

    // One step, one artifact, stored for real.
    const paused = (await read(page, joined.jar)).html;
    const link = /href="([^"]+\/files\/[0-9a-f-]{36})">completion-checklist\.md</.exec(paused)?.[1];
    if (!link) throw new Error('No checklist link');
    const checklist = await visit(link, joined.jar);
    expect(checklist.status).toBe(200);
    expect(await checklist.text()).toContain('Completion checklist');

    // The approval comes to the person named, and neither the one who asked nor anyone else decides.
    const approvals = await read(`/o/${org}/approvals`, reviewer.jar);
    expect(approvals.html).toContain(title);
    const approvalId = /\/approvals\/([0-9a-f-]{36})"/.exec(paused)?.[1];
    if (!approvalId) throw new Error('No approval link');
    const approval = `/o/${org}/approvals/${approvalId}`;
    const decide = (form: Form) => form.hidden.get('decision') === 'approve';
    const form = await formOn(approval, reviewer.jar, decide);
    const byRequester = await post(approval, joined.jar, form);
    expect(locationOf(byRequester)).toBe(`${approval}?error=APPROVAL_WRONG_APPROVER`);
    const decided = await post(approval, reviewer.jar, form);
    expect(decided.status).toBe(303);

    // The plan stops at checking, and its own checklist does not count as the result.
    await expect
      .poll(async () => statusOn((await read(page, joined.jar)).html), RUN)
      .toBe('Checking');
    const checking = sectionOf((await read(page, joined.jar)).html, 'verification-heading');
    expect(checking).toContain('Still needed');
    expect(checking).toContain('In place');
    expect(mainOf((await read(page, joined.jar)).html)).not.toContain('>Mark done<');

    // The person who joined attaches the result. The approval covered the work as it then stood, so
    // the page says it no longer counts, and they ask for it to be looked at again.
    const uploaded = await submit(page, joined.jar, /name="file"/, {
      file: new File(['the closing numbers'], 'closing-numbers.txt', { type: 'text/plain' }),
    });
    expect(locationOf(uploaded)).toBe(page);
    const changed = await read(page, joined.jar);
    expect(sectionOf(changed.html, 'verification-heading')).toContain('needs a new review');
    expect(mainOf(changed.html)).not.toContain('>Mark done<');
    const asked = await submit(page, joined.jar, /Request review/, {
      approverMembershipId: await membershipOf(su, reviewer, org),
    });
    expect(locationOf(asked)).toBe(page);
    const secondId = [
      ...(await read(page, joined.jar)).html.matchAll(/\/approvals\/([0-9a-f-]{36})"/g),
    ]
      .map((match) => match[1])
      .find((found) => found !== approvalId);
    if (!secondId) throw new Error('No second approval link');
    const second = `/o/${org}/approvals/${secondId}`;
    expect((await read(second, reviewer.jar)).html).toContain('closing-numbers.txt');
    expect((await submit(second, reviewer.jar, decide)).status).toBe(303);
    await move(joined, org, id, 'completed');

    // What anyone looking at it sees at the end: done, the evidence, and who approved it.
    for (const viewer of [joined, owner]) {
      const { html } = await read(page, viewer.jar);
      expect(statusOn(html)).toBe('Done');
      expect(sectionOf(html, 'files-heading')).toContain('closing-numbers.txt');
      expect(sectionOf(html, 'files-heading')).toContain('completion-checklist.md');
      const verification = sectionOf(html, 'verification-heading');
      expect(verification).toContain('This is done. Its results are under Files.');
      expect(verification).not.toContain('Still needed');
      expect(verification).toContain(`Review by ${reviewer.name}`);
      expect(verification).toContain('Approved');
      const decisionPage = await read(second, viewer.jar);
      expect(statusOn(decisionPage.html)).toBe('Approved');
      expect(decisionPage.html).toContain('closing-numbers.txt');
    }
    const { rows } = await su.query(
      `select a.status, a.approver_membership_id as approver, a.requested_by_membership_id as asker
       from work.approvals a where a.work_unit_id = $1 order by a.created_at`,
      [id],
    );
    const approver = await membershipOf(su, reviewer, org);
    const asker = await membershipOf(su, joined, org);
    expect(rows).toEqual([
      { status: 'approved', approver, asker },
      { status: 'approved', approver, asker },
    ]);
  }, 240_000);
});
