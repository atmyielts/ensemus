// Authored against actual Studio HTTP and native actions; no browser run is claimed here.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ProcessGraphBody } from '@ensemus/contracts/studio';
import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow } from '../support/look';
import { BASE } from '../../helpers/forms';

const origin = new URL(BASE).origin;
const fork = (): ProcessGraphBody => ({
  schemaVersion: 1,
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', x: 0, y: 0 },
    { id: 'left', kind: 'work_item', label: 'Gather the evidence', x: 0, y: 0 },
    { id: 'right', kind: 'work_item', label: 'Check the request', x: 0, y: 0 },
    {
      id: 'join',
      kind: 'human_approval',
      approverRole: 'process_owner',
      label: 'Review both results',
      x: 0,
      y: 0,
    },
    { id: 'end', kind: 'end', label: 'Finish', x: 0, y: 0 },
  ],
  edges: [
    { from: 'start', to: 'left' },
    { from: 'start', to: 'right' },
    { from: 'left', to: 'join' },
    { from: 'right', to: 'join' },
    { from: 'join', to: 'end' },
  ],
});
async function saved(page: Page, organization: string, orphan = false) {
  const url = `/api/v1/organizations/${organization}/studio/process-drafts`,
    created = await page.request.post(url, {
      headers: { origin, 'idempotency-key': randomUUID() },
      data: {
        name: `Generated parallel workflow ${randomUUID().slice(0, 8)}`,
        classification: 'internal',
      },
    });
  expect(created.status()).toBe(201);
  const row = await created.json(),
    graph = fork();
  if (orphan) graph.edges.push({ from: 'gone', to: 'also_gone' });
  const patched = await page.request.patch(`${url}/${row.id}`, {
    headers: { origin, 'if-match': created.headers().etag ?? '' },
    data: { graph },
  });
  expect(patched.status()).toBe(200);
  const draft = await patched.json();
  return {
    id: String(draft.id),
    version: Number(draft.version),
    etag: patched.headers().etag ?? '',
    graph,
    path: `/o/${organization}/studio/workflows/${draft.id}/edit`,
    url: `${url}/${draft.id}`,
  };
}
const point = (page: Page, index: number) =>
  page.locator(`summary#workflow-point-${index}`).locator('..');
