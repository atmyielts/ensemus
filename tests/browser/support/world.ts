// Seeds one believable organization through the product's own forms, so that every page and state a
// person can reach exists before a browser opens it. SQL only moves the clock, or marks a reminder.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  bringIn,
  createOrganization,
  formOn,
  join,
  post,
  read,
  signUp,
  submit,
  tokenIn,
  type Form,
  type FormMatch,
  type Person,
  type Values,
} from '../../helpers/forms';
import { urls } from '../../helpers/stack';

const day = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * day).toISOString().slice(0, 10);

/** Fails the seed at once when a form is refused, rather than leaving a page in the wrong state. */
function accepted(response: Response, what: string) {
  const location = response.headers.get('location') ?? '';
  if (response.status >= 400 || location.includes('error=')) {
    throw new Error(`Seed step refused: ${what} (${response.status} ${location})`);
  }
  return response;
}

export async function superuser() {
  const client = new pg.Client({ connectionString: urls.superuser() });
  await client.connect();
  return client;
}

export const toStatus = (to: string) => (form: Form) => form.hidden.get('to') === to;

export const workPath = (organization: string, id: string) => `/o/${organization}/work/${id}`;

export async function createWork(person: Person, organization: string, values: Values) {
  const response = await submit(`/o/${organization}/work/new`, person.jar, /name="title"/, {
    classification: 'internal',
    ...values,
  });
  const id = /\/work\/([0-9a-f-]{36})$/.exec(response.headers.get('location') ?? '')?.[1];
  if (!id) throw new Error(`Work not created: ${response.status}`);
  return id;
}

export async function move(person: Person, organization: string, id: string, ...to: string[]) {
  const page = workPath(organization, id);
  for (const status of to) {
    accepted(await submit(page, person.jar, toStatus(status)), `move to ${status}`);
  }
}

export type World = {
  organization: string;
  alice: Person;
  bob: Person;
  carol: Person;
  /** Has an account and no organization. */
  newcomer: Person;
  /** Owns an organization with nothing in it. */
  quiet: Person;
  quietOrganization: string;
  /** In two organizations, so sees the list of them. */
  both: Person;
  /** Holds an invitation and has not used it. */
  invited: Person;
  /** Used an invitation, and is waiting for someone to confirm them. */
  asking: Person;
  inviteToken: string;
  askingToken: string;
  membership: { alice: string; bob: string; carol: string };
  work: {
    queued: string;
    prerequisite: string;
    ready: string;
    plan: string;
    running: string;
    blocked: string;
    paused: string;
    verifying: string;
    done: string;
    doneWithFiles: string;
    failed: string;
    stopped: string;
    overdue: string;
    long: string;
    confidential: string;
  };
  approvals: {
    holding: string;
    plain: string;
    approved: string;
    denied: string;
    expired: string;
    closed: string;
    asked: string;
  };
  sql: pg.Client;
  latestApproval: (workUnit: string) => Promise<string>;
  membershipOf: (person: Person, organization: string) => Promise<string>;
  close: () => Promise<void>;
};

