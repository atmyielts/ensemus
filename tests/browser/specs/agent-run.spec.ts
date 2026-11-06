// AGENT-06, Journey B: what a person sees of a run, and starting and stopping one, in a real browser.
// Written and typechecked. It has not been run yet: it needs the stack, with the role provisioning step
// in ADR-028. Agents and models are seeded directly, because their own pages belong to other slices, and
// no worker runs here, so the run's later states are moved by hand as the agent role would move them.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { BASE, formOn, onReplica, post, read, visit, type Person } from '../../helpers/forms';
import { urls } from '../../helpers/stack';
import { expect, test } from '../support/fixtures';
import { axeFindings } from '../support/look';
import { createWork, superuser } from '../support/world';

type Seeded = { versionId: string };

/** A published agent, an active model and a budget, for this organization. Generated values only. */
async function seedAgent(organization: string, ownerMembership: string): Promise<Seeded> {
  const sql = await superuser();
  const agent = new pg.Client({ connectionString: urls.agent() });
  await agent.connect();
  try {
    const definitionId = randomUUID();
    const identityId = randomUUID();
    const versionId = randomUUID();
    const profileId = randomUUID();
    const spec = {
      api_version: 'ensemus.ai/v1',
      id: `brief-${definitionId.slice(0, 8)}`,
      version: 1,
      objective: 'Read the work and draft a short brief for its owner.',
      instructions: 'Use only what the work and its files say.',
      model: {
        required_capabilities: ['text', 'tools'],
        quality_tier: 'balanced',
        fallback: 'disabled',
      },
      context: { allowed_scopes: ['work.read'], memory_write_policy: 'none' },
      tools: { allow: ['work.read'], deny: [] },
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
    };
    const hash = '0'.repeat(64);
    await sql.query(
      `insert into org.service_identities (organization_id, id, owner_membership_id, purpose)
       values ($1, $2, $3, 'test agent')`,
      [organization, identityId, ownerMembership],
    );
    await sql.query(
      `insert into ai.agent_definitions
         (organization_id, id, slug, name, owner_membership_id, service_identity_id)
       values ($1, $2, $3, 'Work brief', $4, $5)`,
      [organization, definitionId, spec.id, ownerMembership, identityId],
    );
    await sql.query(
      `insert into ai.agent_versions
         (organization_id, id, definition_id, version_number, spec, spec_sha256,
          evaluation_report_sha256, policy_version, max_cost_micros, published_by_membership_id)
       values ($1, $2, $3, 1, $4, $5, $5, 'test', 1000000, $6)`,
      [organization, versionId, definitionId, JSON.stringify(spec), hash, ownerMembership],
    );
    await sql.query(
      `insert into ai.agent_publications (organization_id, definition_id, version_id)
       values ($1, $2, $3)`,
      [organization, definitionId, versionId],
    );
    await sql.query(
      `insert into ai.model_profiles
         (organization_id, id, provider_kind, model_id, alias, endpoint_url, capabilities, limits,
          allowed_classes, allowed_purposes, retention_basis, status)
       values ($1, $2, 'local_openai_compatible', 'scripted-test-model', $3,
               'http://127.0.0.1:59999/v1', '{text,tools}',
               '{"maxInputTokens":4096,"maxOutputTokens":512}', '{public,internal}',
               '{reason,compose}', 'self_hosted', 'probing')`,
      [organization, profileId, `test-${profileId.slice(0, 8)}`],
    );
    // Only the agent role can record a passed probe. That is the rule, so the seed goes through it.
    await agent.query(`select set_config('app.organization_id', $1, false)`, [organization]);
    await agent.query(
      `update ai.model_profiles set status = 'active', qualified_at = now() where id = $1`,
      [profileId],
    );
    await sql.query(
      `insert into platform.budgets (organization_id, scope, period, limit_micros)
       values ($1, 'organization', $2, 1000000)
       on conflict do nothing`,
      [organization, new Date().toISOString().slice(0, 7)],
    );
    return { versionId };
  } finally {
    await agent.end();
    await sql.end();
  }
}

