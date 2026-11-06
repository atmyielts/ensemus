import { randomUUID } from 'node:crypto';
import { openAppDatabase, resolveTenantContext } from '@ensemus/database';
import { seedSearchableSource } from '../../helpers/knowledge';
import { urls } from '../../helpers/stack';
import { axeFindings, sidewaysOverflow } from '../support/look';
import { expect, test } from '../support/fixtures';

test('passage search filters before rendering and supports keyboard fact proposals', async ({
  open,
  world,
}) => {
  const database = openAppDatabase(urls.app(), { max: 1 }),
    word = `GeneratedSearch${randomUUID().replaceAll('-', '')}`,
    hidden = `HIDDEN${randomUUID().replaceAll('-', '')}`;
  try {
    const { rows } = await world.sql.query<{ id: string }>(
      'select id from identity.users where email=$1',
      [world.alice.email],
    );
    const context = await resolveTenantContext(database.db, rows[0]!.id, world.organization);
    await seedSearchableSource(database.db, context, {
      title: `Readable ${word}`,
      classification: 'restricted',
      passages: [`Generated readable passage ${word}.`],
      grants: [{ kind: 'membership', membershipId: world.membership.alice }],
    });
    await seedSearchableSource(database.db, context, {
      title: `Hidden ${hidden}`,
      classification: 'restricted',
      passages: [`Generated forbidden passage ${word} ${hidden}.`],
      grants: [{ kind: 'membership', membershipId: world.membership.bob }],
    });
    const page = await open(world.alice, { width: 375 });
    await page.goto(`/o/${world.organization}/knowledge/search`);
    await page.getByLabel('Words to look for', { exact: true }).fill(word);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Find passages', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText(`Generated readable passage ${word}.`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText(hidden);
    expect(page.url()).not.toContain(word);
    expect(await axeFindings(page)).toEqual([]);
    expect(await sidewaysOverflow(page)).toBe(0);
    await page.getByRole('link', { name: 'Propose a fact from this passage', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Propose a fact', exact: true })).toBeVisible();
    await expect(
      page.getByText(`Generated readable passage ${word}.`, { exact: true }),
    ).toBeVisible();
  } finally {
    await database.close();
  }
});

test('company search shows accessible work with a native GET form', async ({ open, world }) => {
  const page = await open(world.alice, { javaScriptEnabled: false });
  await page.goto(`/o/${world.organization}/search`);
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('pricing');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Redesign the pricing page', exact: true }),
  ).toBeVisible();
});
