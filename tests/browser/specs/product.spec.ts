// UX-12, UX-13: Home, dependencies, and how forms behave under a person's hands, in a real browser.
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createOrganization, formOn, post, signUp, submit, tokenIn } from '../../helpers/forms';
import { expect, test } from '../support/fixtures';
import { createWork, move, toStatus, workPath } from '../support/world';

const section = (page: Page, heading: string) =>
  page.getByRole('region', { name: heading, exact: true });

/** The page's own alerts. Next.js keeps a route announcer outside the main content with that role. */
const alertIn = (page: Page) => page.getByRole('main').getByRole('alert');

/** Holds each form post back for a moment, so the page's waiting state can be seen. */
async function slowPosts(page: Page, milliseconds = 1_500) {
  const posts: string[] = [];
  await page.route('**/*', async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().url());
      await new Promise((done) => setTimeout(done, milliseconds));
    }
    await route.continue().catch(() => undefined);
  });
  return posts;
}

test.describe('Home', () => {
  test('someone with nothing to do is told so, and shown where to start', async ({
    open,
    world,
  }) => {
    const page = await open(world.quiet);
    await page.goto(`/o/${world.quietOrganization}`);
    await expect(page.getByRole('heading', { name: 'Hello, Quinn' })).toBeVisible();
    await expect(page.getByText('You are not on any open work.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Describe an outcome' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Needs you' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Your work' })).toHaveCount(0);
  });

  test('a decision waiting for someone comes first, and links to it', async ({ open, world }) => {
    const { alice, bob, organization, membership } = world;
    const title = `Home approval ${randomUUID()}`;
    const id = await createWork(alice, organization, { title });
    await move(alice, organization, id, 'ready');
    await submit(workPath(organization, id), alice.jar, /name="approverMembershipId"/, {
      approverMembershipId: membership.bob,
    });
    const approval = await world.latestApproval(id);

    const page = await open(bob);
    await page.goto(`/o/${organization}`);
    const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
    expect(headings[0]).toBe('Needs you');
    const link = section(page, 'Needs you').getByRole('link', { name: title });
    await expect(link).toHaveAttribute('href', `/o/${organization}/approvals/${approval}`);
    // Approvals share "Needs you" with late, blocked and failed work, and every one of them comes first.
    const hrefs = await section(page, 'Needs you')
      .getByRole('link')
      .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
    const lastApproval = hrefs.findLastIndex((href) => href.includes('/approvals/'));
    const firstWork = hrefs.findIndex((href) => href.includes('/work/'));
    expect(lastApproval).toBeGreaterThanOrEqual(0);
    if (firstWork >= 0) expect(lastApproval).toBeLessThan(firstWork);
  });

  test('the attention queue holds overdue, blocked and failed work, and nothing else', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    await page.goto(`/o/${world.organization}`);
    const queue = section(page, 'Needs you');
    await expect(
      queue.getByRole('link', { name: 'Renew the design software licences' }),
    ).toBeVisible();
    await expect(
      queue.getByRole('link', { name: 'Migrate the client newsletter list' }),
    ).toBeVisible();
    await expect(queue.getByRole('link', { name: 'Import last year’s time sheets' })).toBeVisible();
    await expect(queue.getByText(/Was due /)).toBeVisible();
    // Moving along normally, so it belongs under Your work, not here.
    await expect(queue.getByRole('link', { name: 'Redesign the pricing page' })).toHaveCount(0);
    await expect(
      section(page, 'Your work').getByRole('link', { name: 'Redesign the pricing page' }),
    ).toBeVisible();
    // Finished and stopped work needs nothing from anyone.
    await expect(page.getByRole('link', { name: 'Publish the autumn newsletter' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Plan the summer offsite' })).toHaveCount(0);
  });

  test('work someone is not on stays off their Home, even when it needs attention', async ({
    open,
    world,
  }) => {
    const page = await open(world.carol);
    await page.goto(`/o/${world.organization}`);
    await expect(
      page.getByRole('link', { name: 'Renew the design software licences' }),
    ).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Redesign the pricing page' })).toBeVisible();
  });
});

test.describe('what the pages say', () => {
  test('Home lists work once, and says so when all of it needs attention', async ({ open }) => {
    const person = await signUp('Una Single');
    const organization = await createOrganization(person, 'Single Item Ltd');
    const title = `Only trouble ${randomUUID()}`;
    const id = await createWork(person, organization, { title });
    await move(person, organization, id, 'ready', 'running', 'blocked');

    const page = await open(person);
    await page.goto(`/o/${organization}`);
    await expect(section(page, 'Needs you').getByRole('link', { name: title })).toBeVisible();
    await expect(section(page, 'Your work').getByRole('link', { name: title })).toHaveCount(0);
    await expect(section(page, 'Your work')).toContainText('Everything you are on is listed above');
  });

  test('a filter that matches nothing offers the way back, not new work', async ({
    open,
    world,
  }) => {
    const page = await open(world.quiet);
    await page.goto(`/o/${world.quietOrganization}/work?status=failed`);
    await expect(page.getByText('No work matches this filter.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Show all work' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Describe an outcome' })).toHaveCount(0);
  });

  test('finished work does not read as if it were still going', async ({ open, world }) => {
    const page = await open(world.alice);
    await page.goto(workPath(world.organization, world.work.done));
    await expect(section(page, 'Progress')).toHaveText(/This is done\.$/);
    await expect(page.getByText('People do this work')).toHaveCount(0);
    await expect(section(page, 'Checks and reviews')).not.toContainText('This is done.');
    await expect(page.getByText('Nobody was asked to review this.')).toBeVisible();

    await page.goto(workPath(world.organization, world.work.running));
    await expect(page.getByText('People do this work')).toBeVisible();
    await expect(page.getByText('Nobody has been asked to review this yet.')).toBeVisible();
  });

  test('a decided approval no longer talks about what deciding it would do', async ({
    open,
    world,
  }) => {
    const { bob, organization, approvals } = world;
    const page = await open(bob);
    await page.goto(`/o/${organization}/approvals/${approvals.denied}`);
    await expect(page.getByRole('heading', { name: 'What was asked' })).toBeVisible();
    await expect(page.getByText('What could happen', { exact: true })).toHaveCount(0);
    await expect(page.getByText('This work. No files are attached to it.')).toBeVisible();

    await page.goto(`/o/${organization}/approvals/${approvals.holding}`);
    await expect(page.getByRole('heading', { name: 'What would change' })).toBeVisible();
    await expect(page.getByText('What could happen', { exact: true })).toBeVisible();
    await expect(page.getByText('This work, and one file.')).toBeVisible();
  });

  test('the inbox names a decision waiting for this person, and nothing they cannot read', async ({
    open,
    world,
  }) => {
    const { alice, bob, carol, organization, membership } = world;
    const title = `Named in the inbox ${randomUUID()}`;
    const id = await createWork(alice, organization, { title, classification: 'confidential' });
    await submit(workPath(organization, id), alice.jar, /Add someone/, {
      membershipId: membership.bob,
    });
    await move(alice, organization, id, 'ready');
    await submit(workPath(organization, id), alice.jar, /name="approverMembershipId"/, {
      approverMembershipId: membership.bob,
    });

    const reviewer = await open(bob);
    await reviewer.goto(`/o/${organization}/inbox`);
    await expect(reviewer.getByText(title)).toBeVisible();

    const other = await open(carol);
    await other.goto(`/o/${organization}/inbox`);
    await expect(other.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    await expect(other.getByText(title)).toHaveCount(0);
  });

  test('past invitations are tucked away, and open ones are not', async ({ open, world }) => {
    const page = await open(world.alice);
    await page.goto(`/o/${world.organization}/people`);
    await expect(page.getByText('Accepted').first()).toBeHidden();
    await expect(page.getByText('Asking to join')).toBeVisible();
    await page.getByText(/^Past invitations/).click();
    await expect(page.getByText('Accepted').first()).toBeVisible();
    await expect(page.getByText('Withdrawn')).toBeVisible();
  });
});

test.describe('dependencies', () => {
  test('can be added and removed on the page, and decide whether work can be marked ready', async ({
    open,
    world,
  }) => {
    const { alice, organization } = world;
    const first = `Comes first ${randomUUID()}`;
    await createWork(alice, organization, { title: first });
    const id = await createWork(alice, organization, { title: `Comes second ${randomUUID()}` });

    const page = await open(alice);
    await page.goto(workPath(organization, id));
    const box = section(page, 'Waits for');
    await expect(box.getByText('Nothing.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark ready' })).toBeVisible();

    await box.getByLabel('Add work it waits for').selectOption({ label: first });
    await box.getByRole('button', { name: 'Add dependency' }).click();

    await expect(box.getByRole('link', { name: first })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark ready' })).toHaveCount(0);
    await expect(
      page.getByText('This cannot be marked ready until what it depends on is done.'),
    ).toBeVisible();
    // It is no longer offered, because it has already been added.
    await expect(
      box.getByLabel('Add work it waits for').getByRole('option', { name: first }),
    ).toHaveCount(0);

    await box.getByRole('button', { name: `Stop waiting on ${first}` }).click();
    await expect(box.getByRole('link', { name: first })).toHaveCount(0);
    await expect(box.getByText('Nothing.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark ready' })).toBeVisible();
  });

  test('a loop is refused in plain words, and the page stays put', async ({ open, world }) => {
    const { alice, organization } = world;
    const a = `Loop A ${randomUUID()}`;
    const b = `Loop B ${randomUUID()}`;
    const idA = await createWork(alice, organization, { title: a });
    const idB = await createWork(alice, organization, { title: b });
    await submit(workPath(organization, idA), alice.jar, /Add dependency/, { prerequisiteId: idB });

    const page = await open(alice);
    await page.goto(workPath(organization, idB));
    const box = section(page, 'Waits for');
    await box.getByLabel('Add work it waits for').selectOption({ label: a });
    await box.getByRole('button', { name: 'Add dependency' }).click();
    await expect(alertIn(page)).toHaveText(
      'That would make these pieces of work wait for each other forever, so it was not added.',
    );
    await expect(page).toHaveURL(new RegExp(`/work/${idB}`));
  });

  test('someone who cannot change the work gets no controls', async ({ open, world }) => {
    const page = await open(world.bob);
    await page.goto(workPath(world.organization, world.work.queued));
    const box = section(page, 'Waits for');
    await expect(box.getByRole('link').first()).toBeVisible();
    await expect(box.getByRole('button')).toHaveCount(0);
    await expect(box.getByRole('combobox')).toHaveCount(0);
  });
});

test.describe('a refused save keeps what was typed', () => {
  test('new work, with every field filled in', async ({ open, world }) => {
    const page = await open(world.alice);
    await page.goto(`/o/${world.organization}/work/new`);
    await page.getByLabel('What should be true when this is done?').fill('   ');
    await page.getByLabel('Details').fill('Everything I typed, kept.');
    await page.getByLabel('Due date').fill('2031-03-04');
    await page.getByLabel('Project').selectOption({ label: 'Spring campaign' });
    await page.getByRole('radio', { name: /^Confidential/ }).check();
    await page.getByLabel('A reviewer approves').check();
    await page.getByLabel('Ensemus runs the checklist plan').check();
    await page.getByRole('button', { name: 'Create work' }).click();

    await expect(alertIn(page)).toHaveText('Please check the details and try again.');
    await expect(page.getByText('It cannot be only spaces.')).toBeVisible();
    await expect(page.getByLabel('What should be true when this is done?')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    // Goes to the problem, because the button that was pressed is a long way below it.
    await expect(page.getByLabel('What should be true when this is done?')).toBeFocused();
    await expect(page.getByLabel('Details')).toHaveValue('Everything I typed, kept.');
    await expect(page.getByLabel('Due date')).toHaveValue('2031-03-04');
    await expect(page.getByLabel('Project')).toHaveValue(/.+/);
    await expect(page.getByRole('radio', { name: /^Confidential/ })).toBeChecked();
    await expect(page.getByLabel('A reviewer approves')).toBeChecked();
    await expect(page.getByLabel('Ensemus runs the checklist plan')).toBeChecked();
    await expect(page.getByLabel('Someone attaches a file')).not.toBeChecked();
  });

  test('editing, when someone else got there first', async ({ open, world }) => {
    const { alice, organization } = world;
    const title = `Edited twice ${randomUUID()}`;
    const id = await createWork(alice, organization, { title, objective: 'The original.' });

    const page = await open(alice);
    await page.goto(workPath(organization, id));
    await page.getByText('Edit the details').click();
    await page.getByLabel('Details').fill('What I was writing.');

    // The same person in another tab, which is enough: only the version matters here.
    await submit(workPath(organization, id), alice.jar, /Save changes/, {
      title,
      objective: 'What was saved first.',
      dueAt: '',
    });
    // The page has now heard about the change, or is about to. Either way this must not be lost.
    await expect(page.getByText('This changed while you were editing.')).toBeVisible();
    await expect(page.getByLabel('Details')).toHaveValue('What I was writing.');
    await expect(page.getByText('What was saved first.').first()).toBeVisible();
  });

  test('saving over someone else: refused the first time, and saved the second', async ({
    open,
    world,
  }) => {
    const { alice, organization, sql } = world;
    const title = `Saved twice ${randomUUID()}`;
    const id = await createWork(alice, organization, { title, objective: 'The original.' });
    const stored = async () =>
      (
        await sql.query<{ objective: string; version: number }>(
          'select objective, version::int as version from work.work_units where id = $1',
          [id],
        )
      ).rows[0];
    const started = (await stored())?.version as number;

    const page = await open(alice);
    await page.goto(workPath(organization, id));
    await page.getByText('Edit the details').click();
    await page.getByLabel('Details').fill('What I was writing.');
    await submit(workPath(organization, id), alice.jar, /Save changes/, {
      title,
      objective: 'What was saved first.',
      dueAt: '',
    });
    const first = { objective: 'What was saved first.', version: started + 1 };
    expect(await stored()).toEqual(first);

    // This draft still has the old version, whether or not the page has heard of the change yet.
    const save = page.getByRole('button', { name: 'Save changes' });
    await save.click();
    await expect(page.getByText('This changed while you were editing.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep my text' })).toHaveCount(0);
    await expect(save).toBeEnabled();
    // A refused save moved nothing, so the rest of the page comes back without a new version too.
    await expect(page.getByRole('button', { name: 'Mark ready' })).toBeEnabled();
    await expect(page.getByLabel('Details')).toHaveValue('What I was writing.');
    expect(await stored()).toEqual(first);

    // Having been shown what is there now, saving again is a knowing choice, and it has to go through.
    await save.click();
    await expect.poll(stored).toEqual({ objective: 'What I was writing.', version: started + 2 });
    await expect(section(page, 'Purpose').locator('p').first()).toHaveText('What I was writing.');
  });

  test('a reason for stopping work, when the stop is refused', async ({ open, world }) => {
    const { alice, organization } = world;
    const id = await createWork(alice, organization, { title: `Reason kept ${randomUUID()}` });
    const page = await open(alice);
    await page.goto(workPath(organization, id));
    await page.locator('summary', { hasText: 'Stop this work' }).click();
    await page.getByLabel('Why is this being stopped?').fill('A long reason worth keeping.');
    await page.getByRole('checkbox', { name: /Stop this work for good/ }).check();

    // Forged in the page to stand for any refusal: the version this form holds has gone stale.
    await page.locator('details.confirm input[name="version"]').evaluate((input) => {
      (input as HTMLInputElement).value = '999';
    });
    await page.getByRole('button', { name: 'Stop this work' }).click();
    await expect(alertIn(page)).toBeVisible();
    await expect(page).toHaveURL(/error=/);
    await expect(page.getByLabel('Why is this being stopped?')).toHaveValue(
      'A long reason worth keeping.',
    );
  });

  test('a note on an approval, when the decision is refused', async ({ open, world }) => {
    const { alice, bob, organization, membership } = world;
    const id = await createWork(alice, organization, { title: `Note kept ${randomUUID()}` });
    await move(alice, organization, id, 'ready');
    await submit(workPath(organization, id), alice.jar, /name="approverMembershipId"/, {
      approverMembershipId: membership.bob,
    });
    const approval = await world.latestApproval(id);

    const page = await open(bob);
    await page.goto(`/o/${organization}/approvals/${approval}`);
    await page.getByLabel('Note for approving').fill('A careful note worth keeping.');
    await page
      .locator('input[name="shownHash"]')
      .first()
      .evaluate((input) => {
        (input as HTMLInputElement).value = 'tampered';
      });
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(alertIn(page)).toContainText('review it again');
    await expect(page.getByLabel('Note for approving')).toHaveValue(
      'A careful note worth keeping.',
    );
  });

  test('the address, when a sign-in is refused, but never the password', async ({ open }) => {
    const page = await open(null);
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill('nobody@example.invalid');
    await page.getByLabel('Password').fill('not the right password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(alertIn(page)).toHaveText('That email and password did not match.');
    await expect(page.getByLabel('Email')).toHaveValue('nobody@example.invalid');
    await expect(page.getByLabel('Password')).toHaveValue('');
  });

  test('the invitation form, when the address is refused', async ({ open, world }) => {
    const page = await open(world.bob);
    await page.goto(`/o/${world.organization}/people`);
    // A member cannot invite anyone, so the form is not even offered.
    await expect(page.getByRole('button', { name: 'Create invitation' })).toHaveCount(0);

    const owner = await open(world.quiet);
    await owner.goto(`/o/${world.quietOrganization}/people`);
    // Past the browser's own check, to stand for any refusal from the server.
    await owner.locator('form:has(input[name="email"])').evaluate((form) => {
      (form as HTMLFormElement).noValidate = true;
    });
    await owner.getByLabel('Email address').fill('not an address');
    await owner.getByLabel('Access').selectOption('admin');
    await owner.getByRole('button', { name: 'Create invitation' }).click();
    await expect(alertIn(owner)).toBeVisible();
    await expect(owner.getByLabel('Email address')).toHaveValue('not an address');
    await expect(owner.getByLabel('Access')).toHaveValue('admin');
  });
});

test.describe('submitting', () => {
  test('a form shows it is working, and its button cannot be pressed again meanwhile', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    await page.goto(`/o/${world.organization}/work/new`);
    await slowPosts(page);
    const title = `Pending ${randomUUID()}`;
    await page.getByLabel('What should be true when this is done?').fill(title);
    const button = page.getByRole('button', { name: 'Create work' });
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Working on it' })).toBeVisible();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  });

  test('every form before you are in says it is working', async ({ open, world }) => {
    const email = () => `${randomUUID()}@example.invalid`;
    const signedOut = (fill: (page: Page) => Promise<void>) => ({ who: null, fill });
    const newPerson = await signUp('Pending Home');
    const invitedPerson = await signUp('Pending Invite');
    const invitation = await submit(
      `/o/${world.organization}/people`,
      world.alice.jar,
      /name="email"/,
      { email: invitedPerson.email, role: 'member' },
    );
    const token = tokenIn(await invitation.text());
    if (!token) throw new Error('No invitation link');
    const signUpFields = async (page: Page) => {
      await page.getByLabel('Name').fill('Pending Person');
      await page.getByLabel('Email').fill(email());
      await page.getByLabel('Password').fill('correct horse battery staple');
    };

    for (const { path, who, fill, button, working } of [
      {
        path: '/sign-in',
        button: 'Sign in',
        working: 'Signing in',
        ...signedOut(async (page) => {
          await page.getByLabel('Email').fill(email());
          await page.getByLabel('Password').fill('not the right password');
        }),
      },
      {
        path: '/sign-up',
        button: 'Create account',
        working: 'Creating your account',
        ...signedOut(signUpFields),
      },
      {
        path: '/setup',
        button: 'Create account',
        working: 'Creating your account',
        ...signedOut(async (page) => {
          await page.getByLabel('Setup code').fill('not-a-code');
          await signUpFields(page);
        }),
      },
      {
        path: '/',
        button: 'Create organization',
        working: 'Creating your organization',
        who: newPerson,
        fill: (page: Page) => page.getByLabel('Organization name').fill('Pending Organization'),
      },
      {
        path: `/invite/${token}`,
        button: 'Accept invitation',
        working: 'Accepting',
        who: invitedPerson,
        fill: async () => undefined,
      },
    ]) {
      const page = await open(who);
      await page.goto(path);
      await slowPosts(page);
      await fill(page);
      const submitButton = page.getByRole('button', { name: button, exact: true });
      await submitButton.click();
      await expect(submitButton, path).toBeDisabled();
      await expect(submitButton, path).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByRole('status').filter({ hasText: working }), path).toBeVisible();
    }
  });

  const countTitled = async (
    world: { sql: { query: (q: string, v: string[]) => Promise<{ rows: Array<{ n: number }> }> } },
    title: string,
  ) =>
    (
      await world.sql.query('select count(*)::int as n from work.work_units where title = $1', [
        title,
      ])
    ).rows[0]?.n;

  test('a double click creates one piece of work', async ({ open, world }) => {
    const page = await open(world.alice);
    await page.goto(`/o/${world.organization}/work/new`);
    const posts = await slowPosts(page, 500);
    const title = `Double click ${randomUUID()}`;
    await page.getByLabel('What should be true when this is done?').fill(title);
    await page.getByRole('button', { name: 'Create work' }).dblclick();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(await countTitled(world, title)).toBe(1);
  });

  test('pressing Enter twice creates one piece of work', async ({ open, world }) => {
    const page = await open(world.alice);
    await page.goto(`/o/${world.organization}/work/new`);
    await slowPosts(page, 500);
    const title = `Double enter ${randomUUID()}`;
    const field = page.getByLabel('What should be true when this is done?');
    await field.fill(title);
    await field.press('Enter');
    await field.press('Enter');
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    expect(await countTitled(world, title)).toBe(1);
  });

  test('the same rendered form posted twice creates one piece of work', async ({ world }) => {
    // What a double click can do with JavaScript off: the browser sends both, and only the server can
    // tell they are one request. This sends both for certain.
    const { alice, carol, organization } = world;
    const path = `/o/${organization}/work/new`;
    const form = await formOn(path, alice.jar, /name="title"/);
    const title = `Sent twice ${randomUUID()}`;
    const values = { title, classification: 'internal' };
    const first = await post(path, alice.jar, form, values);
    const second = await post(path, alice.jar, form, values);
    expect(first.headers.get('location')).toMatch(/\/work\/[0-9a-f-]{36}$/);
    expect(second.headers.get('location')).toBe(first.headers.get('location'));
    expect(await countTitled(world, title)).toBe(1);

    // Someone else's copy of that form is theirs, and reaches nothing of the first person's.
    const other = await post(path, carol.jar, form, { ...values, title: `${title} other` });
    expect(other.headers.get('location')).toMatch(/\/work\/[0-9a-f-]{36}$/);
    expect(other.headers.get('location')).not.toBe(first.headers.get('location'));
    expect(await countTitled(world, `${title} other`)).toBe(1);
  });

  test('a double click on a status button moves the work once', async ({ open, world }) => {
    const { alice, organization } = world;
    const id = await createWork(alice, organization, { title: `Moved once ${randomUUID()}` });
    const page = await open(alice);
    await page.goto(workPath(organization, id));
    await slowPosts(page, 300);
    await page.getByRole('button', { name: 'Mark ready' }).dblclick();
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
    await expect(alertIn(page)).toHaveCount(0);
    const { rows } = await world.sql.query(
      'select count(*)::int as n from work.work_transitions where work_unit_id = $1',
      [id],
    );
    expect(rows[0].n).toBe(1);
  });

  test('a double click on Create organization makes one organization', async ({ open }) => {
    const person = await signUp('Dee Double');
    const page = await open(person);
    await page.goto('/');
    await slowPosts(page, 500);
    await page.getByLabel('Organization name').fill('Only One Ltd');
    await page.getByRole('button', { name: 'Create organization' }).dblclick();
    await expect(page.getByRole('heading', { name: 'Hello, Dee' })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Hello, Dee' })).toBeVisible();
  });

  test('stale work gives a plain message, not a crash', async ({ open, world }) => {
    const { alice, organization } = world;
    const id = await createWork(alice, organization, { title: `Went stale ${randomUUID()}` });
    const page = await open(alice);
    await page.goto(workPath(organization, id));
    await page.route('**/events?*', (route) => route.abort());
    await page.reload();
    await submit(workPath(organization, id), alice.jar, toStatus('ready'));
    await page.getByRole('button', { name: 'Mark ready' }).click();
    await expect(alertIn(page)).toContainText(/changed this first|not allowed/);
  });
});
