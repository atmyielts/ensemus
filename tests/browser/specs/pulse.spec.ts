// Authored native/no-JavaScript and API journey; execution requires the joined0405 test stack.
import { randomUUID } from 'node:crypto';
import { createWorkUnit } from '@ensemus/application';
import { openAppDatabase, resolveTenantContext } from '@ensemus/database';
import { companyPulseSchema } from '@ensemus/contracts/experience';
import { urls } from '../../helpers/stack';
import { axeFindings, sidewaysOverflow } from '../support/look';
import { expect, test } from '../support/fixtures';

for (const javaScriptEnabled of [true, false])
  test(`Pulse follows evidence and keeps preferences personal (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
    open,
    world,
  }) => {
    const database = openAppDatabase(urls.app());
    const title = `Generated Pulse deadline ${randomUUID()}`;
    let workId: string;
    try {
      const owner = await world.sql.query<{ id: string }>(
        'select id from identity.users where email=$1',
        [world.alice.email],
      );
      if (!owner.rows[0]) throw new Error('TEST_OWNER_MISSING');
      const context = await resolveTenantContext(database.db, owner.rows[0].id, world.organization);
      workId = (
        await createWorkUnit(database.db, context, {
          title,
          objective: 'Check the visible generated evidence.',
          classification: 'internal',
          dueAt: new Date(Date.now() - 3 * 86_400_000),
        })
      ).id;
    } finally {
      await database.close();
    }
    const base = `/o/${world.organization}`,
      page = await open(world.alice, { javaScriptEnabled, width: 390 });
    await page.goto(`${base}/pulse`);
    await expect(page.getByRole('heading', { name: 'Company Pulse', exact: true })).toBeVisible();
    const row = page.getByRole('article', { name: title, exact: true });
    await expect(row).toContainText('The due date has passed');
    await row.getByRole('link', { name: `Open the work: ${title}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await page.goto(`${base}/pulse`);
    // Snoozing and dismissing are tucked away under one quiet control on each row.
    await row.getByText('Snooze or dismiss', { exact: true }).click();
    await row.getByRole('button', { name: /^Dismiss / }).click();
    await expect(page.getByRole('article', { name: title, exact: true })).toHaveCount(0);
    const other = await open(world.bob, { javaScriptEnabled });
    await other.goto(`${base}/pulse`);
    await expect(other.getByRole('article', { name: title, exact: true })).toContainText(
      'The due date has passed',
    );
    await page.getByRole('link', { name: 'Review dismissed signals', exact: true }).click();
    await expect(row).toContainText('Dismissed only for you');
    await row.getByRole('button', { name: /^Restore / }).click();
    await expect(row).toBeVisible();
    await row.getByText('Snooze or dismiss', { exact: true }).click();
    await row.getByLabel('Snooze for', { exact: true }).selectOption('7');
    await row.getByRole('button', { name: /^Snooze / }).click();
    await expect(row).toContainText('Snoozed until');
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
    expect(await axeFindings(page)).toEqual([]);
    const endpoint = `/api/v1/organizations/${world.organization}/pulse`;
    const response = await page.request.get(endpoint);
    expect(response.status()).toBe(200);
    const body = companyPulseSchema.parse(await response.json());
    expect(
      body.signals.find((signal) => signal.key === `work_overdue:${workId}`)?.personal_state,
    ).toBe('snoozed');
    const signalEndpoint = `${endpoint}/signals/${encodeURIComponent(`work_overdue:${workId}`)}`;
    const headers = { Origin: new URL(page.url()).origin };
    expect(
      (
        await page.request.put(signalEndpoint, {
          headers,
          data: { state: 'snoozed', until: new Date(Date.now() + 31 * 86_400_000).toISOString() },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await page.request.put(signalEndpoint, {
          headers,
          data: { state: 'dismissed', membership_id: randomUUID() },
        })
      ).status(),
    ).toBe(400);
    expect((await page.request.get(`${endpoint}?include_dismissed=invalid`)).status()).toBe(400);
  });