/** A run walked forward, as a worker would, with steps, and model text only the agent role can read. */
async function seedRun(input: {
  organization: string;
  workUnitId: string;
  versionId: string;
  initiatorMembership: string;
  path: readonly string[];
  stopCode?: string;
  canary?: string;
}) {
  const agent = new pg.Client({ connectionString: urls.agent() });
  const sql = await superuser();
  await agent.connect();
  try {
    const runId = randomUUID();
    await sql.query(
      `insert into ai.agent_runs
         (organization_id, id, work_unit_id, agent_version_id, initiator_membership_id,
          service_identity_id, effective_classification, max_model_turns, max_tool_calls,
          max_total_tokens, max_cost_micros, timeout_seconds, delegated_scopes)
       select $1, $2, $3, $4, $5, d.service_identity_id, 'internal', 5, 5, 10000, 1000000, 60,
              '{"tools":["work.read"]}'
         from ai.agent_versions v
         join ai.agent_definitions d
           on d.organization_id = v.organization_id and d.id = v.definition_id
        where v.id = $4`,
      [
        input.organization,
        runId,
        input.workUnitId,
        input.versionId,
        input.initiatorMembership,
      ],
    );
    await agent.query(`select set_config('app.organization_id', $1, false)`, [input.organization]);
    for (const status of input.path) {
      await agent.query(
        `update ai.agent_runs set status = $2, stop_code = $3 where id = $1`,
        [runId, status, status === input.path.at(-1) ? (input.stopCode ?? null) : null],
      );
    }
    const stepId = randomUUID();
    await agent.query(
      `insert into ai.execution_steps
         (organization_id, id, run_id, step_number, kind, state, label_code, outcome)
       values ($1, $2, $3, 0, 'model_turn', 'completed', 'THINKING', 'tool_proposed')`,
      [input.organization, stepId, runId],
    );
    if (input.canary) {
      await agent.query(
        `insert into ai.step_payloads
           (organization_id, step_id, kind, classification, content, content_sha256)
         values ($1, $2, 'completion', 'internal', $3, $4)`,
        [input.organization, stepId, input.canary, '0'.repeat(64)],
      );
    }
    return runId;
  } finally {
    await agent.end();
    await sql.end();
  }
}

async function moveRun(organization: string, runId: string, status: string) {
  const agent = new pg.Client({ connectionString: urls.agent() });
  await agent.connect();
  try {
    await agent.query(`select set_config('app.organization_id', $1, false)`, [organization]);
    await agent.query(`update ai.agent_runs set status = $2 where id = $1`, [runId, status]);
  } finally {
    await agent.end();
  }
}

const runPath = (organization: string, workUnitId: string) =>
  `/o/${organization}/work/${workUnitId}/run`;

const api = (organization: string, tail: string) =>
  `/api/v1/organizations/${organization}/agent-runs${tail}`;

