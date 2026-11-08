import { randomUUID } from 'node:crypto';
import { expect, test } from '../support/fixtures';

test('retention rules and legal holds work without JavaScript', async ({ open, world }) => {
  const page = await open(world.alice, { javaScriptEnabled: false });
  await page.goto(`/o/${world.organization}/account`);
  await page.getByRole('link',{name:'Data retention',exact:true}).click();
  await expect(page.getByRole('heading', { name: 'Data retention', exact: true })).toBeVisible();
  await page.getByLabel('Sign-off reference').fill(randomUUID());
  await page.getByRole('button', { name: 'Save retention rule' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Retention rule saved.' })).toBeVisible();
  await page.getByRole('link',{name:'Account',exact:true}).click();
  await page.getByRole('link',{name:'Legal holds',exact:true}).click();
  await page.getByLabel('Matter reference').fill(randomUUID());
  await page.getByLabel('Records to preserve').selectOption('organization:');
  await page.getByRole('button', { name: 'Place legal hold' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Legal hold placed.' })).toBeVisible();
  await page.getByText('Release this hold', { exact: true }).click();
  await expect(page.getByLabel('Reason for releasing this hold',{exact:true})).toHaveValue('');
  await page.getByLabel('Reason for releasing this hold',{exact:true}).selectOption({label:'Our organization requests release of this hold'});
  await page.getByLabel('I confirm that this hold can be released.', { exact: false }).check();
  await page.getByRole('button', { name: 'Release hold', exact: true }).click();
  await expect(page.getByText('Released', { exact: true })).toBeVisible();
});
test('members cannot discover retention or legal-hold administration', async ({ open, world }) => {
  const page = await open(world.bob);
  await page.goto(`/o/${world.organization}/account`);
  for(const name of ['Data retention','Legal holds'])await expect(page.getByRole('link',{name,exact:true})).toHaveCount(0);
  for (const path of ['retention', 'legal-holds'])
    expect((await page.goto(`/o/${world.organization}/account/${path}`))?.status()).toBe(404);
});

test('administrators can discover retention but not owner-only legal holds',async({open,world})=>{
  const page=await open(world.carol,{javaScriptEnabled:false});
  await page.goto(`/o/${world.organization}/account`);
  await expect(page.getByRole('link',{name:'Legal holds',exact:true})).toHaveCount(0);
  await page.getByRole('link',{name:'Data retention',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Data retention',exact:true})).toBeVisible();
  expect((await page.goto(`/o/${world.organization}/account/legal-holds`))?.status()).toBe(404);
});
