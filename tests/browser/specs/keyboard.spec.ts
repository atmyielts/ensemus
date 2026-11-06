// UX-11, UX-14: everything a person has to do can be done with the keyboard alone, and they can always
// see where they are. No mouse call appears in this file: only key presses move anything.
import type { Page } from '@playwright/test';
import { PASSWORD, type Person, submit } from '../../helpers/forms';
import { expect, test } from '../support/fixtures';
import { createWork, move, workPath } from '../support/world';

type Stop = {
  tag: string;
  name: string;
  focusVisible: boolean;
  outlineWidth: number;
  outlineStyle: string;
  inView: boolean;
  covered: boolean;
};

/** What has focus now, and whether a sighted person could tell. */
const stopHere = (page: Page) =>
  page.evaluate<Stop | null>(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return null;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const inView = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
    const top = inView ? document.elementFromPoint(x, y) : null;
    return {
      tag: element.tagName.toLowerCase(),
      name: (
        element.getAttribute('aria-label') ||
        element.textContent?.trim() ||
        element.getAttribute('name') ||
        ''
      ).slice(0, 80),
      focusVisible: element.matches(':focus-visible'),
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineStyle: style.outlineStyle,
      inView,
      covered: Boolean(top && top !== element && !element.contains(top) && !top.contains(element)),
    };
  });

function expectVisible(stop: Stop) {
  const where = `${stop.tag} "${stop.name}"`;
  expect(stop.focusVisible, `${where} matches :focus-visible`).toBe(true);
  expect(stop.outlineStyle, `${where} has an outline`).not.toBe('none');
  expect(stop.outlineWidth, `${where} has a thick enough outline`).toBeGreaterThanOrEqual(2);
  expect(stop.inView, `${where} is on screen`).toBe(true);
  expect(stop.covered, `${where} is not covered by something else`).toBe(false);
}

/** Presses Tab until the wanted thing has focus, checking every stop along the way is visible. */
async function tabTo(page: Page, wanted: RegExp, limit = 60) {
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await stopHere(page);
    if (!stop) continue;
    expectVisible(stop);
    if (wanted.test(stop.name)) return stop;
  }
  throw new Error(`Tab never reached ${wanted}`);
}

/**
 * Walks the tab stops one way until focus leaves the page, comes round again, or stops at the end, and
 * returns how many different ones it reached. A trap ends the walk early, so the count falls short.
 */
async function walk(page: Page, key: 'Tab' | 'Shift+Tab', limit: number) {
  const seen = new Set<string>();
  let last: string | null = null;
  let sameInARow = 0;
  for (let i = 0; i < limit; i += 1) {
    await page.keyboard.press(key);
    const id = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      element.dataset.walk ??= String(Math.random());
      return element.dataset.walk;
    });
    if (id === null) return seen.size;
    // A date field takes several presses, one for each part of it. More than that is the last stop.
    sameInARow = id === last ? sameInARow + 1 : 0;
    if (sameInARow > 5 || (id !== last && seen.has(id))) return seen.size;
    last = id;
    seen.add(id);
  }
  throw new Error(`Focus was still moving after ${limit} presses`);
}

