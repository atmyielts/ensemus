// What someone has typed and not sent: it goes when they do, it stays through their own other actions,
// and it does not come back as the next decision. Signing out and in does not reload a tab, so each of
// these stays in one document from start to finish, which is the only way the fault can show.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { createOrganization, join, PASSWORD, signUp, type Person } from '../../helpers/forms';
import { expect, test } from '../support/fixtures';
import { createWork, move, workPath } from '../support/world';

const markDocument = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { stillHere: boolean }).stillHere = true;
  });
const sameDocument = (page: Page) =>
  page.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere === true);

/**
 * What is saved, and only that. The section holds the details form too, and a text area's text counts as
 * the section's, so looking in the section finds what was typed before any save has landed.
 */
const savedObjective = (page: Page) =>
  page.getByRole('region', { name: 'Purpose', exact: true }).locator('p').first();

const signIn = async (page: Page, person: Person) => {
  await expect(page.getByRole('heading', { name: 'Sign in to Ensemus' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(person.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
};

/** People of its own, because signing out ends a session that the shared world's people depend on. */
async function twoPeople() {
  const first = await signUp('Dana First');
  const organization = await createOrganization(first, `Drafts ${randomUUID()}`);
  const next = await join(first, organization, 'Evan Next');
  return { first, next, organization };
}

test.describe('the next person in the same tab', () => {
  test('does not get what the last person typed', async ({ open }) => {
    const { first, next, organization } = await twoPeople();
    const title = `Shared work ${randomUUID()}`;
    // Evan answers for it and Dana owns the organization, so the same panel is open to them both.
    const id = await createWork(next, organization, { title });

    const page = await open(first);
    await page.goto(workPath(organization, id));
    await markDocument(page);
    await page.locator('summary', { hasText: 'Stop this work' }).click();
    await page.getByLabel('Why is this being stopped?').fill('Dana wrote this and did not send it');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Ensemus' })).toBeVisible();
    await signIn(page, next);
    await page.getByRole('link', { name: 'Work', exact: true }).click();
    await page.getByRole('link', { name: title }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();

    await page.locator('summary', { hasText: 'Stop this work' }).click();
    await expect(page.getByLabel('Why is this being stopped?')).toHaveValue('');
    expect(await sameDocument(page), 'the tab was never reloaded').toBe(true);
  });

  test('does not get what they themselves typed before signing out', async ({ open }) => {
    const { first, organization } = await twoPeople();
    const title = `Own work ${randomUUID()}`;
    const id = await createWork(first, organization, { title });

    const page = await open(first);
    await page.goto(workPath(organization, id));
    await markDocument(page);
    await page.locator('summary', { hasText: 'Stop this work' }).click();
    await page.getByLabel('Why is this being stopped?').fill('Left behind on signing out');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await signIn(page, first);
    await page.getByRole('link', { name: 'Work', exact: true }).click();
    await page.getByRole('link', { name: title }).click();
    await page.locator('summary', { hasText: 'Stop this work' }).click();
    await expect(page.getByLabel('Why is this being stopped?')).toHaveValue('');
    expect(await sameDocument(page)).toBe(true);
  });

  test('does not find the last address on the sign-in page', async ({ open }) => {
    const { first } = await twoPeople();
    const page = await open(null);
    await page.goto('/sign-in');
    await markDocument(page);
    await signIn(page, first);
    await expect(page.getByRole('heading', { name: /^Hello/ })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Ensemus' })).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveValue('');
    expect(await sameDocument(page)).toBe(true);
  });
});

test.describe('editing the details', () => {
  test('keeps a draft through any other action on the page', async ({ open, world }) => {
    const { alice, organization } = world;
    const id = await createWork(alice, organization, { title: `Half written ${randomUUID()}` });
    const page = await open(alice);
    await page.goto(workPath(organization, id));
    await page.getByText('Edit the details').click();
    await page.getByLabel('Details').fill('Half an objective that must survive');

    await page.getByRole('button', { name: 'Mark ready' }).click();
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Ready');

    await expect(page.getByLabel('Details')).toBeVisible();
    await expect(page.getByLabel('Details')).toHaveValue('Half an objective that must survive');

    // The version moved underneath it, and that was the person's own doing, so it still saves.
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(savedObjective(page)).toHaveText('Half an objective that must survive');
    await expect(page.getByText('This changed while you were editing.')).toHaveCount(0);
  });

  test('has nothing left over once it is saved', async ({ open, world }) => {
    const { alice, organization } = world;
    const id = await createWork(alice, organization, { title: `Saved ${randomUUID()}` });
    const page = await open(alice);
    await page.goto(workPath(organization, id));
    await page.getByText('Edit the details').click();
    await page.getByLabel('Details').fill('Saved and finished with');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(savedObjective(page)).toHaveText('Saved and finished with');

    await page.getByRole('button', { name: 'Mark ready' }).click();
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Ready');
    await expect(page.locator('details', { hasText: 'Edit the details' })).not.toHaveAttribute(
      'open',
    );
  });

  test('a save still on its way cannot get the next press refused', async ({ open, world }) => {
    const { alice, organization } = world;
    const id = await createWork(alice, organization, { title: `Straight on ${randomUUID()}` });
    const page = await open(alice);
    await page.goto(workPath(organization, id));
    await page.getByText('Edit the details').click();
    await page.getByLabel('Details').fill('Saved before it was marked ready');

    // The save waits here for as long as the test says, so this happens inside it every time.
    let letItLand: () => void = () => undefined;
    const landed = new Promise<void>((done) => {
      letItLand = done;
    });
    await page.route('**/*', async (route) => {
      if (route.request().method() === 'POST') await landed;
      await route.fallback();
    });
    await page.getByRole('button', { name: 'Save changes' }).click();
    const markReady = page.getByRole('button', { name: 'Mark ready' });
    await expect(markReady).toBeDisabled();

    letItLand();
    await markReady.click();
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Ready');
    await expect(savedObjective(page)).toHaveText('Saved before it was marked ready');
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    await expect(page).not.toHaveURL(/error=/);
  });
});

test('a reason already sent is not offered for the next decision', async ({ open, world }) => {
  const { alice, organization } = world;
  const id = await createWork(alice, organization, { title: `Round again ${randomUUID()}` });
  await move(alice, organization, id, 'ready', 'running', 'failed');

  const page = await open(alice);
  await page.goto(workPath(organization, id));
  const reason = page.getByLabel('Why is it worth trying again?');
  await reason.fill('The supplier answered');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Ready');

  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('In progress');
  await page.getByRole('button', { name: 'Mark failed' }).click();
  await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Failed');
  await expect(reason).toHaveValue('');
});

test.describe('a file over the limit', () => {
  const TOO_LARGE = 'That file is larger than 25 MB, so it was not added. Attach a smaller one.';
  const MEGABYTE = 1024 * 1024;

  for (const [what, size] of [
    ['just over 25 MB', 25 * MEGABYTE + 1],
    ['over 26 MB, which the server would never see', 27 * MEGABYTE],
  ] as const) {
    test(`is refused before it is sent, in words that name the limit: ${what}`, async ({
      open,
      world,
    }) => {
      const { alice, organization } = world;
      const id = await createWork(alice, organization, { title: `Too big ${randomUUID()}` });
      const page = await open(alice);
      await page.goto(workPath(organization, id));
      const posts: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') posts.push(request.url());
      });

      const field = page.getByLabel('Attach a file');
      await field.setInputFiles({
        name: 'big.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(size),
      });
      await expect(page.getByRole('alert').filter({ hasText: TOO_LARGE })).toBeVisible();
      await page.getByRole('button', { name: 'Upload' }).click();
      await page.waitForTimeout(500);
      expect(posts, 'nothing was sent').toEqual([]);

      await field.setInputFiles({
        name: 'small.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('small'),
      });
      await expect(page.getByText(TOO_LARGE)).toHaveCount(0);
      await page.getByRole('button', { name: 'Upload' }).click();
      await expect(page.getByRole('link', { name: 'small.txt' })).toBeVisible();
    });
  }

  test('is refused by the server in the same words with scripts off', async ({ open, world }) => {
    const { alice, organization } = world;
    const id = await createWork(alice, organization, { title: `Too big ${randomUUID()}` });
    const page = await open(alice, { javaScriptEnabled: false });
    await page.goto(workPath(organization, id));
    await page.getByLabel('Attach a file').setInputFiles({
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(25 * MEGABYTE + 512 * 1024),
    });
    await page.getByRole('button', { name: 'Upload' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(TOO_LARGE);
  });
});

test('going back and typing something else makes that, and keeps the first', async ({
  open,
  world,
}) => {
  const { alice, organization } = world;
  const [first, second] = [`Typed first ${randomUUID()}`, `Typed second ${randomUUID()}`];
  const page = await open(alice);
  await page.goto(`/o/${organization}`);
  await page.getByRole('link', { name: 'New work' }).click();
  const title = page.getByLabel('What should be true when this is done?');
  await title.fill(first);
  await page.getByRole('button', { name: 'Create work' }).click();
  await expect(page.getByRole('heading', { name: first })).toBeVisible();

  await page.goBack();
  await title.fill(second);
  await page.getByRole('button', { name: 'Create work' }).click();
  await expect(page.getByRole('heading', { name: second })).toBeVisible();

  await page.getByRole('link', { name: 'Back to work' }).click();
  await expect(page.getByRole('link', { name: first })).toBeVisible();
  await expect(page.getByRole('link', { name: second })).toBeVisible();
});
