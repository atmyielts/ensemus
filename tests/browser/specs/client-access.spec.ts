import { randomUUID } from 'node:crypto';
import { submit } from '../../helpers/forms';
import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow } from '../support/look';

test('named client access works without JavaScript and revokes on the next read', async ({
  open,
  world,
}) => {
  const base = `/o/${world.organization}/clients`,
    name = 'Generated private client ' + randomUUID();
  const created = await submit(base, world.alice.jar, /name="displayName"/, {
    displayName: name,
    classification: 'restricted',
    requestKey: randomUUID(),
  });
  expect(created.headers.get('location')).not.toContain('error=');
  const owner = await open(world.alice, {
    javaScriptEnabled: false,
    width: 320,
    colorScheme: 'dark',
  });
  await owner.goto(base);
  const row = owner.getByRole('listitem').filter({ hasText: name });
  await row.getByRole('link', { name: 'Manage access' }).click();
  await expect(owner.getByRole('heading', { name: 'Client access', exact: true })).toBeVisible();
  const accessPath = new URL(owner.url()).pathname;
  const reader = await open(world.bob, { javaScriptEnabled: false });
  await reader.goto(base);
  await expect(reader.getByText(name, { exact: true })).toHaveCount(0);
  expect((await reader.goto(accessPath))?.status()).toBe(404);
  await owner.getByRole('checkbox', { name: 'Bob Okafor' }).check();
  await owner.getByRole('button', { name: 'Save access' }).click();
  await expect(owner.getByRole('checkbox', { name: 'Bob Okafor' })).toBeChecked();
  expect(await sidewaysOverflow(owner)).toBe(0);
  expect(await axeFindings(owner)).toEqual([]);
  await reader.goto(base);
  await expect(reader.getByText(name, { exact: true })).toBeVisible();
  expect((await reader.goto(accessPath))?.status()).toBe(404);
  await owner.getByRole('checkbox', { name: 'Bob Okafor' }).uncheck();
  await owner.getByRole('button', { name: 'Save access' }).click();
  await reader.goto(base);
  await expect(reader.getByText(name, { exact: true })).toHaveCount(0);
});
