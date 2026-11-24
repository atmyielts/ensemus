// API-13, NEXT-04: the page follows a Work Unit by itself. These change the work from outside the
// browser, the way another person would, and watch the open page move without it ever reloading.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { onReplica, submit } from '../../helpers/forms';
import { compose } from '../../helpers/stack';
import { expect, test } from '../support/fixtures';
import { createWork, move, workPath } from '../support/world';

/** Marks this document, so that a reload, which would start a new one, shows up as a missing mark. */
const markDocument = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { stillHere: boolean }).stillHere = true;
  });
const sameDocument = (page: Page) =>
  page.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere === true);

const statusBadge = (page: Page) => page.locator('dt:text-is("Status") + dd .badge');

/** The page's stream, which also asks to hear about files and reviews. */
const FOLLOWING = /\/events\?include=evidence$/;

/** A stream that has delivered nothing yet cannot prove anything about what comes next. */
async function streamOpen(page: Page, path: RegExp) {
  await page
    .waitForRequest((request) => path.test(request.url()), { timeout: 15_000 })
    .catch(() => {
      // It may already have gone out while the page loaded, before this started listening.
    });
}

const untilHealthy = (service: string) =>
  compose('up', '-d', '--wait', '--wait-timeout', '120', service);

test('the status changes on the page, with no reload, when someone else changes it', async ({
  open,
  world,
}) => {
  const { alice, organization } = world;
  const id = await createWork(alice, organization, { title: 'Moves while someone watches' });
  await move(alice, organization, id, 'ready');

  const page = await open(alice);
  await page.goto(workPath(organization, id));
  await expect(statusBadge(page)).toHaveText('Ready');
  await markDocument(page);
  await streamOpen(page, FOLLOWING);

  await move(alice, organization, id, 'running');
  await expect(statusBadge(page)).toHaveText('In progress');
  await move(alice, organization, id, 'verifying');
  await expect(statusBadge(page)).toHaveText('Checking');
  expect(await sameDocument(page)).toBe(true);
});

test('a file someone else attaches shows on the page, with no reload, and frees Mark done', async ({
  open,
  world,
}) => {
  const { alice, organization } = world;
  const id = await createWork(alice, organization, {
    title: `Evidence arrives ${randomUUID()}`,
    criteria: 'artifact_exists',
  });
  await move(alice, organization, id, 'ready', 'running', 'verifying');

  const page = await open(alice);
  await page.goto(workPath(organization, id));
  const verification = page.getByRole('region', { name: 'Checks and reviews', exact: true });
  await expect(verification).toContainText('Still needed');
  await expect(page.getByRole('button', { name: 'Mark done' })).toHaveCount(0);
  await markDocument(page);
  await streamOpen(page, FOLLOWING);

  // The version does not move for this, so only the stream's evidence event can tell the page.
  await submit(workPath(organization, id), alice.jar, /name="file"/, {
    file: new File(['the result'], 'result.txt', { type: 'text/plain' }),
  });
  await expect(verification).toContainText('In place');
  await expect(page.getByRole('link', { name: 'result.txt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark done' })).toBeVisible();
  expect(await sameDocument(page)).toBe(true);
});

test('a live update does not disturb what someone is typing', async ({ open, world }) => {
  const { alice, organization } = world;
  const id = await createWork(alice, organization, { title: 'Edited while it moves' });
  await move(alice, organization, id, 'ready');

  const page = await open(alice);
  await page.goto(workPath(organization, id));
  await page.getByText('Edit the details').click();
  await page.getByLabel('Details').fill('Half a thought that must survive');
  await move(alice, organization, id, 'running');
  await expect(statusBadge(page)).toHaveText('In progress');
  await expect(page.getByLabel('Details')).toHaveValue('Half a thought that must survive');
});

test('another viewer does not get a stream for work they cannot see', async ({ open, world }) => {
  const { alice, quiet, organization } = world;
  const id = await createWork(alice, organization, { title: 'Not for other tenants' });
  const page = await open(quiet);
  const status = await page
    .goto('/sign-in')
    .then(() =>
      page.evaluate(
        async (url) => (await fetch(url)).status,
        `/api/v1/organizations/${organization}/work-units/${id}/events`,
      ),
    );
  expect(status).toBe(404);
});

test('it keeps trying through server errors, and stops once told the work is gone', async ({
  open,
  world,
}) => {
  const { alice, organization } = world;
  const id = await createWork(alice, organization, { title: 'Told to stop following' });
  const page = await open(alice);

  let answer = 502;
  let asked = 0;
  await page.route(FOLLOWING, async (route) => {
    asked += 1;
    await route.fulfill({ status: answer, body: '' });
  });
  await page.goto(workPath(organization, id));
  await expect.poll(() => asked, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);

  answer = 404;
  await page.waitForTimeout(9_000); // Longer than the wait between two attempts by now.
  const whenTold = asked;
  await page.waitForTimeout(20_000);
  expect(asked, 'no more attempts after a 404').toBe(whenTold);
});

test.describe.serial('when web restarts', () => {
  // The address is one replica here, so taking it down really does cut the stream off.
  test.afterEach(() => {
    untilHealthy('web');
  });

  test('the page reconnects, and catches up on a change made while it was away', async ({
    open,
    world,
  }) => {
    const { alice, organization } = world;
    const id = await createWork(alice, organization, { title: 'Survives a web restart' });
    await move(alice, organization, id, 'ready');

    const page = await open(alice);
    await page.goto(workPath(organization, id));
    await expect(statusBadge(page)).toHaveText('Ready');
    await markDocument(page);
    await streamOpen(page, FOLLOWING);

    compose('stop', '-t', '5', 'web');
    // Long enough for the proxy to answer the stream's reconnect attempts with an error, which is
    // what happens to a real browser during a deployment.
    await page.waitForTimeout(8_000);

    await onReplica('web-2', () => move(alice, organization, id, 'running'));
    untilHealthy('web');

    await expect(statusBadge(page)).toHaveText('In progress', { timeout: 60_000 });
    expect(await sameDocument(page)).toBe(true);

    // And it is still following, not just caught up once.
    await move(alice, organization, id, 'verifying');
    await expect(statusBadge(page)).toHaveText('Checking', { timeout: 30_000 });
    expect(await sameDocument(page)).toBe(true);
  });

  test('the page reconnects after a plain restart too', async ({ open, world }) => {
    const { alice, organization } = world;
    const id = await createWork(alice, organization, { title: 'Survives a quick restart' });
    await move(alice, organization, id, 'ready');

    const page = await open(alice);
    await page.goto(workPath(organization, id));
    await expect(statusBadge(page)).toHaveText('Ready');
    await markDocument(page);

    compose('restart', '-t', '5', 'web');
    untilHealthy('web');

    await move(alice, organization, id, 'running');
    await expect(statusBadge(page)).toHaveText('In progress', { timeout: 60_000 });
    expect(await sameDocument(page)).toBe(true);
  });
});
