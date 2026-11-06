// UX-19, QA-047: the Assistants pages in a real browser. The web tier gets M4's run service at the final merge
// (ADR-031 D2). Until then its port is unavailable, so this holds the pages to what they must say then: a
// dedicated state, not an empty list and not an error. Written in code-only mode, and never run yet.
//
// Owed at the merge, once a run can be seeded: a real stop through the form with scripts off, the page saying it
// has not stopped until the run does, another person's run answering 404, and these unavailable tests moving to a
// deployment with the port turned off.
import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow } from '../support/look';

const EMPTY_WORDS = 'You have not handed anything to an assistant yet';
const UNAVAILABLE = 'Assistants are not available on this deployment yet';

test('says plainly when assistants are unavailable, and shows no empty list', async ({
  open,
  world,
}) => {
  const page = await open(world.bob);
  const response = await page.goto(`/o/${world.organization}/assistants`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Assistants' })).toBeVisible();
  await expect(page.getByRole('heading', { name: UNAVAILABLE })).toBeVisible();
  await expect(page.getByText('different from nothing running')).toBeVisible();
  await expect(page.getByText(EMPTY_WORDS)).toHaveCount(0);
  // Not an error: nothing here announces itself as one, and nothing pretends to be a working control.
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /stop/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Go to your work' })).toBeVisible();
});

test('one run is unavailable too, and does not claim to have stopped or to be missing', async ({
  open,
  world,
}) => {
  const page = await open(world.bob);
  const response = await page.goto(`/o/${world.organization}/assistants/${randomUUID()}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: UNAVAILABLE })).toBeVisible();
  await expect(page.getByText('different from it having stopped')).toBeVisible();
  await expect(page.getByRole('button', { name: /stop/i })).toHaveCount(0);
});

test('the address cannot make the page say something happened', async ({ open, world }) => {
  const page = await open(world.bob);
  await page.goto(
    `/o/${world.organization}/assistants/${randomUUID()}?stop=requested&error=%3Cb%3Ex%3C%2Fb%3E`,
  );
  await expect(page.getByRole('heading', { name: UNAVAILABLE })).toBeVisible();
  await expect(page.getByText('<b>x</b>')).toHaveCount(0);
  await expect(page.getByText('has not stopped yet')).toHaveCount(0);
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
  const page = await open(world.bob, { javaScriptEnabled: false });
  await page.goto(`/o/${world.organization}/assistants`);
  await expect(page.getByRole('heading', { name: UNAVAILABLE })).toBeVisible();
  await page.goto(`/o/${world.organization}/assistants/${randomUUID()}`);
  await expect(page.getByRole('heading', { name: UNAVAILABLE })).toBeVisible();
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
