import { expect, test } from '../support/fixtures';
import { alertIn } from '../support/notices';
test('owner can request and cancel offboarding without JavaScript when the real halt binding is configured', async ({
  open,
  world,
}) => {
  const page = await open(world.alice, { javaScriptEnabled: false });
  await page.goto(`/o/${world.organization}/account/leave`);
  const help = await page.locator('#leave-name-help').textContent();
  const name = /^Type (.+) exactly to confirm\.$/.exec(help ?? '')?.[1];
  expect(name).toBeTruthy();
  await page.getByLabel('Organization name', { exact: true }).fill(name!);
  await page.getByLabel('I understand that new work will stop', { exact: false }).check();
  await page.getByRole('button', { name: 'Request offboarding', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /Request recorded|Export offered|Contractual transition/ }),
  ).toBeVisible();
  // The offboarding workflow moves a request on by itself, and every move is a new version. With no
  // transition date recorded from an agreement it offers the export and then waits for an operator
  // (advanceOffboarding's wait_for_transition with no wake time), so the version stops changing.
  // The page is server rendered: load it again until it shows a state the workflow moved it to and
  // the same version twice running. The one cancel below is then sent against the version the
  // workflow has finished with, so a version conflict is a real failure, never something to retry.
  const status = page.locator('#leaving-status'),
    version = page.locator('input[type="hidden"][name="version"]');
  let seen: string | null = null;
  await expect
    .poll(
      async () => {
        await page.reload();
        const state = (await status.textContent())?.trim();
        const current = (await version.count()) === 1 ? await version.inputValue() : null;
        const settled =
          (state === 'Export offered' || state === 'Contractual transition') &&
          current !== null &&
          current === seen;
        seen = current;
        return settled;
      },
      {
        message: 'the offboarding workflow reaches the state it moves a request to by itself',
        timeout: 60_000,
        intervals: [2_000],
      },
    )
    .toBe(true);
  await page.getByText('Cancel offboarding', { exact: true }).first().click();
  const reason = page.getByRole('combobox', { name: 'Reason for cancelling', exact: true });
  await expect(reason).toHaveValue('');
  await reason.selectOption({ label: 'Our organization has decided to stay' });
  await page.getByLabel('I want this organization to stay.', { exact: false }).check();
  await page.getByRole('button', { name: 'Cancel offboarding', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Request offboarding', exact: true }),
  ).toBeVisible();
  await expect(alertIn(page).filter({ hasText: 'Someone else changed this first' })).toHaveCount(0);
});
test('a member cannot discover the owner leaving controls', async ({ open, world }) => {
  const page = await open(world.bob);
  expect((await page.goto(`/o/${world.organization}/account/leave`))?.status()).toBe(404);
});
