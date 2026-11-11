// The pages say forms work without JavaScript: "Without JavaScript it is an ordinary submit button"
// (submit-button.tsx), "It needs no JavaScript" (confirm-form.tsx), and "If this never runs, the page
// is still correct when reloaded" (live-status.tsx). These hold them to it, in a real browser with
// scripts turned off, from signing up through to a decision.
import { randomUUID } from 'node:crypto';
import { PASSWORD } from '../../helpers/forms';
import { expect, test } from '../support/fixtures';
import { createWork, move, workPath } from '../support/world';

const off = { javaScriptEnabled: false };

test('someone new can sign up, create an organization, and sign out and back in', async ({
  open,
}) => {
  const page = await open(null, off);
  await page.goto('/sign-up');
  const email = `no-js-${randomUUID()}@example.invalid`;
  await page.getByLabel('Name').fill('Noor Script');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByLabel('Organization name').fill('No Script Ltd');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Noor' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Ensemus' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('this is the wrong password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'That email and password did not match.',
  );
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Noor' })).toBeVisible();
});

test('new work is created, and a refused one comes back with what was typed', async ({
  open,
  world,
}) => {
  const page = await open(world.alice, off);
  await page.goto(`/o/${world.organization}/work/new`);
  await page.getByLabel('What should be true when this is done?').fill('   ');
  await page.getByLabel('Details').fill('Kept without any scripts.');
  await page.getByLabel('A reviewer approves').check();
  await page.getByRole('button', { name: 'Create work' }).click();

  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'Please check the details and try again.',
  );
  await expect(page.getByLabel('Details')).toHaveValue('Kept without any scripts.');
  await expect(page.getByLabel('A reviewer approves')).toBeChecked();

  const title = `No script work ${randomUUID()}`;
  await page.getByLabel('What should be true when this is done?').fill(title);
  await page.getByRole('button', { name: 'Create work' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
});

test('work moves through its statuses, and the page shows the new one', async ({ open, world }) => {
  const { alice, organization } = world;
  const id = await createWork(alice, organization, { title: `No script moves ${randomUUID()}` });
  const page = await open(alice, off);
  await page.goto(workPath(organization, id));
  await page.getByRole('button', { name: 'Mark ready' }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: 'Send for checking' }).click();
  await page.getByRole('button', { name: 'Confirm this is done' }).click();
  await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Done');
});

test('the confirm panel opens and works: stopping work needs the box and the reason', async ({
  open,
  world,
}) => {
  const { alice, organization } = world;
  const id = await createWork(alice, organization, { title: `No script stop ${randomUUID()}` });
  const page = await open(alice, off);
  await page.goto(workPath(organization, id));
  const panel = page.locator('details.confirm').filter({ hasText: 'Stop this work' });
  await expect(panel.getByRole('button', { name: 'Stop this work' })).toBeHidden();
  await panel.locator('summary').click();
  const status = page.locator('dt:text-is("Status") + dd .badge');
  const reason = panel.getByLabel('Why is this being stopped?');
  // The browser's own check holds the form back until both are done, so test each without the other.
  await panel.getByRole('checkbox').check();
  await expect(reason).toHaveValue('');
  await panel.getByRole('button', { name: 'Stop this work' }).click();
  await expect(page).toHaveURL(new RegExp(`/work/${id}$`));
  await expect(status).toHaveText('Waiting to start');
  expect(await reason.evaluate((field: HTMLTextAreaElement) => field.validity.valueMissing)).toBe(
    true,
  );

  await panel.getByRole('checkbox').uncheck();
  await reason.fill('Not needed any more.');
  await panel.getByRole('button', { name: 'Stop this work' }).click();
  await expect(page).toHaveURL(new RegExp(`/work/${id}$`));
  await expect(status).toHaveText('Waiting to start');

  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Stop this work' }).click();
  await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Stopped');
});

test('a file goes up, and an approval is decided', async ({ open, world }) => {
  const { alice, bob, organization, membership } = world;
  const id = await createWork(alice, organization, { title: `No script review ${randomUUID()}` });
  await move(alice, organization, id, 'ready', 'running');

  const owner = await open(alice, off);
  await owner.goto(workPath(organization, id));
  await owner.getByLabel('Attach a file').setInputFiles({
    name: 'evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Some evidence.'),
  });
  await owner.getByRole('button', { name: 'Upload' }).click();
  await expect(owner.getByRole('link', { name: 'evidence.txt' })).toBeVisible();
  await owner.getByLabel('Ask for a review from').selectOption(membership.bob);
  await owner.getByRole('button', { name: 'Request review' }).click();
  await expect(owner.locator('dt:text-is("Status") + dd .badge')).toHaveText(
    'Waiting for approval',
  );

  const reviewer = await open(bob, off);
  await reviewer.goto(`/o/${organization}/approvals`);
  await reviewer.getByRole('link', { name: /No script review/ }).click();
  await reviewer.getByLabel('Note for approving').fill('Fine by me.');
  await reviewer.getByRole('button', { name: 'Approve' }).click();
  await expect(reviewer.getByText('Approved by Bob Okafor')).toBeVisible();
});

test('the invitation link appears, and only there', async ({ open, world }) => {
  const page = await open(world.quiet, off);
  await page.goto(`/o/${world.quietOrganization}/people`);
  await page.getByLabel('Email address').fill(`invitee-${randomUUID()}@example.invalid`);
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(page.getByLabel('Invitation link')).toHaveValue(/\/invite\/[A-Za-z0-9_-]{43}$/);
  expect(page.url()).not.toContain('/invite/');
});

test('every section of an organization shows its content, not a loading message', async ({
  open,
  world,
}) => {
  const page = await open(world.alice, off);
  const sections: Array<[string, string]> = [
    ['', 'Hello, Alice'],
    ['/work', 'Work'],
    ['/work/new', 'New work'],
    ['/approvals', 'Approvals'],
    ['/people', 'People and teams'],
    ['/clients', 'Clients and projects'],
    ['/inbox', 'Inbox'],
  ];
  for (const [path, heading] of sections) {
    await page.goto(`/o/${world.organization}${path}`);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText('Loading this page')).toHaveCount(0);
  }
});

test('the status filter works', async ({ open, world }) => {
  const page = await open(world.alice, off);
  await page.goto(`/o/${world.organization}/work`);
  await page.getByLabel('Status').selectOption({ label: 'Failed' });
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(page).toHaveURL(/status=failed/);
  await expect(page.getByRole('link', { name: 'Import last year’s time sheets' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Redesign the pricing page' })).toHaveCount(0);
});

test('a page with no scripts is still correct when reloaded', async ({ open, world }) => {
  const { alice, organization } = world;
  const id = await createWork(alice, organization, { title: `No script reload ${randomUUID()}` });
  const page = await open(alice, off);
  await page.goto(workPath(organization, id));
  await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Waiting to start');
  await move(alice, organization, id, 'ready');
  await page.reload();
  await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Ready');
});