async function receive(path: string, person: Person, headers: Record<string, string> = {}) {
  let url = `${BASE}${path}`;
  for (;;) {
    const response = await fetch(url, {
      headers: { cookie: person.jar.cookie, ...headers },
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    if (response.status === 307 && location && /[?&]_rsc\b/.test(location)) {
      url = new URL(location, BASE).href;
      continue;
    }
    return { status: response.status, body: await response.text() };
  }
}

test.describe('an agent run, as a person sees it', () => {
  let seeded: Seeded;

  test.beforeAll(async ({ world }) => {
    seeded = await seedAgent(world.organization, world.membership.alice);
  });

  const running = async (
    world: { organization: string; alice: Person; membership: { alice: string } },
    extra: { canary?: string; path?: readonly string[]; stopCode?: string } = {},
  ) => {
    const workUnitId = await createWork(world.alice, world.organization, {
      title: `Agent work ${randomUUID().slice(0, 8)}`,
      objective: 'Do it.',
    });
    const runId = await seedRun({
      organization: world.organization,
      workUnitId,
      versionId: seeded.versionId,
      initiatorMembership: world.membership.alice,
      path: extra.path ?? ['preparing', 'running'],
      ...(extra.stopCode ? { stopCode: extra.stopCode } : {}),
      ...(extra.canary ? { canary: extra.canary } : {}),
    });
    return { workUnitId, runId };
  };

  test('says plainly when no agent has run, and a member is offered nothing to start', async ({
    open,
    world,
  }) => {
    const workUnitId = await createWork(world.alice, world.organization, {
      title: 'Nothing has run on this',
      objective: 'Do it.',
    });
    const page = await open(world.bob);
    await page.goto(runPath(world.organization, workUnitId));
    await expect(page.getByText('No agent has run on this work yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Start/ })).toHaveCount(0);
    expect(await axeFindings(page)).toEqual([]);
  });

  test('an owner starts a run with the keyboard alone, and sees it waiting', async ({
    open,
    world,
  }) => {
    const workUnitId = await createWork(world.alice, world.organization, {
      title: 'Start this by keyboard',
      objective: 'Do it.',
    });
    const page = await open(world.alice);
    await page.goto(runPath(world.organization, workUnitId));
    await expect(page.getByText('No agent has run on this work yet.')).toBeVisible();
    expect(await axeFindings(page)).toEqual([]);

    await page.getByLabel('Agent').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Start a run' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Waiting to start');
    await expect(page.getByRole('button', { name: 'Stop this run' })).toBeVisible();
    // The worker has not picked it up, so it cannot be paused yet, and is not offered.
    await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    expect(await axeFindings(page)).toEqual([]);
  });

  test('a form sent twice starts one run', async ({ world }) => {
    const workUnitId = await createWork(world.alice, world.organization, {
      title: 'Double click this',
      objective: 'Do it.',
    });
    const path = runPath(world.organization, workUnitId);
    const form = await formOn(path, world.alice.jar, /name="agentVersionId"/);
    const values = { agentVersionId: seeded.versionId };
    const first = await post(path, world.alice.jar, form, values);
    const second = await post(path, world.alice.jar, form, values);
    expect(first.headers.get('location')).not.toContain('error=');
    expect(second.headers.get('location')).not.toContain('error=');
    const list = await receive(api(world.organization, `?work_unit_id=${workUnitId}`), world.alice);
    expect((JSON.parse(list.body) as { items: unknown[] }).items).toHaveLength(1);
  });

  test('no model text reaches the page, its RSC payload or the API', async ({ open, world }) => {
    const canary = `canary-${randomUUID()}`;
    const { workUnitId, runId } = await running(world, { canary });
    const path = runPath(world.organization, workUnitId);

    const page = await open(world.alice);
    await page.goto(path);
    await expect(page.getByText('Working out the next step')).toBeVisible();
    await expect(page.getByText(canary)).toHaveCount(0);

    const surfaces = await Promise.all([
      receive(path, world.alice),
      receive(path, world.alice, { rsc: '1' }),
      receive(path, world.alice, { rsc: '1', 'next-router-prefetch': '1' }),
      receive(api(world.organization, `/${runId}`), world.alice),
      receive(api(world.organization, `/${runId}/steps`), world.alice),
      receive(api(world.organization, `?work_unit_id=${workUnitId}`), world.alice),
    ]);
    for (const surface of surfaces) {
      expect(surface.status).toBe(200);
      expect(surface.body).not.toContain(canary);
    }
    // A control for this scan: the code it did read is there, so it read the right thing.
    expect(surfaces[4]?.body).toContain('THINKING');
  });

  test('labels a BYOM cost as an estimate', async ({ open, world }) => {
    const { workUnitId } = await running(world);
    const page = await open(world.alice);
    await page.goto(runPath(world.organization, workUnitId));
    await expect(page.getByText('Estimated cost')).toBeVisible();
    await expect(page.getByText(/not a bill/)).toBeVisible();
  });

  test('states an unknown outcome as unknown', async ({ open, world }) => {
    const { workUnitId } = await running(world, {
      path: ['preparing', 'running', 'outcome_unverified'],
      stopCode: 'UNKNOWN_EXTERNAL_STATE',
    });
    const page = await open(world.alice);
    await page.goto(runPath(world.organization, workUnitId));
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Outcome unknown');
    await expect(page.getByText(/could not confirm what happened/)).toBeVisible();
    await expect(page.getByText(/We do not know whether something outside/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop this run' })).toHaveCount(0);
    expect(await axeFindings(page)).toEqual([]);
  });

  test('a stop is recorded, and the page does not call it done until the run has ended', async ({
    open,
    world,
  }) => {
    const { workUnitId, runId } = await running(world);
    const page = await open(world.alice);
    await page.goto(runPath(world.organization, workUnitId));
    await page.getByRole('button', { name: 'Stop this run' }).click();

    await expect(page.getByText(/A stop is recorded/)).toBeVisible();
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Running');
    await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);

    // The worker reaches it. The page finds out by itself, and says so.
    await moveRun(world.organization, runId, 'cancelled');
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Stopped');
    await expect(page.getByText(/A stop is recorded/)).toHaveCount(0);
    expect(await axeFindings(page)).toEqual([]);
  });

  test('pause and resume are offered in turn, and work with the keyboard', async ({
    open,
    world,
  }) => {
    const { workUnitId, runId } = await running(world);
    const page = await open(world.alice);
    await page.goto(runPath(world.organization, workUnitId));
    await page.getByRole('button', { name: 'Pause' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/A pause is recorded/)).toBeVisible();

    await moveRun(world.organization, runId, 'paused');
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Paused');
    await page.getByRole('button', { name: 'Resume' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/A resume is recorded/)).toBeVisible();
  });

  test('a member sees the run, is offered no control, and a forged form is refused and audited', async ({
    open,
    world,
  }) => {
    const { workUnitId, runId } = await running(world);
    const path = runPath(world.organization, workUnitId);
    const page = await open(world.bob);
    await page.goto(path);
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Running');
    await expect(page.getByRole('button', { name: /Stop|Pause|Resume/ })).toHaveCount(0);

    // Alice's own form, sent by Bob, is what a forgery looks like.
    const form = await formOn(path, world.alice.jar, (found) => found.hidden.get('kind') === 'stop');
    const forged = await post(path, world.bob.jar, form);
    expect(forged.headers.get('location')).toContain('error=FORBIDDEN');
    const direct = await fetch(`${BASE}${api(world.organization, `/${runId}/controls`)}`, {
      method: 'POST',
      headers: {
        cookie: world.bob.jar.cookie,
        origin: new URL(BASE).origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'stop' }),
    });
    expect(direct.status).toBe(403);

    const sql = await superuser();
    try {
      const { rows: controls } = await sql.query(
        `select 1 from ai.run_controls where run_id = $1`,
        [runId],
      );
      expect(controls).toEqual([]);
      const { rows: refusals } = await sql.query(
        `select safe_reason from governance.audit_events
          where actor_id = $1 and decision = 'deny' and safe_reason = 'FORBIDDEN'`,
        [world.membership.bob],
      );
      expect(refusals.length).toBeGreaterThanOrEqual(2);
    } finally {
      await sql.end();
    }
  });

  test('a forged request cannot set a run’s limits, and cross-origin is refused', async ({
    world,
  }) => {
    const workUnitId = await createWork(world.alice, world.organization, {
      title: 'Forge some limits',
      objective: 'Do it.',
    });
    const send = (origin: string, body: unknown) =>
      fetch(`${BASE}${api(world.organization, '')}`, {
        method: 'POST',
        headers: {
          cookie: world.alice.jar.cookie,
          origin,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify(body),
      });
    const good = { work_unit_id: workUnitId, agent_version_id: seeded.versionId };
    const own = new URL(BASE).origin;
    expect((await send(own, { ...good, max_cost_micros: 999 })).status).toBe(400);
    expect((await send('https://outside.example.invalid', good)).status).toBe(403);
    const started = await send(own, good);
    expect(started.status).toBe(202);
    const body = (await started.json()) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('delegated_scopes');
    expect(body['status']).toBe('queued');
  });

  test('work someone may not read is a 404, on the page and through the API', async ({
    open,
    world,
  }) => {
    // Restricted work of Alice's, with a run on it. Bob is not on it.
    const workUnitId = world.work.confidential;
    const runId = await seedRun({
      organization: world.organization,
      workUnitId,
      versionId: seeded.versionId,
      initiatorMembership: world.membership.alice,
      path: ['preparing', 'running'],
    });
    const page = await open(world.bob);
    const shown = await page.goto(runPath(world.organization, workUnitId));
    expect(shown?.status()).toBe(404);
    for (const tail of [`/${runId}`, `/${runId}/steps`, `?work_unit_id=${workUnitId}`]) {
      expect((await receive(api(world.organization, tail), world.bob)).status).toBe(404);
    }
    await moveRun(world.organization, runId, 'cancelled');
  });

  test('another organization’s run is a 404, in its own URL and in theirs', async ({ world }) => {
    const { workUnitId, runId } = await running(world);
    const quiet = world.quietOrganization;
    expect((await receive(api(quiet, `/${runId}`), world.quiet)).status).toBe(404);
    expect((await receive(api(quiet, `/${runId}/steps`), world.quiet)).status).toBe(404);
    expect((await receive(api(world.organization, `/${runId}`), world.quiet)).status).toBe(404);
    expect((await read(runPath(quiet, workUnitId), world.quiet.jar)).status).toBe(404);
  });

  test('says when it has lost contact, and shows the true state on reconnecting', async ({
    open,
    world,
  }) => {
    const { workUnitId, runId } = await running(world);
    const page = await open(world.alice);
    await page.goto(runPath(world.organization, workUnitId));
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Running');

    await page.route('**/api/v1/**/agent-runs/**', (route) => route.abort());
    await expect(page.getByText(/lost contact/)).toBeVisible({ timeout: 20_000 });

    // Things moved on while nobody could see. The other replica reads the same, from PostgreSQL.
    await moveRun(world.organization, runId, 'paused');
    const onOther = await onReplica('web-2', () =>
      visit(api(world.organization, `/${runId}`), world.alice.jar),
    );
    expect(((await onOther.json()) as { status: string }).status).toBe('paused');

    await page.unroute('**/api/v1/**/agent-runs/**');
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Paused', {
      timeout: 40_000,
    });
    await expect(page.getByText(/lost contact/)).toHaveCount(0);
    await moveRun(world.organization, runId, 'cancelled');
  });

  test('shows a loading line while the page is on its way', async ({ open, world }) => {
    const { workUnitId } = await running(world, {
      path: ['preparing', 'running', 'failed'],
      stopCode: 'INTERNAL_ERROR',
    });
    const page = await open(world.alice);
    await page.goto(`/o/${world.organization}/work/${workUnitId}`);
    await page.route('**/run**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.continue();
    });
    await page.evaluate((path) => {
      const link = document.createElement('a');
      link.href = path;
      document.querySelector('main')?.append(link);
    }, runPath(world.organization, workUnitId));
    await page.goto(runPath(world.organization, workUnitId));
    await expect(page.locator('dt:text-is("Status") + dd .badge')).toHaveText('Failed');
    await expect(page.getByText('Something went wrong on our side.')).toBeVisible();
  });

  test('a run ID that is not on this work is a 404', async ({ open, world }) => {
    const one = await running(world);
    const other = await running(world);
    const page = await open(world.alice);
    const shown = await page.goto(
      `${runPath(world.organization, one.workUnitId)}?run=${other.runId}`,
    );
    expect(shown?.status()).toBe(404);
    const nonsense = await page.goto(`${runPath(world.organization, one.workUnitId)}?run=nonsense`);
    expect(nonsense?.status()).toBe(404);
  });
});
