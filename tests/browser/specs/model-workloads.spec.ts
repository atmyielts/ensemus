// Authored UI/API gate. Generated auth-role proof and synthetic qualification are fixtures, not a
// claim of human MFA enrollment, a live provider, or successful production model execution.
import { randomUUID } from 'node:crypto';
import { openAppDatabase, resolveTenantContext } from '@ensemus/database';
import { createOrganization, signUp, BASE } from '../../helpers/forms';
import { proveSecondFactor } from '../../helpers/product';
import { seedQualifiedKnowledgeRoute } from '../../helpers/knowledge-models';
import { urls } from '../../helpers/stack';
import { test, expect } from '../support/fixtures';
import { axeFindings } from '../support/look';

const headers = { 'content-type': 'application/json', origin: new URL(BASE).origin };
const bounds = {
  max_calls: 2,
  max_input_tokens: 1000,
  max_output_tokens: 100,
  max_total_tokens: 2200,
  max_cost_micros: 500,
  timeout_seconds: 60,
};
const approvals = (org: string) => `/api/v1/organizations/${org}/knowledge/workload-approvals`;

test.describe('native Knowledge model authority controls', () => {
  test('native qualification forms require explicit limits and step up without queueing an unproved request', async ({
    open,
  }) => {
    const owner = await signUp(`Model operator ${randomUUID()}`);
    const org = await createOrganization(owner, 'Qualification fixture');
    const page = await open(owner, { javaScriptEnabled: false });
    const created = await page.request.post(`/api/v1/organizations/${org}/model-profiles`, {
      headers,
      data: {
        provider_kind: 'local_openai_compatible',
        model_id: 'generated-settings-model',
        alias: 'Qualification target',
        endpoint_url:
          process.env.ENSEMUS_TEST_PRIVATE_MODEL_ENDPOINT ?? 'http://fake-model:8000/v1',
        billing_owner: 'customer',
        region: null,
        capabilities: ['text'],
        limits: { max_input_tokens: 4096, max_output_tokens: 256 },
        allowed_classes: ['public'],
        allowed_purposes: ['embed', 'rerank', 'answer'],
        retention_basis: 'self_hosted',
        contract_ref: null,
        fallback_profile_ids: [],
      },
    });
    expect(created.status()).toBe(201);
    const profile = (await created.json()) as { id: string; version: number };
    const path = `/o/${org}/settings/models/${profile.id}`;
    await page.goto(path);
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Request capability test' }) });
    await expect(form.locator('[name=maxCostMicros]')).toHaveValue('');
    await expect(form.locator('[name=maxTotalTokens]')).toHaveValue('');
    // A label that wraps its select also holds the chosen option's words, so the select is found by its
    // accessible name, which is the label's own words only.
    await form.getByRole('combobox', { name: 'Capability', exact: true }).selectOption('embed');
    await form.getByLabel('Embedding dimensions').fill('3');
    await form.getByLabel('Embedding space version').fill('generated-space');
    for (const [name, value] of Object.entries({
      maxInputTokens: '1000',
      maxOutputTokens: '100',
      maxTotalTokens: '1100',
      maxCostMicros: '500',
      timeoutSeconds: '60',
    }))
      await form.locator(`[name=${name}]`).fill(value);
    await form.getByRole('button', { name: 'Request capability test' }).click();
    // MFA_REQUIRED sends every privileged form to the one confirmation page, which returns to this
    // profile once a code is entered (ADR-031 D8, apps/web/src/lib/step-up.ts). There is no other
    // step-up route, so the exact address says the request was refused for want of a second factor.
    await expect(page).toHaveURL(
      `${new URL(BASE).origin}/o/${org}/security/confirm?next=${encodeURIComponent(path)}`,
    );
    const evidence = await page.request.get(
      `/api/v1/organizations/${org}/model-profiles/${profile.id}/qualifications`,
    );
    expect(evidence.status()).toBe(200);
    expect(((await evidence.json()) as { items: unknown[] }).items).toEqual([]);
  });

  test('an owner approves exact qualified evidence and revokes without fresh MFA, without JavaScript', async ({
    open,
    world,
  }) => {
    const owner = await signUp(`Bounded operator ${randomUUID()}`);
    const org = await createOrganization(owner, 'Workload fixture');
    const person = await world.sql.query<{ userId: string; sessionId: string }>(
      'select u.id "userId",s.id "sessionId" from identity.users u join identity.sessions s on s.user_id=u.id where u.email=$1 order by s.created_at desc limit 1',
      [owner.email],
    );
    const identity = person.rows[0];
    if (!identity) throw new Error('TEST_NATIVE_SESSION_MISSING');
    const database = openAppDatabase(urls.app());
    let route: Awaited<ReturnType<typeof seedQualifiedKnowledgeRoute>>;
    try {
      const context = await resolveTenantContext(database.db, identity.userId, org);
      route = await seedQualifiedKnowledgeRoute(database.db, context, { dimension: 3 });
    } finally {
      await database.close();
    }
    await proveSecondFactor(identity);
    const page = await open(owner, { javaScriptEnabled: false });
    await page.goto(`/o/${org}/settings/models/workloads`);
    await expect(
      page.getByRole('heading', { name: 'Knowledge workload approvals', exact: true }),
    ).toBeVisible();
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Approve workload', exact: true }) });
    await form.getByRole('combobox', { name: 'Workload', exact: true }).selectOption('query');
    await form.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('organization');
    await form.getByLabel('Semantic indexing', { exact: true }).check();
    await form.locator(`[name=qualificationIds][value="${route.qualificationId}"]`).check();
    await form
      .getByRole('combobox', { name: 'Highest permitted classification', exact: true })
      .selectOption('internal');
    for (const [name, value] of Object.entries({
      maxCalls: '2',
      maxInputTokens: '1000',
      maxOutputTokens: '100',
      maxTotalTokens: '2200',
      maxCostMicros: '500',
      timeoutSeconds: '60',
    }))
      await form.locator(`[name=${name}]`).fill(value);
    await form
      .getByLabel('Expiry, including timezone')
      .fill(new Date(Date.now() + 3600000).toISOString());
    await form.getByRole('button', { name: 'Approve workload', exact: true }).click();
    await expect(page.getByText('Approved within limits', { exact: true })).toBeVisible();
    const response = await page.request.get(approvals(org));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      items: { id: string; qualifications: { id: string; usable: boolean }[] }[];
    };
    const approval = body.items[0];
    expect(approval?.qualifications).toEqual([{ id: route.qualificationId, usable: true }]);
    if (!approval) throw new Error('TEST_APPROVAL_MISSING');
    await proveSecondFactor(identity, new Date(Date.now() - 86400000));
    const confirm = page
      .locator('details')
      .filter({ has: page.locator(`input[name=approvalId][value="${approval.id}"]`) });
    await confirm.locator('summary').click();
    await confirm.locator('input[name=confirm]').check();
    await confirm.getByRole('button', { name: `Confirm revocation of ${approval.id}` }).click();
    await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
    expect(await axeFindings(page)).toEqual([]);
  });

  test('member, foreign-tenant and identity-smuggling API requests cannot create authority', async ({
    open,
    world,
  }) => {
    const owner = await open(world.alice),
      member = await open(world.bob),
      other = await open(world.quiet);
    const body = {
      kind: 'query',
      scope: 'organization',
      source_id: null,
      connection_id: null,
      purposes: ['embed'],
      qualification_ids: [randomUUID()],
      max_classification: 'internal',
      bounds,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      request_key: randomUUID(),
    };
    expect(
      (await member.goto(`/o/${world.organization}/settings/models/workloads`))?.status(),
    ).toBe(404);
    expect((await member.request.get(approvals(world.organization))).status()).toBe(403);
    expect(
      (await member.request.post(approvals(world.organization), { headers, data: body })).status(),
    ).toBe(403);
    expect((await other.request.get(approvals(world.organization))).status()).toBe(404);
    const forged = await owner.request.post(approvals(world.organization), {
      headers,
      data: { ...body, session_id: randomUUID(), mfa_verified: true },
    });
    expect(forged.status()).toBe(400);
    expect(((await forged.json()) as { code: string }).code).toBe('INVALID_INPUT');
  });
});
