// Authored browser gate for actual DAL-backed source controls. No browser execution claim.
import { randomUUID } from 'node:crypto';
import type { Person } from '../../helpers/forms';
import {
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  knowledgeDocuments,
} from '@ensemus/database';
import { createTeam, addTeamMember } from '@ensemus/application';
import { getSource, setSourceGrants } from '@ensemus/application/knowledge/sources';
import { eq } from 'drizzle-orm';
import { seedSearchableSource } from '../../helpers/knowledge';
import { urls } from '../../helpers/stack';
import { axeFindings, sidewaysOverflow } from '../support/look';
import { expect, test } from '../support/fixtures';
import type { World } from '../support/world';

async function contextFor(
  database: ReturnType<typeof openAppDatabase>,
  world: World,
  person: Person,
) {
  const { rows } = await world.sql.query<{ id: string }>(
    'select id from identity.users where email=$1',
    [person.email],
  );
  return resolveTenantContext(database.db, rows[0]!.id, world.organization);
}

for (const javaScriptEnabled of [true, false])
  test(`uploads a source replacement with native version feedback (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
    open,
    world,
  }) => {
    const database = openAppDatabase(urls.app(), { max: 1 });
    try {
      const context = await contextFor(database, world, world.alice),
        source = await seedSearchableSource(database.db, context, {
          title: `Generated version ${randomUUID()}`,
          classification: 'restricted',
          passages: ['Generated published passage.'],
          grants: [{ kind: 'membership', membershipId: context.membershipId }],
        });
      const page = await open(world.alice, { javaScriptEnabled, width: 375 });
      await page.goto(`/o/${world.organization}/knowledge/sources/${source.sourceId}`);
      const versions = page.getByRole('region', { name: 'Source versions', exact: true });
      await expect(versions.getByText(/Latest version:\s*1/)).toBeVisible();
      await versions.getByLabel('Replacement document', { exact: true }).setInputFiles({
        name: 'replacement.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Generated replacement passage.'),
      });
      await versions
        .getByRole('button', { name: 'Upload replacement version', exact: true })
        .click();
      await expect(page).toHaveURL(/version_result=saved/);
      await expect(versions.getByText(/Latest version:\s*2/)).toBeVisible();
      await expect(
        versions.getByText(
          'The replacement file was saved. Its current processing state is shown below.',
          { exact: true },
        ),
      ).toBeVisible();
      const rows = await withTenantTx(database.db, context, (tx) =>
        tx
          .select({ id: knowledgeDocuments.id })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.sourceId, source.sourceId)),
      );
      expect(rows).toHaveLength(2);
      expect(await axeFindings(page)).toEqual([]);
      expect(await sidewaysOverflow(page)).toBe(0);
    } finally {
      await database.close();
    }
  });

test('hides replacement controls from a named reader and refuses stale access on submit', async ({
  open,
  world,
}) => {
  const database = openAppDatabase(urls.app(), { max: 1 });
  try {
    const context = await contextFor(database, world, world.alice),
      source = await seedSearchableSource(database.db, context, {
        title: 'Generated current source',
        classification: 'restricted',
        passages: ['Generated published private passage.'],
        grants: [
          { kind: 'membership', membershipId: context.membershipId },
          { kind: 'membership', membershipId: world.membership.bob },
        ],
      });
    const reader = await open(world.bob);
    await reader.goto(`/o/${world.organization}/knowledge/sources/${source.sourceId}`);
    await expect(
      reader.getByRole('heading', { name: 'Generated current source', exact: true }),
    ).toBeVisible();
    await expect(
      reader.getByRole('button', { name: 'Upload replacement version', exact: true }),
    ).toHaveCount(0);
    const owner = await open(world.alice);
    await owner.goto(`/o/${world.organization}/knowledge/sources/${source.sourceId}`);
    const versions = owner.getByRole('region', { name: 'Source versions', exact: true });
    await versions.getByLabel('Replacement document', { exact: true }).setInputFiles({
      name: 'replacement.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Generated refused source words.'),
    });
    const before = await getSource(database.db, context, source.sourceId),
      own = before.grants.find(
        (grant) => grant.kind === 'membership' && grant.membershipId === context.membershipId,
      );
    if (!own) throw new Error('MISSING_GENERATED_GRANT');
    await setSourceGrants(database.db, context, {
      sourceId: source.sourceId,
      expectedVersion: before.version,
      add: [],
      removeGrantIds: [own.id],
    });
    await versions.getByRole('button', { name: 'Upload replacement version', exact: true }).click();
    await expect(owner.getByRole('main')).toContainText(/Not found|not shared with you/i);
    const readerContext = await contextFor(database, world, world.bob);
    const rows = await withTenantTx(database.db, readerContext, (tx) =>
      tx
        .select({ id: knowledgeDocuments.id })
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.sourceId, source.sourceId)),
    );
    expect(rows).toHaveLength(1);
  } finally {
    await database.close();
  }
});

for (const javaScriptEnabled of [true, false])
  test(`shares with a real team and narrows that access when sensitivity rises (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
    open,
    world,
  }) => {
    const database = openAppDatabase(urls.app(), { max: 1 }),
      title = `Generated team source ${randomUUID()}`;
    try {
      const context = await contextFor(database, world, world.alice),
        team = await createTeam(database.db, context, {
          name: `Generated source team ${randomUUID()}`,
        });
      if (!team) throw new Error('GENERATED_TEAM_SEED_REFUSED');
      await addTeamMember(database.db, context, {
        teamId: team.id,
        membershipId: world.membership.bob,
      });
      const page = await open(world.alice, { javaScriptEnabled, width: 375 });
      await page.goto(`/o/${world.organization}/knowledge/new`);
      await page.getByLabel('Source name', { exact: true }).fill(title);
      const sharing = page.getByLabel('Share with', { exact: true });
      await expect(
        sharing.getByRole('option', { name: 'Everyone in this organization', exact: true }),
      ).toHaveCount(0);
      await expect(
        sharing.getByRole('option', { name: `Team: ${team.name}`, exact: true }),
      ).toHaveCount(0);
      await page.getByLabel('Sensitivity', { exact: true }).selectOption('confidential');
      if (javaScriptEnabled) await sharing.selectOption(`team:${team.id}`);
      await page.getByLabel('Document', { exact: true }).setInputFiles({
        name: 'team-source.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Generated team-readable words.'),
      });
      await page.getByRole('button', { name: 'Add source', exact: true }).click();
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      if (!javaScriptEnabled) {
        const access = page.getByRole('region', { name: 'Source access', exact: true });
        await access.getByLabel('Share with', { exact: true }).selectOption(`team:${team.id}`);
        await access.getByRole('button', { name: 'Add access', exact: true }).click();
      }
      await expect(
        page.getByRole('button', { name: `Remove access for ${team.name}`, exact: true }),
      ).toBeVisible();
      const path = new URL(page.url()).pathname,
        reader = await open(world.bob, { javaScriptEnabled });
      await reader.goto(path);
      await expect(reader.getByRole('heading', { name: title, exact: true })).toBeVisible();
      const raise = page
        .locator('details')
        .filter({ has: page.locator('summary', { hasText: /^Raise sensitivity$/ }) });
      await raise.locator('summary').click();
      await raise.getByLabel('New sensitivity', { exact: true }).selectOption('restricted');
      await raise
        .locator('form')
        .getByRole('button', { name: 'Raise sensitivity', exact: true })
        .click();
      await expect(
        page
          .getByRole('region', { name: 'Source access', exact: true })
          .getByLabel('Share with', { exact: true })
          .getByRole('option', { name: `Team: ${team.name}`, exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText('Not effective at this sensitivity', { exact: false }),
      ).toBeVisible();
      await reader.goto(path);
      await expect(reader.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
      expect(await axeFindings(page)).toEqual([]);
      expect(await sidewaysOverflow(page)).toBe(0);
    } finally {
      await database.close();
    }
  });
