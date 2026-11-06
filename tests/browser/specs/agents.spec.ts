// AGENT-01, AGENT-16: publishing an agent from the settings page, as a person does it. Written and
// typechecked. It has not been run yet, because it needs the built images behind the proxy.
import { createHash, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { BASE, createOrganization, join, signUp, type Person } from '../../helpers/forms';
import { expect, test } from '../support/fixtures';
import { axeFindings, sidewaysOverflow, THEMES, WIDTHS } from '../support/look';

/** What a fresh organization's report has to carry. It has no policy document of its own yet. */
const POLICY_VERSION = 'default';

function testSpec(overrides: Record<string, unknown> = {}) {
  return {
    api_version: 'ensemus.ai/v1',
    id: 'work-brief',
    version: 1,
    objective: 'Read the work and draft a short brief for its owner.',
    instructions: 'Use only what the work and its files say. Cite each claim.',
    model: {
      required_capabilities: ['text', 'tools'],
      quality_tier: 'balanced',
      fallback: 'disabled',
    },
    context: { allowed_scopes: ['work.read'], memory_write_policy: 'none' },
    tools: { allow: ['work.read', 'artifact.read_text'], deny: [] },
    execution: {
      max_model_turns: 5,
      max_tool_calls: 5,
      max_total_tokens: 10_000,
      max_cost_usd: '1',
      timeout_seconds: 60,
      max_delegation_depth: 0,
    },
    output: { schema_ref: 'schemas/work-brief.schema.json', verification: ['schema_check'] },
    evaluation: { suite_ref: 'evaluations/agents/work-brief', min_pass_rate: 0.9 },
    ...overrides,
  };
}

/**
 * The same rule as canonicalJson in @ensemus/domain/approval, written out because this package tests the
 * product from outside. If the two ever differ, the good publish below fails and says so.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(',')}}`;
}

const specHash = (spec: unknown) => createHash('sha256').update(canonical(spec)).digest('hex');

function reportFor(spec: unknown, overrides: Record<string, unknown> = {}) {
  return {
    report_version: 1,
    spec_sha256: specHash(spec),
    policy_version: POLICY_VERSION,
    suite_ref: 'evaluations/agents/work-brief',
    dataset_version: 'synthetic-1',
    model_label: 'scripted',
    pass_rate: 1,
    cases: 3,
    passed: true,
    scripted_model: true,
    ...overrides,
  };
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const agentsPath = (organization: string) => `/o/${organization}/settings/agents`;
const apiPath = (organization: string) => `/api/v1/organizations/${organization}/agent-versions`;

/** A class and not the alert role: Next.js keeps an alert of its own on every page, for navigation. */
const refusal = (page: Page) => page.locator('p.notice.error');

async function team() {
  const owner = await signUp('Dana Owner');
  const organization = await createOrganization(owner, `Agents ${randomUUID()}`);
  const member = await join(owner, organization, 'Evan Member');
  return { owner, member, organization };
}

async function fillAndPublish(page: Page, spec: unknown, report: unknown) {
  await page.getByLabel('Agent manifest').fill(pretty(spec));
  await page.getByLabel('Evaluation report').fill(pretty(report));
  await page.getByRole('button', { name: 'Publish this version' }).click();
}

test.describe('publishing an agent', () => {
  test('shows the empty list, then the version, marked as the one new runs use', async ({
    open,
  }) => {
    const { owner, organization } = await team();
    const page = await open(owner);
    await page.goto(agentsPath(organization));
    await expect(page.getByText('No agent has been published yet.')).toBeVisible();

    const spec = testSpec();
    await fillAndPublish(page, spec, reportFor(spec));

    await expect(
      page.getByRole('status').filter({ hasText: 'Version 1 is published' }),
    ).toBeVisible();
    const row = page.getByRole('listitem').filter({ hasText: 'work-brief, version 1' });
    await expect(row).toBeVisible();
    await expect(row.getByText('Used for new runs')).toBeVisible();
    await expect(row).toContainText(specHash(spec));
  });

  test('moves the mark when a newer version is published', async ({ open }) => {
    const { owner, organization } = await team();
    const page = await open(owner);
    await page.goto(agentsPath(organization));
    const first = testSpec();
    await fillAndPublish(page, first, reportFor(first));
    await expect(page.getByRole('status').filter({ hasText: 'Version 1' })).toBeVisible();

    const second = testSpec({ version: 2 });
    await fillAndPublish(page, second, reportFor(second));
    await expect(page.getByRole('status').filter({ hasText: 'Version 2' })).toBeVisible();

    const older = page.getByRole('listitem').filter({ hasText: 'work-brief, version 1' });
    const newer = page.getByRole('listitem').filter({ hasText: 'work-brief, version 2' });
    await expect(newer.getByText('Used for new runs')).toBeVisible();
    await expect(older.getByText('Used for new runs')).toHaveCount(0);
  });

  test('works with the keyboard alone', async ({ open }) => {
    const { owner, organization } = await team();
    const page = await open(owner);
    await page.goto(agentsPath(organization));
    const spec = testSpec();

    await page.getByLabel('Agent manifest').focus();
    await page.keyboard.insertText(pretty(spec));
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Evaluation report')).toBeFocused();
    await page.keyboard.insertText(pretty(reportFor(spec)));
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Publish this version' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('status').filter({ hasText: 'Version 1' })).toBeVisible();
  });

  test('works without JavaScript', async ({ open }) => {
    const { owner, organization } = await team();
    const page = await open(owner, { javaScriptEnabled: false });
    await page.goto(agentsPath(organization));
    const spec = testSpec();
    await fillAndPublish(page, spec, reportFor(spec));
    await expect(
      page.getByRole('listitem').filter({ hasText: 'work-brief, version 1' }),
    ).toBeVisible();
  });
});

test.describe('what publishing refuses', () => {
  test('secrets.*: says why, keeps what was typed, publishes nothing', async ({ open }) => {
    const { owner, organization } = await team();
    const page = await open(owner);
    await page.goto(agentsPath(organization));
    const spec = testSpec({ tools: { allow: ['secrets.read'] } });
    await fillAndPublish(page, spec, reportFor(spec));

    await expect(refusal(page)).toHaveText('This agent definition is not valid.');
    await expect(
      page.getByText('It allows a tool no agent may have', { exact: false }),
    ).toBeVisible();
    await expect(page.getByLabel('Agent manifest')).toHaveValue(pretty(spec));
    await expect(page.getByText('No agent has been published yet.')).toBeVisible();
  });

  test('a report for another spec', async ({ open }) => {
    const { owner, organization } = await team();
    const page = await open(owner);
    await page.goto(agentsPath(organization));
    const report = reportFor(testSpec({ version: 2 }));
    await fillAndPublish(page, testSpec(), report);

    await expect(refusal(page)).toContainText('needs a passing evaluation');
    await expect(page.getByLabel('Evaluation report')).toHaveValue(pretty(report));
    await expect(page.getByText('No agent has been published yet.')).toBeVisible();
  });

  test('text that is not JSON', async ({ open }) => {
    const { owner, organization } = await team();
    const page = await open(owner);
    await page.goto(agentsPath(organization));
    await fillAndPublish(page, testSpec(), reportFor(testSpec()));
    await expect(page.getByRole('status').filter({ hasText: 'Version 1' })).toBeVisible();
    await page.getByLabel('Agent manifest').fill('not json');
    await page.getByLabel('Evaluation report').fill('not json either');
    await page.getByRole('button', { name: 'Publish this version' }).click();
    await expect(refusal(page)).toHaveText('This agent definition is not valid.');
    await expect(page.getByLabel('Agent manifest')).toHaveValue('not json');
  });
});

test.describe('who can reach this', () => {
  const apiPublish = (page: Page, organization: string, spec: unknown, report: unknown) =>
    page.request.post(apiPath(organization), {
      headers: { origin: new URL(BASE).origin, 'content-type': 'application/json' },
      data: { spec, evaluation_report: report },
    });

  test('a member sees neither the form nor the list, and cannot post past the page', async ({
    open,
  }) => {
    const { owner, member, organization } = await team();
    const ownerPage = await open(owner);
    await ownerPage.goto(agentsPath(organization));
    const spec = testSpec();
    await fillAndPublish(ownerPage, spec, reportFor(spec));
    await expect(ownerPage.getByRole('status').filter({ hasText: 'Version 1' })).toBeVisible();

    const page = await open(member);
    await page.goto(agentsPath(organization));
    await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
    await expect(page.getByText('Owners and admins manage agents here.')).toBeVisible();
    await expect(page.getByLabel('Agent manifest')).toHaveCount(0);
    await expect(page.getByText('work-brief')).toHaveCount(0);

    const next = testSpec({ version: 2 });
    const refused = await apiPublish(page, organization, next, reportFor(next));
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('FORBIDDEN');
    expect((await page.request.get(apiPath(organization))).status()).toBe(403);
  });

  test('someone from another organization finds nothing at all', async ({ open }) => {
    const { owner, organization } = await team();
    const outsider: Person = await signUp('Fay Outsider');
    await createOrganization(outsider, `Elsewhere ${randomUUID()}`);

    const ownerPage = await open(owner);
    const spec = testSpec();
    const published = await apiPublish(ownerPage, organization, spec, reportFor(spec));
    expect(published.status()).toBe(201);
    const { id } = (await published.json()) as { id: string };

    const page = await open(outsider);
    expect((await page.goto(agentsPath(organization)))?.status()).toBe(404);
    expect((await page.request.get(`${apiPath(organization)}/${id}`)).status()).toBe(404);
  });

  test('the API says which rules a spec broke, in codes and field names only', async ({ open }) => {
    const { owner, organization } = await team();
    const page = await open(owner);
    const marker = 'CANARY-NOT-ECHOED';
    const spec = testSpec({ tools: { allow: ['secrets.read'] }, instructions: marker });
    const refused = await apiPublish(page, organization, spec, reportFor(spec));
    expect(refused.status()).toBe(400);
    const text = await refused.text();
    expect(text).not.toContain(marker);
    expect(JSON.parse(text)).toMatchObject({
      code: 'AGENT_SPEC_INVALID',
      details: { lint_codes: ['FORBIDDEN_TOOL'] },
    });
  });
});

test.describe('how it reads', () => {
  test('has no accessibility findings or sideways scroll, empty and refused', async ({ open }) => {
    const { owner, organization } = await team();
    const page = await open(owner);
    await page.goto(agentsPath(organization));

    const problems: Record<string, unknown> = {};
    const scan = async (state: string) => {
      for (const theme of THEMES) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
          const findings = await axeFindings(page);
          if (findings.length) problems[`${state}-${theme}-${width}`] = findings;
          const overflow = await sidewaysOverflow(page);
          if (overflow > 0) problems[`${state}-${theme}-${width} overflow`] = overflow;
        }
      }
    };

    await scan('empty');
    const bad = testSpec({ tools: { allow: ['secrets.read'] } });
    await fillAndPublish(page, bad, reportFor(bad));
    await expect(refusal(page)).toBeVisible();
    await scan('refused');
    const good = testSpec();
    await fillAndPublish(page, good, reportFor(good));
    await expect(page.getByRole('status').filter({ hasText: 'Version 1' })).toBeVisible();
    await scan('published');
    expect(problems).toEqual({});
  });
});