async function signInByKeyboard(page: Page, person: Person) {
  await page.goto('/sign-in');
  await tabTo(page, /^email$/);
  await page.keyboard.type(person.email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(PASSWORD);
  await tabTo(page, /^Sign in$/);
  await page.keyboard.press('Enter');
}

test('someone can sign in, reach an approval and approve it with only the keyboard', async ({
  open,
  world,
}) => {
  const { alice, bob, organization, membership } = world;
  const title = 'A decision made without a mouse';
  const id = await createWork(alice, organization, { title });
  await move(alice, organization, id, 'ready', 'running');
  await submit(workPath(organization, id), alice.jar, /name="approverMembershipId"/, {
    approverMembershipId: membership.bob,
  });
  const approval = await world.latestApproval(id);

  const page = await open(null);
  await signInByKeyboard(page, bob);
  await expect(page).toHaveURL(new RegExp(`/o/${organization}$`));

  await tabTo(page, /^Approvals/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/approvals$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();

  await tabTo(page, new RegExp(title));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/approvals/${approval}$`));
  await expect(page.getByRole('heading', { name: 'Your decision is needed' })).toBeVisible();

  await tabTo(page, /^reason$/);
  await page.keyboard.type('Read it, and it is fine.');
  await tabTo(page, /^Approve$/);
  await page.keyboard.press('Enter');

  await expect(page.getByText('Approved by Bob Okafor')).toBeVisible();
  await expect(page.getByText('Read it, and it is fine.')).toBeVisible();
  const { rows } = await world.sql.query('select status from work.approvals where id = $1', [
    approval,
  ]);
  expect(rows[0].status).toBe('approved');
});

test('someone can open the deny panel, tick the box and deny with only the keyboard', async ({
  open,
  world,
}) => {
  const { alice, bob, organization, membership } = world;
  const id = await createWork(alice, organization, { title: 'Denied from the keyboard' });
  await move(alice, organization, id, 'ready', 'running');
  await submit(workPath(organization, id), alice.jar, /name="approverMembershipId"/, {
    approverMembershipId: membership.bob,
  });
  const approval = await world.latestApproval(id);

  const page = await open(bob);
  await page.goto(`/o/${organization}/approvals/${approval}`);
  await tabTo(page, /^Deny$/);
  await page.keyboard.press('Enter');
  await tabTo(page, /^reason$/);
  await page.keyboard.type('Not this time.');
  await page.keyboard.press('Tab');
  const box = await stopHere(page);
  expect(box?.tag).toBe('input');
  expectVisible(box as Stop);
  await page.keyboard.press('Space');
  await tabTo(page, /^Deny and stop the work$/);
  await page.keyboard.press('Enter');

  await expect(page.getByText('Denied by Bob Okafor')).toBeVisible();
  const { rows } = await world.sql.query('select status from work.approvals where id = $1', [
    approval,
  ]);
  expect(rows[0].status).toBe('denied');
});

for (const width of [1280, 375]) {
  test(`the skip link is the first stop, shows itself and skips the navigation, at ${width}`, async ({
    open,
    world,
  }) => {
    const page = await open(world.alice, { width });
    await page.goto(`/o/${world.organization}/work`);
    await page.keyboard.press('Tab');
    const first = await stopHere(page);
    expect(first?.name).toBe('Skip to content');
    expectVisible(first as Stop);

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
    await page.keyboard.press('Tab');
    const next = await page.evaluate(() => Boolean(document.activeElement?.closest('main')));
    expect(next, 'the next stop is inside the main content').toBe(true);
  });
}

test('without the skip link, the next stop is the navigation', async ({ open, world }) => {
  // The control for the test above: it shows that one is really measuring a skip.
  const page = await open(world.alice);
  await page.goto(`/o/${world.organization}/work`);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const inMain = await page.evaluate(() => Boolean(document.activeElement?.closest('main')));
  expect(inMain).toBe(false);
});

test('focus is never trapped: every page can be walked through and out, both ways', async ({
  open,
  world,
}) => {
  const { organization, work, approvals, alice, bob } = world;
  const pages: Array<[Person, string]> = [
    [alice, `/o/${organization}`],
    [alice, `/o/${organization}/work`],
    [alice, `/o/${organization}/work/new`],
    [alice, `/o/${organization}/work/${work.running}`],
    [alice, `/o/${organization}/people`],
    [bob, `/o/${organization}/approvals/${approvals.holding}`],
  ];
  for (const [person, path] of pages) {
    const page = await open(person);
    await page.goto(path);
    await page.evaluate(() => {
      for (const panel of document.querySelectorAll('details')) panel.setAttribute('open', '');
    });
    const total = await page.evaluate(
      () =>
        [
          ...document.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([type="hidden"]), select, textarea, summary, [tabindex="0"]',
          ),
        ].filter((element) => element.getClientRects().length > 0).length,
    );
    expect(total, `${path} has something to tab to`).toBeGreaterThan(3);
    expect(await walk(page, 'Tab', 300), `${path} forwards`).toBe(total);
    // Focus is now on the last stop. Going back has to reach every other one.
    await page.evaluate(() => {
      for (const element of document.querySelectorAll<HTMLElement>('[data-walk]')) {
        delete element.dataset.walk;
      }
    });
    expect(await walk(page, 'Shift+Tab', 300), `${path} backwards`).toBeGreaterThanOrEqual(
      total - 1,
    );
  }
});

test('a brand-new person can sign up and create an organization with only the keyboard', async ({
  open,
}) => {
  const page = await open(null);
  await page.goto('/sign-up');
  const email = `keyboard-${Date.now()}@example.invalid`;
  await tabTo(page, /^name$/);
  await page.keyboard.type('Kit Lane');
  await page.keyboard.press('Tab');
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Set up your organization' })).toBeVisible();
  await tabTo(page, /^name$/);
  await page.keyboard.type('Lane Studio');
  await tabTo(page, /^Create organization$/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Hello, Kit' })).toBeVisible();
});
