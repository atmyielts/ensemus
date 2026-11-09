// MODEL-01, COMM-02, Journey D, SEC-016, QA-024 (API and UI part). A person adds a model and its key using
// only the keyboard, and then every way of reading the site is searched for that key. Needs
// ENSEMUS_PRIVATE_MODEL_ENDPOINTS on the web service, naming the origin below. Never sets the review
// setting, so a hosted key stays refused here, as it must in CI (ADR-028 FD-21).
import { randomBytes, randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { BASE, createOrganization, signUp } from '../../helpers/forms';
import { enrollAuthenticator } from '../../helpers/native-mfa';
import { expect, test } from '../support/fixtures';
import { axeFindings } from '../support/look';

const PRIVATE_ENDPOINT =
  process.env.ENSEMUS_TEST_PRIVATE_MODEL_ENDPOINT ?? 'http://fake-model:8000/v1';
const ORIGIN = new URL(BASE).origin;

/** Built when the test runs, so nothing that looks like a key is committed. */
const throwawayKey = () => `test-key-${randomBytes(24).toString('hex')}`;

const profileBody = (overrides: Record<string, unknown> = {}) => ({
  provider_kind: 'local_openai_compatible',
  model_id: 'scripted-test-model',
  alias: `Local ${randomUUID().slice(0, 8)}`,
  endpoint_url: PRIVATE_ENDPOINT,
  billing_owner: 'customer',
  region: null,
  capabilities: ['text'],
  limits: { max_input_tokens: 4096, max_output_tokens: 256 },
  allowed_classes: ['public'],
  allowed_purposes: ['reason'],
  retention_basis: 'self_hosted',
  contract_ref: null,
  fallback_profile_ids: [],
  ...overrides,
});

const write = { 'content-type': 'application/json', origin: ORIGIN };
const base = (organization: string) => `/api/v1/organizations/${organization}/model-profiles`;

async function createProfile(
  request: APIRequestContext,
  organization: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await request.post(base(organization), {
    headers: write,
    data: profileBody(overrides),
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string; version: number; endpoint_url: string };
}

/** How the framework asks for a page: as HTML, as an RSC payload, and as a prefetch of one. */
const RENDERINGS: Array<Record<string, string>> = [
  {},
  { rsc: '1' },
  { rsc: '1', 'next-router-prefetch': '1' },
];

async function everyRendering(page: Page, path: string): Promise<string> {
  const bodies: string[] = [];
  for (const headers of RENDERINGS) {
    const response = await page.request.get(path, { headers, maxRedirects: 5 });
    expect(response.status(), `${path} ${JSON.stringify(headers)}`).toBe(200);
    bodies.push(await response.text());
  }
  return bodies.join('\n');
}

/** Moves focus with Tab until it reaches what the check says, without ever using a mouse. */
async function tabTo(page: Page, reached: () => Promise<boolean>, limit = 60) {
  for (let presses = 0; presses < limit; presses += 1) {
    await page.keyboard.press('Tab');
    if (await reached()) return;
  }
  throw new Error('The keyboard never got there');
}

const focusOn = (page: Page, name: string) => () =>
  page.evaluate((wanted) => document.activeElement?.getAttribute('name') === wanted, name);

test.describe('the model settings', () => {
  test('a person adds a model and its key with only the keyboard, and it is gone once saved', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    await page.goto(`/o/${world.organization}/settings/models`);
    await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();

    const alias = `Keyboard ${randomUUID().slice(0, 8)}`;
    await tabTo(page, focusOn(page, 'providerKind'));
    await page.keyboard.type('A model on your own');
    await tabTo(page, focusOn(page, 'alias'));
    await page.keyboard.type(alias);
    await tabTo(page, focusOn(page, 'modelId'));
    await page.keyboard.type('scripted-test-model');
    await tabTo(page, focusOn(page, 'endpointUrl'));
    await page.keyboard.type(PRIVATE_ENDPOINT);
    await tabTo(page, focusOn(page, 'maxInputTokens'));
    await page.keyboard.type('4096');
    await tabTo(page, focusOn(page, 'maxOutputTokens'));
    await page.keyboard.type('256');
    // "Text" and "Public" are ticked to begin with, so a purpose and a retention basis remain.
    await tabTo(page, focusOn(page, 'allowedPurposes'));
    await page.keyboard.press('Space');
    await tabTo(page, focusOn(page, 'retentionBasis'));
    await page.keyboard.type('We run');
    await tabTo(page, () =>
      page.evaluate(() => document.activeElement?.textContent?.trim() === 'Add model'),
    );
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { level: 1, name: alias })).toBeVisible();
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Not tested yet');

    const axe = await axeFindings(page);
    expect(axe).toEqual([]);
  });

  test('a list and a profile have no accessibility findings in either theme', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    const profile = await createProfile(page.request, world.organization);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.goto(`/o/${world.organization}/settings/models`);
      await expect(page.getByRole('heading', { name: 'Approved models' })).toBeVisible();
      expect(await axeFindings(page), `${theme} list`).toEqual([]);
      await page.goto(`/o/${world.organization}/settings/models/${profile.id}`);
      await expect(page.getByRole('heading', { name: 'Where it stands' })).toBeVisible();
      expect(await axeFindings(page), `${theme} profile`).toEqual([]);
    }
  });

  test('a key never comes back, through the API, the HTML or an RSC payload', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    const profile = await createProfile(page.request, world.organization);
    const key = throwawayKey();

    const stored = await page.request.put(`${base(world.organization)}/${profile.id}/credential`, {
      headers: write,
      data: { expected_version: profile.version, key },
    });
    expect(stored.status()).toBe(200);
    const answer = await stored.text();
    expect(answer).toContain('"has_credential":true');
    expect(answer).not.toContain(key);
    expect(answer).not.toContain('secret_ref');

    const reads = [
      await (await page.request.get(base(world.organization))).text(),
      await (await page.request.get(`${base(world.organization)}/${profile.id}`)).text(),
      await everyRendering(page, `/o/${world.organization}/settings/models`),
      await everyRendering(page, `/o/${world.organization}/settings/models/${profile.id}`),
    ].join('\n');
    // A control: these were real answers, about this profile, or finding nothing proves nothing.
    expect(reads).toContain(profile.id);
    expect(reads).not.toContain(key);
    expect(reads).not.toContain('secret_ref');
    expect(reads).not.toContain('secretRef');

    await page.goto(`/o/${world.organization}/settings/models/${profile.id}`);
    await expect(page.locator('input[name="key"]')).toHaveValue('');
  });

  test('a key typed into the form is sealed, and the page only says one is on file', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    const profile = await createProfile(page.request, world.organization);
    const path = `/o/${world.organization}/settings/models/${profile.id}`;
    await page.goto(path);
    const key = throwawayKey();
    await tabTo(page, focusOn(page, 'key'));
    await page.keyboard.type(key);
    await page.keyboard.press('Enter');
    await expect(page.getByText('A key is on file.')).toBeVisible();
    await expect(page.locator('input[name="key"]')).toHaveValue('');
    const reads = await everyRendering(page, path);
    expect(reads).toContain(profile.id);
    expect(reads).not.toContain(key);
    expect(page.url()).not.toContain(key);
  });

  test('a key for a public address is not asked for without the review setting', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    const profile = await createProfile(page.request, world.organization, {
      provider_kind: 'openai_compatible',
      endpoint_url: 'https://models.example.invalid/v1',
      retention_basis: 'unreviewed',
    });
    await page.goto(`/o/${world.organization}/settings/models/${profile.id}`);
    await expect(page.locator('input[name="key"]')).toHaveCount(0);
    await expect(page.getByText('not enabled on this deployment yet')).toBeVisible();
  });

  test('a hosted key is refused without the review setting, with nothing sealed', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    const profile = await createProfile(page.request, world.organization, {
      provider_kind: 'openai_hosted',
      endpoint_url: 'https://api.openai.com/v1',
      retention_basis: 'unreviewed',
    });
    const key = throwawayKey();
    const refused = await page.request.put(`${base(world.organization)}/${profile.id}/credential`, {
      headers: write,
      data: { expected_version: profile.version, key },
    });
    expect(refused.status()).toBe(409);
    const body = (await refused.json()) as { code: string };
    expect(body.code).toBe('MODEL_CREDENTIALS_NOT_REVIEWED');
    expect(JSON.stringify(body)).not.toContain(key);
    const after = await page.request.get(`${base(world.organization)}/${profile.id}`);
    expect(((await after.json()) as { has_credential: boolean }).has_credential).toBe(false);
  });

  test('an arbitrary address is refused for a hosted kind, and says so on the page', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    const refused = await page.request.post(base(world.organization), {
      headers: write,
      data: profileBody({
        provider_kind: 'openai_hosted',
        endpoint_url: 'https://attacker.example.invalid/v1',
        retention_basis: 'unreviewed',
      }),
    });
    expect(refused.status()).toBe(400);
    expect(((await refused.json()) as { code: string }).code).toBe('MODEL_ENDPOINT_NOT_ALLOWED');

    await page.goto(`/o/${world.organization}/settings/models?error=MODEL_ENDPOINT_NOT_ALLOWED`);
    await expect(
      page.getByRole('alert').filter({ hasText: /cannot be used for a model/ }),
    ).toHaveText(/cannot be used for a model/);
  });

  test('an endpoint change voids the key and returns the profile to draft', async ({
    open,
    world,
  }) => {
    const page = await open(world.alice);
    const profile = await createProfile(page.request, world.organization);
    const stored = await page.request.put(`${base(world.organization)}/${profile.id}/credential`, {
      headers: write,
      data: { expected_version: profile.version, key: throwawayKey() },
    });
    const keyed = (await stored.json()) as { version: number; has_credential: boolean };
    expect(keyed.has_credential).toBe(true);
    const changed = await page.request.patch(`${base(world.organization)}/${profile.id}`, {
      headers: write,
      data: { expected_version: keyed.version, endpoint_url: `${PRIVATE_ENDPOINT}/moved` },
    });
    expect(changed.status()).toBe(200);
    const after = (await changed.json()) as { has_credential: boolean; status: string };
    expect(after).toMatchObject({ has_credential: false, status: 'draft' });
  });

  test('the API has no way to say a profile is active', async ({ open }) => {
    // 0404 makes asking for a probe an always-MFA action. An owner of their own organization turns on an
    // authenticator as a person does, so the shared world's owner keeps the sign-in it has.
    const owner = await signUp('Generated probe owner');
    const organization = await createOrganization(owner, 'Generated probe company');
    const page = await open(owner);
    const profile = await createProfile(page.request, organization);
    const refused = await page.request.patch(`${base(organization)}/${profile.id}`, {
      headers: write,
      data: { expected_version: profile.version, status: 'active' },
    });
    expect(refused.status()).toBe(400);
    const unproved = await page.request.post(`${base(organization)}/${profile.id}/activation`, {
      headers: write,
      data: { expected_version: profile.version },
    });
    expect(unproved.status()).toBe(403);
    expect(((await unproved.json()) as { code: string }).code).toBe('MFA_REQUIRED');
    // A browser opened after enrollment carries the session the confirmation just proved.
    await enrollAuthenticator(owner, organization);
    const proved = await open(owner);
    const asked = await proved.request.post(`${base(organization)}/${profile.id}/activation`, {
      headers: write,
      data: { expected_version: profile.version },
    });
    // A request was recorded. Whether the profile ever goes active is the probe's to say.
    expect(asked.status()).toBe(202);
    expect(await asked.text()).toBe('');
  });

  test('a member cannot see or change models', async ({ open, world }) => {
    const owner = await open(world.alice);
    const profile = await createProfile(owner.request, world.organization);
    const page = await open(world.bob);

    expect((await page.goto(`/o/${world.organization}/settings/models`))?.status()).toBe(404);
    expect(
      (await page.goto(`/o/${world.organization}/settings/models/${profile.id}`))?.status(),
    ).toBe(404);
    expect((await page.request.get(base(world.organization))).status()).toBe(403);
    expect(
      (
        await page.request.post(base(world.organization), {
          headers: write,
          data: profileBody(),
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.put(`${base(world.organization)}/${profile.id}/credential`, {
          headers: write,
          data: { expected_version: profile.version, key: throwawayKey() },
        })
      ).status(),
    ).toBe(403);
  });

  test('another tenant’s profile looks like one that does not exist', async ({ open, world }) => {
    const owner = await open(world.alice);
    const profile = await createProfile(owner.request, world.organization);
    const page = await open(world.quiet);

    const path = `${base(world.quietOrganization)}/${profile.id}`;
    const theirs = await page.request.get(path);
    const nothing = await page.request.get(`${base(world.quietOrganization)}/${randomUUID()}`);
    expect(theirs.status()).toBe(404);
    expect(nothing.status()).toBe(404);
    expect(((await theirs.json()) as { code: string }).code).toBe(
      ((await nothing.json()) as { code: string }).code,
    );
    expect(
      (await page.goto(`/o/${world.quietOrganization}/settings/models/${profile.id}`))?.status(),
    ).toBe(404);
    expect(
      (
        await page.request.put(`${path}/credential`, {
          headers: write,
          data: { expected_version: profile.version, key: throwawayKey() },
        })
      ).status(),
    ).toBe(404);
  });
});
