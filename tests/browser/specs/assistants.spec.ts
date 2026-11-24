// UX-19, QA-047: the Assistants pages in a real browser. The web tier has M4's run service since the final merge
// (ADR-031 D2: until then each port threw CAPABILITY_UNAVAILABLE and the page said so). So these hold the pages
// to the live port: someone who has handed nothing to an assistant is told exactly that, a run that is not
// theirs or not there is the usual 404, and nothing on the page pretends to be a control or an outcome. The
// unavailable state, a dedicated state and never an empty list, is held by tests/unit/assistants-wording.test.ts
// with an unavailable port, since this deployment no longer has one.
//
// Still owed, once a run can be seeded through its real path: a real stop through the form with scripts off, the
// page saying it has not stopped until the run does, and another person's real run answering 404.
import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow } from '../support/look';

const EMPTY_WORDS = 'You have not handed anything to an assistant yet';
const UNAVAILABLE = 'Assistants are not available here yet';
const NOT_STOPPED = 'has not stopped yet';

test('says plainly that nothing has been handed to an assistant, and offers no control', async ({
  open,
  world,
}) => {
  // The owner of an organization with nothing in it, so nothing can ever have been handed over here.
  const page = await open(world.quiet);
  const response = await page.goto(`/o/${world.quietOrganization}/assistants`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Assistants' })).toBeVisible();
  await expect(page.getByText(EMPTY_WORDS)).toBeVisible();
  // The port answers here, so the page does not claim that it cannot read what assistants are doing.
  await expect(page.getByRole('heading', { name: UNAVAILABLE })).toHaveCount(0);
  // Not an error: nothing here announces itself as one, and nothing pretends to be a working control.
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /stop/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Go to your work' })).toBeVisible();
});

test('a run that is not there is the usual 404, and claims nothing about stopping', async ({
  open,
  world,
}) => {
  const page = await open(world.bob);
  const response = await page.goto(`/o/${world.organization}/assistants/${randomUUID()}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('heading', { name: UNAVAILABLE })).toHaveCount(0);
  await expect(page.getByText(NOT_STOPPED)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /stop/i })).toHaveCount(0);
});

test('the address cannot make the page say something happened', async ({ open, world }) => {
  const page = await open(world.bob);
  const forged = '?stop=requested&error=%3Cb%3Ex%3C%2Fb%3E';
  for (const path of ['assistants', `assistants/${randomUUID()}`]) {
    await page.goto(`/o/${world.organization}/${path}${forged}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('<b>x</b>')).toHaveCount(0);
    await expect(page.locator('main b', { hasText: /^x$/ })).toHaveCount(0);
    await expect(page.getByText(NOT_STOPPED)).toHaveCount(0);
  }
});

test('something that is not an ID answers 404', async ({ open, world }) => {
  const page = await open(world.bob);
  const response = await page.goto(`/o/${world.organization}/assistants/not-a-run`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('someone outside the organization gets the usual 404', async ({ open, world }) => {
  const page = await open(world.quiet);
  for (const path of ['assistants', `assistants/${randomUUID()}`]) {
    const response = await page.goto(`/o/${world.organization}/${path}`);
    expect(response?.status()).toBe(404);
  }
});

test('someone signed out goes to sign in', async ({ open, world }) => {
  const page = await open(null);
  await page.goto(`/o/${world.organization}/assistants`);
  await expect(page.getByRole('heading', { name: 'Sign in to Ensemus' })).toBeVisible();
});

test('reads the same with scripts off', async ({ open, world }) => {
  const page = await open(world.quiet, { javaScriptEnabled: false });
  await page.goto(`/o/${world.quietOrganization}/assistants`);
  await expect(page.getByText(EMPTY_WORDS)).toBeVisible();
  await expect(page.getByRole('heading', { name: UNAVAILABLE })).toHaveCount(0);
  expect(
    (await page.goto(`/o/${world.quietOrganization}/assistants/${randomUUID()}`))?.status(),
  ).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('can be reached and left with the keyboard, and focus shows', async ({ open, world }) => {
  const page = await open(world.bob);
  await page.goto(`/o/${world.organization}`);
  await page.getByRole('link', { name: 'Assistants' }).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Assistants' })).toBeVisible();

  const onward = page.getByRole('link', { name: 'Go to your work' });
  for (let presses = 0; presses < 60; presses += 1) {
    await page.keyboard.press('Tab');
    if (await onward.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(onward).toBeFocused();
  const outline = await onward.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Work' })).toBeVisible();
});

test('has no accessibility findings, at either width, in either theme', async ({ open, world }) => {
  const page = await open(world.bob);
  for (const path of ['assistants', `assistants/${randomUUID()}`]) {
    await page.goto(`/o/${world.organization}/${path}`);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await axeFindings(page)).toEqual([]);
        expect(await sidewaysOverflow(page)).toBe(0);
      }
    }
  }
});
