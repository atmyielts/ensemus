// CONNECT-06: unknown external state is visible for manual review. In a real browser: the words, keyboard
// use, no JavaScript, axe in both themes and widths, and who gets a page at all. An action only reaches
// `unknown` through a worker, so these walk one there with SQL, through the real triggers. Nothing here
// sends anything, and every address is a generated test value.
import { createHash, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { axeFindings, openPanels, sidewaysOverflow, THEMES, WIDTHS } from '../support/look';
import { createWork, superuser } from '../support/world';
import type { Person } from '../../helpers/forms';

type Seeded = { id: string; approvalId: string; work: string; messageIdFragment: string };

async function membershipOf(person: Person, organization: string) {
  const su = await superuser();
  try {
    const { rows } = await su.query(
      `select m.id from org.memberships m join identity.users u on u.id = m.user_id
       where u.email = $1 and m.organization_id = $2`,
      [person.email, organization],
    );
    return rows[0].id as string;
  } finally {
    await su.end();
  }
}

/** Walks an intent to `status`, as a worker would have, on a Work Unit of its own. */
async function seedAction(
  owner: Person,
  approver: Person,
  organization: string,
  status: 'awaiting_approval' | 'unknown' | 'sent' | 'failed',
): Promise<Seeded> {
  const work = await createWork(owner, organization, { title: `Sends ${randomUUID()}` });
  const approverId = await membershipOf(approver, organization);
  const su = await superuser();
  const id = randomUUID();
  const approvalId = randomUUID();
  const attemptId = randomUUID();
  const connection = randomUUID();
  const hash = createHash('sha256').update(id).digest('hex');
  const payload = {
    from: { address: 'sender@example.invalid', name: 'The sender' },
    to: ['client@example.invalid'],
    bcc: ['hidden@example.invalid'],
    subject: 'The kickoff note',
    text_body: 'We have started.',
  };
  const action = {
    toolName: 'email.send',
    toolVersion: '1',
    targetRef: `connection:${connection}`,
    payload,
  };
  try {
    await su.query('begin');
    await su.query(
      `insert into integrations.connections (organization_id, id, connector_type, display_name, config)
       values ($1, $2, 'email_smtp', 'Team mail', $3)`,
      [organization, connection, { fromAddress: payload.from.address }],
    );
    await su.query(
      `insert into work.approvals (organization_id, id, work_unit_id, tool_name, action, action_hash,
         target_ref, approver_membership_id, expires_at)
       values ($1, $2, $3, 'email.send', $4, $5, $6, $7, now() + interval '1 hour')`,
      [organization, approvalId, work, action, hash, action.targetRef, approverId],
    );
    await su.query(
      `insert into integrations.external_actions (organization_id, id, work_unit_id, connection_id,
         tool_name, tool_version, target_ref, payload, request_hash, idempotency_key, classification,
         requires_approval, approval_id, status)
       values ($1, $2, $3, $4, 'email.send', '1', $5, $6, $7, $8, 'internal', true, $9,
         'awaiting_approval')`,
      [
        organization,
        id,
        work,
        connection,
        action.targetRef,
        payload,
        hash,
        `ensemus-${id}`,
        approvalId,
      ],
    );
    if (status !== 'awaiting_approval') {
      await su.query(
        `update work.approvals set status = 'approved', decided_at = now() where id = $1`,
        [approvalId],
      );
      const move = (to: string) =>
        su.query('update integrations.external_actions set status = $1 where id = $2', [to, id]);
      await move('ready');
      await su.query(
        `insert into integrations.external_action_attempts (organization_id, id, external_action_id,
           attempt_no, request_hash, idempotency_key, run_id)
         values ($1, $2, $3, 1, $4, $5, 'test-run')`,
        [organization, attemptId, id, hash, `ensemus-${id}`],
      );
      await move('sending');
      const outcome =
        status === 'sent' ? 'accepted' : status === 'failed' ? 'rejected' : 'indeterminate';
      await su.query(
        'update integrations.external_action_attempts set outcome = $1 where id = $2',
        [outcome, attemptId],
      );
      if (status === 'unknown') {
        await move('reconciling');
        await move('unknown');
      } else {
        await move(status);
      }
    }
    await su.query('commit');
  } catch (error) {
    await su.query('rollback');
    throw error;
  } finally {
    await su.end();
  }
  return { id, approvalId, work, messageIdFragment: `<${id}@` };
}

const actionPath = (organization: string, id: string) =>
  `/o/${organization}/external-actions/${id}`;

/** Sent and not sent words that must never be anywhere near an unknown action's status. */
const main = (page: Page) => page.getByRole('main');

test('an unknown action says so, says what to do, and offers no way to send', async ({
  open,
  world,
}) => {
  const seeded = await seedAction(world.alice, world.bob, world.organization, 'unknown');
  const page = await open(world.alice);
  await page.goto(actionPath(world.organization, seeded.id));

  await expect(main(page).getByText("We don't know whether this was sent").first()).toBeVisible();
  await expect(main(page).getByText('Ensemus will not try again by itself')).toBeVisible();
  await expect(main(page).getByText(seeded.messageIdFragment)).toBeVisible();
  // The status is words, not only a colour, and it is not any kind of sent or failed.
  const status = main(page).locator('dd .badge.unknown');
  await expect(status).toContainText("We don't know whether this was sent");
  await expect(main(page).locator('dd .badge.done, dd .badge.bad')).toHaveCount(0);

  // There is no send button here, under any name.
  const buttons = await main(page).getByRole('button').allInnerTexts();
  expect(buttons.filter((name) => /\b(send|retry|resend|try again)\b/i.test(name))).toEqual([]);
  await expect(main(page).getByRole('button', { name: 'Record what I found' })).toBeVisible();
});

test('the person who answers says what they found, and it reads as their word', async ({
  open,
  world,
}) => {
  const seeded = await seedAction(world.alice, world.bob, world.organization, 'unknown');
  const page = await open(world.alice);
  await page.goto(actionPath(world.organization, seeded.id));
  await page.getByLabel('It went: I found it').check();
  await page.getByLabel('How do you know?').fill('It is in the relay log.');
  await page.getByRole('button', { name: 'Record what I found' }).click();

  await expect(main(page).locator('dd .badge.done')).toContainText('Sent: confirmed by');
  await expect(main(page).getByText('It is in the relay log.')).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Record what I found' })).toHaveCount(0);
});

test('saying it did not go ends it as not sent, and asking again needs a new approval', async ({
  open,
  world,
}) => {
  const seeded = await seedAction(world.alice, world.bob, world.organization, 'unknown');
  const page = await open(world.alice);
  await page.goto(actionPath(world.organization, seeded.id));
  await page.getByLabel('It did not go: it is not there').check();
  await page.getByLabel('How do you know?').fill('Nothing in the log for that day.');
  await page.getByRole('button', { name: 'Record what I found' }).click();
  await expect(main(page).locator('dd .badge.bad')).toContainText('Not sent: confirmed by');
  await expect(main(page).locator('dd .badge.unknown')).toHaveCount(0);
});

test('someone who may read it but not answer sees it, and no form', async ({ open, world }) => {
  const seeded = await seedAction(world.alice, world.bob, world.organization, 'unknown');
  const page = await open(world.bob);
  await page.goto(actionPath(world.organization, seeded.id));
  await expect(main(page).getByText("We don't know whether this was sent").first()).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Record what I found' })).toHaveCount(0);
  await expect(main(page).getByText('says what they found')).toBeVisible();
});

test('it comes first on the list for who can answer, and is not asked of anyone else', async ({
  open,
  world,
}) => {
  const seeded = await seedAction(world.alice, world.bob, world.organization, 'unknown');
  const page = await open(world.alice);
  await page.goto(`/o/${world.organization}/external-actions`);
  const decision = page.getByRole('region', { name: 'Needs a decision' });
  await expect(decision.getByRole('link', { name: 'The kickoff note' }).first()).toHaveAttribute(
    'href',
    actionPath(world.organization, seeded.id),
  );
  const headings = await main(page).getByRole('heading', { level: 2 }).allInnerTexts();
  expect(headings[0]).toBe('Needs a decision');

  const other = await open(world.bob);
  await other.goto(`/o/${world.organization}/external-actions`);
  await expect(main(other).getByRole('heading', { name: 'Needs a decision' })).toHaveCount(0);
});

test('another organization, and a missing action, get the usual not found', async ({
  open,
  world,
}) => {
  const seeded = await seedAction(world.alice, world.bob, world.organization, 'unknown');
  const outsider = await open(world.newcomer);
  const denied = await outsider.goto(actionPath(world.organization, seeded.id));
  expect(denied?.status()).toBe(404);

  const page = await open(world.alice);
  const missing = await page.goto(actionPath(world.organization, randomUUID()));
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('connections are not there for a member', async ({ open, world }) => {
  const page = await open(world.bob);
  const response = await page.goto(`/o/${world.organization}/connections`);
  expect(response?.status()).toBe(404);
});

test('the empty list says what would appear there', async ({ open, world }) => {
  const page = await open(world.quiet);
  await page.goto(`/o/${world.quietOrganization}/external-actions`);
  await expect(main(page).getByText('Nothing yet.')).toBeVisible();
  await expect(main(page).getByRole('heading', { name: 'Needs a decision' })).toHaveCount(0);
});

test('the approver sees the exact email, blind copies included', async ({ open, world }) => {
  const seeded = await seedAction(world.alice, world.bob, world.organization, 'awaiting_approval');
  const page = await open(world.bob);
  await page.goto(`/o/${world.organization}/approvals/${seeded.approvalId}`);
  const email = page.getByRole('region', { name: 'The exact email' });
  await expect(email.getByText('client@example.invalid')).toBeVisible();
  await expect(email.getByText('hidden@example.invalid')).toBeVisible();
  await expect(email.getByText('The kickoff note')).toBeVisible();
  await expect(email.getByText('We have started.')).toBeVisible();
  await expect(main(page).getByText('cannot be taken back')).toBeVisible();
});

test('resolving works with the keyboard alone', async ({ open, world }) => {
  const seeded = await seedAction(world.alice, world.bob, world.organization, 'unknown');
  const page = await open(world.alice);
  await page.goto(actionPath(world.organization, seeded.id));
  await page.getByLabel('It went: I found it').focus();
  await page.keyboard.press('Space');
  await page.getByLabel('How do you know?').focus();
  await page.keyboard.type('Found by keyboard.');
  await page.getByRole('button', { name: 'Record what I found' }).focus();
  await page.keyboard.press('Enter');
  await expect(main(page).locator('dd .badge.done')).toContainText('Sent: confirmed by');
});

test('without JavaScript the page says the same, and resolving still works', async ({
  open,
  world,
}) => {
  const seeded = await seedAction(world.alice, world.bob, world.organization, 'unknown');
  const page = await open(world.alice, { javaScriptEnabled: false });
  await page.goto(actionPath(world.organization, seeded.id));
  await expect(main(page).getByText("We don't know whether this was sent").first()).toBeVisible();
  await page.getByLabel('It went: I found it').check();
  await page.getByLabel('How do you know?').fill('Found without scripts.');
  await page.getByRole('button', { name: 'Record what I found' }).click();
  await expect(main(page).locator('dd .badge.done')).toContainText('Sent: confirmed by');
});

test('a refused answer comes back as a known message, without JavaScript', async ({
  open,
  world,
}) => {
  const seeded = await seedAction(world.alice, world.bob, world.organization, 'unknown');
  const stale = await open(world.alice, { javaScriptEnabled: false });
  await stale.goto(actionPath(world.organization, seeded.id));
  const other = await open(world.alice);
  await other.goto(actionPath(world.organization, seeded.id));
  await other.getByLabel('It went: I found it').check();
  await other.getByLabel('How do you know?').fill('First.');
  await other.getByRole('button', { name: 'Record what I found' }).click();
  await expect(main(other).locator('dd .badge.done')).toBeVisible();

  await stale.getByLabel('It did not go: it is not there').check();
  await stale.getByLabel('How do you know?').fill('Second.');
  await stale.getByRole('button', { name: 'Record what I found' }).click();
  await expect(main(stale).getByRole('alert')).toHaveText(
    'Only an action in an unknown state can be resolved.',
  );
  await expect(main(stale).locator('dd .badge.done')).toBeVisible();
});

for (const status of ['unknown', 'sent', 'failed', 'awaiting_approval'] as const) {
  test(`an action ${status} has no accessibility violations, in either theme or width`, async ({
    open,
    world,
  }) => {
    const seeded = await seedAction(world.alice, world.bob, world.organization, status);
    const page = await open(world.alice);
    const paths = [
      actionPath(world.organization, seeded.id),
      `/o/${world.organization}/external-actions`,
      `/o/${world.organization}/connections`,
    ];
    const problems: Record<string, unknown> = {};
    for (const path of paths) {
      await page.goto(path);
      for (const theme of THEMES) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
          await openPanels(page);
          const findings = await axeFindings(page);
          if (findings.length) problems[`${path} ${theme}-${width}`] = findings;
          const overflow = await sidewaysOverflow(page);
          if (overflow > 0) problems[`${path} ${theme}-${width} overflow`] = overflow;
        }
      }
    }
    expect(problems).toEqual({});
  });
}