export async function buildWorld(): Promise<World> {
  const sql = await superuser();

  const alice = await signUp('Alice Morgan');
  const organization = await createOrganization(alice, 'Northwind Studio');
  const bob = await join(alice, organization, 'Bob Okafor');
  const carol = await join(alice, organization, 'Carol Reyes');

  const membershipOf = async (person: Person, org: string) => {
    const { rows } = await sql.query(
      `select m.id from org.memberships m join identity.users u on u.id = m.user_id
       where u.email = $1 and m.organization_id = $2`,
      [person.email, org],
    );
    if (!rows[0]) throw new Error('No membership');
    return rows[0].id as string;
  };
  const latestApproval = async (workUnit: string) => {
    const { rows } = await sql.query(
      'select id from work.approvals where work_unit_id = $1 order by created_at desc limit 1',
      [workUnit],
    );
    if (!rows[0]) throw new Error('No approval');
    return rows[0].id as string;
  };
  const membership = {
    alice: await membershipOf(alice, organization),
    bob: await membershipOf(bob, organization),
    carol: await membershipOf(carol, organization),
  };

  const page = (id: string) => workPath(organization, id);
  const askBob = async (id: string, person: Person = alice) =>
    accepted(
      await submit(page(id), person.jar, /name="approverMembershipId"/, {
        approverMembershipId: membership.bob,
      }),
      'ask Bob for a review',
    );
  const decide = async (approval: string, person: Person, decision: string, values: Values) =>
    accepted(
      await submit(
        `/o/${organization}/approvals/${approval}`,
        person.jar,
        (form) => form.hidden.get('decision') === decision,
        values,
      ),
      `${decision} a review`,
    );
  const attach = async (id: string, name: string, body: string) =>
    accepted(
      await submit(page(id), alice.jar, /name="file"/, {
        file: new File([body], name, { type: 'text/plain' }),
      }),
      `attach ${name}`,
    );

  // Clients, projects and teams.
  const clients = `/o/${organization}/clients`;
  for (const displayName of ['Harbour Foods', 'Meridian Health']) {
    accepted(await submit(clients, alice.jar, /name="displayName"/, { displayName }), 'client');
  }
  const { rows: clientRows } = await sql.query(
    `select id from work.clients where organization_id = $1 order by display_name`,
    [organization],
  );
  accepted(
    await submit(clients, alice.jar, /Add project/, {
      name: 'Website refresh',
      clientId: clientRows[0].id as string,
    }),
    'project',
  );
  accepted(
    await submit(clients, alice.jar, /Add project/, { name: 'Spring campaign', clientId: '' }),
    'project',
  );
  const { rows: projectRows } = await sql.query(
    `select id from work.projects where organization_id = $1 and name = 'Website refresh'`,
    [organization],
  );
  const project = projectRows[0].id as string;

  const people = `/o/${organization}/people`;
  accepted(await submit(people, alice.jar, /Create team/, { name: 'Design' }), 'team');
  const { rows: teamRows } = await sql.query(
    `select id from org.teams where organization_id = $1 and name = 'Design'`,
    [organization],
  );
  const design = teamRows[0].id as string;
  accepted(
    await submit(people, alice.jar, /Create team/, { name: 'Client services', parentId: design }),
    'nested team',
  );
  accepted(
    await submit(
      people,
      alice.jar,
      (form) => form.html.includes('Add to Design') && form.hidden.get('teamId') === design,
      { membershipId: membership.bob },
    ),
    'team member',
  );

  // Work in every status.
  const prerequisite = await createWork(alice, organization, {
    title: 'Agree the brand palette with the client',
    objective: 'We need a signed-off palette before anyone starts on the guide.',
    dueAt: inDays(9),
  });
  const queued = await createWork(alice, organization, {
    title: 'Write the onboarding guide for new clients',
    objective:
      'A short guide that tells a new client who does what in the first month, what we need from them, and how to reach us.\n\nKeep it to two pages.',
    dueAt: inDays(21),
    projectId: project,
    criteria: ['artifact_exists'],
  });
  accepted(
    await submit(page(queued), alice.jar, /Add dependency/, { prerequisiteId: prerequisite }),
    'dependency',
  );
  await move(alice, organization, prerequisite, 'ready');

  const ready = await createWork(alice, organization, {
    title: 'Book the photographer for the spring shoot',
    criteria: ['reviewer_approved'],
    dueAt: inDays(14),
  });
  await move(alice, organization, ready, 'ready');

  const plan = await createWork(alice, organization, {
    title: 'Prepare the quarterly report pack',
    objective: 'Collect the numbers, and get someone to read it before it goes out.',
    criteria: ['reviewer_approved'],
    executionPlan: 'checklist',
    dueAt: inDays(5),
  });
  await move(alice, organization, plan, 'ready');

  const running = await createWork(alice, organization, {
    title: 'Redesign the pricing page',
    objective: 'Make the three plans easy to compare on a phone.',
    criteria: ['artifact_exists', 'reviewer_approved'],
    projectId: project,
    dueAt: inDays(3),
  });
  await move(alice, organization, running, 'ready', 'running');
  await attach(running, 'pricing-page-draft-v2.txt', 'A draft of the page.');
  accepted(
    await submit(page(running), alice.jar, /Add someone/, { membershipId: membership.carol }),
    'add Carol',
  );

  const blocked = await createWork(alice, organization, {
    title: 'Migrate the client newsletter list',
    objective: 'Waiting for the export from the old provider.',
    dueAt: inDays(1),
  });
  await move(alice, organization, blocked, 'ready', 'running', 'blocked');

  const paused = await createWork(alice, organization, {
    title: 'Sign off the Meridian Health proposal',
    objective: 'Bob reads the final proposal before it goes to the client.',
    classification: 'confidential',
    dueAt: inDays(2),
  });
  await move(alice, organization, paused, 'ready', 'running');
  await attach(paused, 'meridian-proposal-final.txt', 'The proposal.');
  accepted(
    await submit(page(paused), alice.jar, /Add someone/, { membershipId: membership.bob }),
    'add Bob',
  );
  await askBob(paused);
  const holding = await latestApproval(paused);

  const verifying = await createWork(alice, organization, {
    title: 'Check the invoices for October',
    criteria: ['reviewer_approved'],
  });
  await move(alice, organization, verifying, 'ready', 'running');
  await askBob(verifying);
  const approved = await latestApproval(verifying);
  await decide(approved, bob, 'approve', {
    reason: 'The totals match the ledger. One rounding note, which is fine.',
  });
  await move(alice, organization, verifying, 'verifying');

  const done = await createWork(alice, organization, {
    title: 'Publish the autumn newsletter',
    objective: 'Sent to everyone on the list.',
  });
  await move(alice, organization, done, 'ready', 'running', 'verifying', 'completed');

  const doneWithFiles = await createWork(alice, organization, {
    title: 'Deliver the brand guidelines',
    criteria: ['artifact_exists'],
  });
  await move(alice, organization, doneWithFiles, 'ready', 'running');
  await attach(doneWithFiles, 'brand-guidelines.txt', 'The guidelines.');
  await attach(doneWithFiles, 'logo-usage-notes.txt', 'How to use the logo.');
  await move(alice, organization, doneWithFiles, 'verifying', 'completed');

  const failed = await createWork(alice, organization, {
    title: 'Import last year’s time sheets',
    objective: 'The export from the old system was incomplete.',
  });
  await move(alice, organization, failed, 'ready', 'running', 'failed');

  const stopped = await createWork(alice, organization, {
    title: 'Plan the summer offsite',
  });
  accepted(
    await submit(page(stopped), alice.jar, toStatus('cancelled'), {
      confirm: 'yes',
      reason: 'We decided to hold it in the office this year.',
    }),
    'stop work',
  );

  const overdue = await createWork(alice, organization, {
    title: 'Renew the design software licences',
    dueAt: inDays(-3),
  });

  const long = await createWork(alice, organization, {
    title: `A title long enough to wrap, with a reference nobody can break: ${'Q3-2026-INV-REF-'.repeat(8)}end`,
    objective: `An unbroken line, as someone might paste it: https://intranet.example.invalid/${'documents/'.repeat(30)}`,
  });

  const confidential = await createWork(alice, organization, {
    title: 'Review salaries for next year',
    classification: 'restricted',
  });

  // A review that holds nothing, and reviews that ended in every way a review can.
  await askBob(ready);
  const plain = await latestApproval(ready);

  const deniedWork = await createWork(alice, organization, {
    title: 'Approve the new supplier contract',
    classification: 'internal',
  });
  await move(alice, organization, deniedWork, 'ready');
  await askBob(deniedWork);
  const denied = await latestApproval(deniedWork);
  await decide(denied, bob, 'deny', { reason: 'The termination clause needs another look.' });

  const expiredWork = await createWork(alice, organization, {
    title: 'Confirm the venue for the client dinner',
  });
  await move(alice, organization, expiredWork, 'ready');
  await askBob(expiredWork);
  const expired = await latestApproval(expiredWork);
  await sql.query(
    `update work.approvals set expires_at = now() - interval '1 hour' where id = $1`,
    [expired],
  );

  const closedWork = await createWork(alice, organization, {
    title: 'Update the website footer',
  });
  await move(alice, organization, closedWork, 'ready');
  await askBob(closedWork);
  const closed = await latestApproval(closedWork);
  accepted(
    await post(
      page(closedWork),
      alice.jar,
      await formOn(page(closedWork), alice.jar, /Save changes/),
      {
        title: 'Update the website footer and the contact page',
        objective: '',
        dueAt: '',
      },
    ),
    'edit reviewed work',
  );

  // A review someone else has to decide, which Bob asked Alice for, so Bob reads it as the requester.
  const askedWork = await createWork(bob, organization, {
    title: 'Choose the winter campaign headline',
  });
  await move(bob, organization, askedWork, 'ready');
  accepted(
    await submit(page(askedWork), bob.jar, /name="approverMembershipId"/, {
      approverMembershipId: membership.carol,
    }),
    'ask Carol',
  );
  const asked = await latestApproval(askedWork);

  // Someone with an account and no organization, and someone with nothing in theirs.
  const newcomer = await signUp('Nadia Haddad');
  const quiet = await signUp('Quinn Lee');
  const quietOrganization = await createOrganization(quiet, 'Quiet Harbour Consulting');
  const both = await signUp('Blake Ito');
  await createOrganization(both, 'Ito & Sons');
  await bringIn(alice, organization, both);

  // Invitations in each state.
  const invited = await signUp('Ivy Chen');
  const invitedResponse = await submit(people, alice.jar, /name="email"/, {
    email: invited.email,
    role: 'member',
  });
  const inviteToken = tokenIn(await invitedResponse.text());
  if (!inviteToken) throw new Error('No invitation link');

  const asking = await signUp('Ana Silva');
  const askingResponse = await submit(people, alice.jar, /name="email"/, {
    email: asking.email,
    role: 'admin',
  });
  const askingToken = tokenIn(await askingResponse.text());
  if (!askingToken) throw new Error('No invitation link');
  await submit(`/invite/${askingToken}`, asking.jar, /Accept invitation/);

  const withdrawnEmail = `someone-${randomUUID().slice(0, 8)}@example.invalid`;
  await submit(people, alice.jar, /name="email"/, { email: withdrawnEmail, role: 'member' });
  accepted(
    await submit(people, alice.jar, (form) =>
      form.html.includes(`Withdraw the invitation for ${withdrawnEmail}`),
    ),
    'withdraw',
  );

  // One notification that has been reminded, and one that has been read.
  await sql.query(
    `update platform.notifications set reminders_sent = 1, last_reminded_at = now()
     where target_ref = $1`,
    [`approval:${holding}`],
  );
  const inbox = await read(`/o/${organization}/inbox`, alice.jar);
  const opened: FormMatch = (form) => form.hidden.has('target');
  if (/name="target"/.test(inbox.html)) {
    await submit(`/o/${organization}/inbox`, alice.jar, opened);
  }

  return {
    organization,
    alice,
    bob,
    carol,
    newcomer,
    quiet,
    quietOrganization,
    both,
    invited,
    asking,
    inviteToken,
    askingToken,
    membership,
    work: {
      queued,
      prerequisite,
      ready,
      plan,
      running,
      blocked,
      paused,
      verifying,
      done,
      doneWithFiles,
      failed,
      stopped,
      overdue,
      long,
      confidential,
    },
    approvals: { holding, plain, approved, denied, expired, closed, asked },
    sql,
    latestApproval,
    membershipOf,
    close: () => sql.end(),
  };
}