const openList = async (page: Page) => {
  await page.getByRole('link', { name: 'Browse as a point list', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Workflow map point list', exact: true }),
  ).toBeVisible();
};

test.describe('saved visual workflow map and native editing', () => {
  for (const javaScriptEnabled of [true, false])
    test(`shows every fork/join and reaches the real forms (${javaScriptEnabled ? 'JavaScript' : 'no JavaScript'})`, async ({
      open,
      world,
    }) => {
      const page = await open(world.alice, { javaScriptEnabled, width: 390 }),
        draft = await saved(page, world.organization);
      await page.goto(draft.path);
      const map = page.getByRole('region', { name: 'Scrollable workflow map', exact: true });
      await expect(map.locator('[data-workflow-point]')).toHaveCount(5);
      await expect(map.locator('[data-workflow-edge]')).toHaveCount(5);
      await expect(map).toContainText('Continues along every path');
      await expect(map).toContainText('Waits for all earlier points');
      const link = map.getByRole('link', { name: /^Edit Point 2: Gather the evidence/ });
      await link.focus();
      await expect(link).toBeFocused();
      await link.press('Enter');
      if (!(await point(page, 2).getByLabel('Point name', { exact: true }).isVisible()))
        await point(page, 2).locator('summary').first().click();
      await point(page, 2)
        .getByLabel('Point name', { exact: true })
        .fill('Pending text survives selecting another point');
      await map.getByRole('link', { name: /^Edit Point 3: Check the request/ }).click();
      if (!(await point(page, 3).getByLabel('Point name', { exact: true }).isVisible()))
        await point(page, 3).locator('summary').first().click();
      await expect(point(page, 3).getByLabel('Point name', { exact: true })).toBeVisible();
      await expect(point(page, 2).getByLabel('Point name', { exact: true })).toHaveValue(
        'Pending text survives selecting another point',
      );
      await openList(page);
      await expect(
        page
          .getByRole('list', { name: 'Every saved workflow connection', exact: true })
          .locator(':scope > li'),
      ).toHaveCount(5);
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
      if (javaScriptEnabled) expect(await axeFindings(page)).toEqual([]);
    });
  test('removes only an orphan and preserves other pending values through a subsequent actual save', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice),
      draft = await saved(page, world.organization, true);
    await page.goto(draft.path);
    await page
      .getByRole('region', { name: 'Scrollable workflow map', exact: true })
      .getByRole('link', { name: /^Edit Point 2:/ })
      .click();
    await point(page, 2)
      .getByLabel('Point name', { exact: true })
      .fill('My pending evidence request');
    await page.getByLabel('Workflow name', { exact: true }).fill('Also kept, not submitted');
    await openList(page);
    const repair = page.getByRole('form', { name: 'Remove this orphan connection', exact: true });
    await repair.getByRole('checkbox').check();
    await repair.getByRole('button', { name: 'Remove this connection', exact: true }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'The connection was removed. Your other form entries are still here.' }),
    ).toBeVisible();
    await expect(point(page, 2).getByLabel('Point name', { exact: true })).toHaveValue(
      'My pending evidence request',
    );
    await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue(
      'Also kept, not submitted',
    );
    const repaired = await page.request.get(draft.url);
    expect(repaired.status()).toBe(200);
    const body = await repaired.json();
    expect(body.graph).toEqual(fork());
    expect(body.version).toBe(draft.version + 1);
    await point(page, 2).getByRole('button', { name: 'Save this point', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'The change was saved' }),
    ).toBeVisible();
    const updated = await page.request.get(draft.url);
    expect(updated.status()).toBe(200);
    const current = await updated.json();
    expect(current.graph.nodes.find((node: { id: string }) => node.id === 'left').label).toBe(
      'My pending evidence request',
    );
    await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue(
      'Also kept, not submitted',
    );
  });
  test('a concurrent saved revision refuses orphan removal and keeps typed fields until explicit reload', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice),
      draft = await saved(page, world.organization, true);
    await page.goto(draft.path);
    await page.getByLabel('Workflow name', { exact: true }).fill('My unsaved alternative');
    const changed = await page.request.patch(draft.url, {
      headers: { origin, 'if-match': draft.etag },
      data: { name: 'Saved in another tab' },
    });
    expect(changed.status()).toBe(200);
    await openList(page);
    const repair = page.getByRole('form', { name: 'Remove this orphan connection', exact: true });
    await repair.getByRole('checkbox').check();
    await repair.getByRole('button', { name: 'Remove this connection', exact: true }).click();
    await expect(repair.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue(
      'My unsaved alternative',
    );
    const current = await page.request.get(draft.url);
    expect(current.status()).toBe(200);
    expect((await current.json()).graph).toEqual(draft.graph);
    await repair.getByText('Review the latest saved values', { exact: true }).click();
    await repair
      .getByRole('button', { name: 'Discard kept entries and reload saved workflow', exact: true })
      .click();
    await expect(page.getByLabel('Workflow name', { exact: true })).toHaveValue(
      'Saved in another tab',
    );
  });
  test('orphan repair also uses an explicit native confirmation with JavaScript disabled', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice, { javaScriptEnabled: false }),
      draft = await saved(page, world.organization, true);
    await page.goto(draft.path);
    await openList(page);
    const repair = page.getByRole('form', { name: 'Remove this orphan connection', exact: true });
    await repair.getByRole('checkbox').check();
    await repair.getByRole('button', { name: 'Remove this connection', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'The connection removal was recorded.' }),
    ).toBeVisible();
    const response = await page.request.get(draft.url);
    expect(response.status()).toBe(200);
    expect((await response.json()).graph).toEqual(fork());
  });
  test('keeps a saved unavailable approval selection instead of falling back to another person rule', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice),
      draft = await saved(page, world.organization),
      graph = fork();
    graph.nodes = graph.nodes.map((node) =>
      node.id === 'join' ? { ...node, approverRole: 'starter_manager' } : node,
    );
    const result = await page.request.patch(draft.url, {
      headers: { origin, 'if-match': draft.etag },
      data: { graph },
    });
    expect(result.status()).toBe(200);
    await page.goto(draft.path);
    await page
      .getByRole('region', { name: 'Scrollable workflow map', exact: true })
      .getByRole('link', { name: /^Edit Point 4:/ })
      .click();
    await expect(
      point(page, 4).getByLabel('For an approval point: who may decide?', { exact: true }),
    ).toHaveValue('starter_manager');
    await expect(
      point(page, 4)
        .getByLabel('For an approval point: who may decide?', { exact: true })
        .locator('option:checked'),
    ).toHaveText('Saved manager selection — unavailable here');
  });
  test('keeps the map contained and the point alternative accessible in narrow/wide and dark layouts', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice, { width: 320, colorScheme: 'dark' }),
      draft = await saved(page, world.organization);
    await page.goto(draft.path);
    await openList(page);
    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(1);
      await expect(
        page.getByRole('region', { name: 'Scrollable workflow map', exact: true }),
      ).toBeVisible();
    }
    expect(await axeFindings(page)).toEqual([]);
  });
});
