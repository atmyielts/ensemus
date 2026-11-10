// MODEL-01, COMM-02, FD-10, FD-21, FD-23, SEC-016, QA-024 (API and UI part). Two tenants with the same
// names, real roles, RLS and triggers. Every value is generated, and nothing here reaches a provider.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkUnit } from '@ensemus/application';
import {
  addRateCard,
  attachModelKey,
  createModelProfile,
  createProfileStore,
  disableModelProfile,
  getModelProfile,
  listModelProfiles,
  prepareModelKeyCapture,
  requestModelProbe,
  updateModelProfile,
} from '@ensemus/application/ai-model-profiles';
import { loadProfileForProbe, recordProbeResult } from '@ensemus/application/ai-model-probe-store';
import type { CreateModelProfile } from '@ensemus/contracts/ai';
import {
  auditEvents,
  domainEvents,
  modelEvaluations,
  modelProfiles,
  openAppDatabase,
  outboxEvents,
  sealedSecrets,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createAgentContext, openAgentDatabase, withRunLookupTx } from '@ensemus/database/agent';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { modelKeyPurpose } from '@ensemus/domain/ai-binding';
import { MODEL_PROFILE_PROBE_REQUESTED } from '@ensemus/domain/ai-events';
import { createProfileProber } from '@ensemus/intelligence';
import { RecordingLender, ScriptedModelAdapter } from '@ensemus/intelligence/testing';
import { FileKeyProvider, SecretBroker, SecretUnavailable } from '@ensemus/secrets/broker';
import { storeSecret } from '@ensemus/secrets/seal';
import { createModelProbeActivities } from '@ensemus/workflows/model-probe-activities';
import { and, eq } from 'drizzle-orm';
import { holdsCanary, throwawayModelKey } from '../helpers/ai/canaries';
import {
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedDraftProfile,
  seedQueuedRun,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { secret, urls } from '../helpers/stack';

const PRIVATE = 'http://models.example.invalid:8080';
const settings = { privateEndpoints: [PRIVATE] };
const REVIEWED = 'test-review-reference';

const local = (alias: string): CreateModelProfile => ({
  provider_kind: 'local_openai_compatible',
  model_id: 'scripted-test-model',
  alias,
  endpoint_url: `${PRIVATE}/v1`,
  billing_owner: 'customer',
  region: null,
  capabilities: ['text'],
  limits: { max_input_tokens: 4096, max_output_tokens: 256 },
  allowed_classes: ['public', 'internal'],
  allowed_purposes: ['reason'],
  retention_basis: 'self_hosted',
  contract_ref: null,
  fallback_profile_ids: [],
});
const hosted = (alias: string): CreateModelProfile => ({
  ...local(alias),
  provider_kind: 'openai_hosted',
  endpoint_url: 'https://api.openai.com/v1',
  retention_basis: 'unreviewed',
});

const code = (expected: string) => expect.objectContaining({ code: expected });

describe('model profiles', () => {
  const publicKeyPem = secret('sealing_public_key.pem');
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentDatabase>;
  let secretsDb: ReturnType<typeof openSecretsDatabase>;
  let broker: SecretBroker;
  let a: AiTenant;
  let b: AiTenant;

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    agent = openAgentDatabase(urls.agent());
    secretsDb = openSecretsDatabase(urls.secrets());
    broker = new SecretBroker(
      secretsDb.db,
      new FileKeyProvider([secret('sealing_private_key.pem')]),
    );
    a = await seedAiTenant(app.db);
    b = await seedAiTenant(app.db);
  });

  afterAll(async () => {
    await app.close();
    await agent.close();
    await secretsDb.close();
  });

  const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;

  const row = async (context: TenantContext, id: string) => {
    const [found] = await withTenantTx(app.db, context, (tx) =>
      tx.select().from(modelProfiles).where(eq(modelProfiles.id, id)),
    );
    return found!;
  };

  /** What the route does, without a route. */
  async function captureKey(
    context: TenantContext,
    profileId: string,
    expectedVersion: number,
    key: string,
    reviewInterlock: string | null = null,
  ) {
    const { purpose } = await prepareModelKeyCapture(app.db, context, {
      profileId,
      expectedVersion,
      reviewInterlock,
    });
    const { secretRef } = await storeSecret(app.db, context, {
      publicKeyPem,
      purpose,
      plaintext: key,
    });
    return {
      secretRef,
      view: await attachModelKey(app.db, context, {
        profileId,
        expectedVersion,
        secretRef,
        reviewInterlock,
      }),
    };
  }

  describe('who can do what', () => {
    it('a member cannot create a profile, and nothing is written', async () => {
      const alias = unique('member');
      await expect(createModelProfile(app.db, a.member, local(alias), settings)).rejects.toEqual(
        code('FORBIDDEN'),
      );
      const rows = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(modelProfiles).where(eq(modelProfiles.alias, alias)),
      );
      expect(rows).toEqual([]);
    });

    it('a member cannot read, change, test, turn off or price one', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      await expect(listModelProfiles(app.db, a.member)).rejects.toEqual(code('FORBIDDEN'));
      await expect(getModelProfile(app.db, a.member, id)).rejects.toEqual(code('FORBIDDEN'));
      await expect(
        updateModelProfile(
          app.db,
          a.member,
          { profileId: id, patch: { expected_version: 1, alias: unique('x') } },
          settings,
        ),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(
        requestModelProbe(app.db, a.member, { profileId: id, expectedVersion: 1 }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(
        disableModelProfile(app.db, a.member, { profileId: id, expectedVersion: 1 }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(
        addRateCard(app.db, a.member, {
          profileId: id,
          inputMicrosPerMtok: 1,
          outputMicrosPerMtok: 1,
        }),
      ).rejects.toEqual(code('FORBIDDEN'));
    });
  });

  describe('two tenants', () => {
    it('another tenant’s profile ID answers not found, for every service', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      await expect(getModelProfile(app.db, b.owner, id)).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        updateModelProfile(
          app.db,
          b.owner,
          { profileId: id, patch: { expected_version: 1, alias: unique('x') } },
          settings,
        ),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        prepareModelKeyCapture(app.db, b.owner, {
          profileId: id,
          expectedVersion: 1,
          reviewInterlock: REVIEWED,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        attachModelKey(app.db, b.owner, {
          profileId: id,
          expectedVersion: 1,
          secretRef: randomUUID(),
          reviewInterlock: REVIEWED,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        requestModelProbe(app.db, b.owner, { profileId: id, expectedVersion: 1 }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        disableModelProfile(app.db, b.owner, { profileId: id, expectedVersion: 1 }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(
        addRateCard(app.db, b.owner, {
          profileId: id,
          inputMicrosPerMtok: 1,
          outputMicrosPerMtok: 1,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
      expect((await row(a.owner, id)).version).toBe(1);
    });

    it('the same alias can exist in each, and neither list shows the other’s', async () => {
      const alias = unique('same');
      const mine = await createModelProfile(app.db, a.owner, local(alias), settings);
      const theirs = await createModelProfile(app.db, b.owner, local(alias), settings);
      const listA = await listModelProfiles(app.db, a.owner);
      const listB = await listModelProfiles(app.db, b.owner);
      expect(listA.map((p) => p.id)).toContain(mine.id);
      expect(listA.map((p) => p.id)).not.toContain(theirs.id);
      expect(listB.map((p) => p.id)).toContain(theirs.id);
      expect(listB.map((p) => p.id)).not.toContain(mine.id);
    });

    it('a key sealed in another tenant cannot be attached here', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      const { secretRef } = await storeSecret(app.db, b.owner, {
        publicKeyPem,
        purpose: modelKeyPurpose(id, `${PRIVATE}/v1`),
        plaintext: throwawayModelKey(),
      });
      await expect(
        attachModelKey(app.db, a.owner, {
          profileId: id,
          expectedVersion: 1,
          secretRef,
          reviewInterlock: null,
        }),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('a fallback from another tenant is refused', async () => {
      const theirs = await seedDraftProfile(app.db, b.owner);
      await expect(
        createModelProfile(
          app.db,
          a.owner,
          { ...local(unique('fallback')), fallback_profile_ids: [theirs] },
          settings,
        ),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('the store never offers one tenant another’s model', async () => {
      const version = await seedAgentVersion(app.db, a.owner);
      const workUnitId = await seedWork(a.owner);
      const runId = await seedQueuedRun(app.db, a.owner, { workUnitId, version });
      const context = await createAgentContext(agent.db, {
        organizationId: a.organizationId,
        initiatorMembershipId: a.owner.membershipId,
        agentRunId: runId,
      });
      const theirs = await seedActiveProfile(app.db, agent.db, b.owner);
      const store = createProfileStore(agent.db);
      const candidates = await store.listCandidates(context);
      expect(candidates.map((p) => p.id)).not.toContain(theirs);
      await expect(store.getProfile(context, theirs)).resolves.toBeNull();
      await expect(store.latestRateCard(context, theirs)).resolves.toBeNull();
    });
  });

  const seedWork = async (context: TenantContext): Promise<string> =>
    (await createWorkUnit(app.db, context, { title: 'A piece of work' })).id;

  describe('addresses', () => {
    it.each([
      ['an arbitrary address', 'https://attacker.example.invalid/v1'],
      ['a cloud metadata address', 'http://169.254.169.254/latest'],
      ['a loopback address', 'http://127.0.0.1:8080/v1'],
      ['a provider’s host over plain HTTP', 'http://api.openai.com/v1'],
    ])('refuses %s for a hosted kind', async (_name, endpoint_url) => {
      await expect(
        createModelProfile(app.db, a.owner, { ...hosted(unique('h')), endpoint_url }, settings),
      ).rejects.toEqual(code('MODEL_ENDPOINT_NOT_ALLOWED'));
    });

    it('refuses to change a hosted profile to an arbitrary address', async () => {
      const view = await createModelProfile(app.db, a.owner, hosted(unique('h')), settings);
      await expect(
        updateModelProfile(
          app.db,
          a.owner,
          {
            profileId: view.id,
            patch: {
              expected_version: view.version,
              endpoint_url: 'https://attacker.example.invalid/v1',
            },
          },
          settings,
        ),
      ).rejects.toEqual(code('MODEL_ENDPOINT_NOT_ALLOWED'));
      expect((await row(a.owner, view.id)).endpointUrl).toBe('https://api.openai.com/v1');
    });

    it('refuses a private address the operator did not list, whatever the tenant says', async () => {
      await expect(createModelProfile(app.db, a.owner, local(unique('l')))).rejects.toEqual(
        code('MODEL_ENDPOINT_NOT_ALLOWED'),
      );
    });

    it.each([
      ['a query', 'https://models.example.invalid/v1?api_key=abc'],
      ['a password', 'https://user:pass@models.example.invalid/v1'],
    ])('refuses an address holding %s', async (_name, endpoint_url) => {
      await expect(
        createModelProfile(
          app.db,
          a.owner,
          {
            ...local(unique('o')),
            provider_kind: 'openai_compatible',
            endpoint_url,
            retention_basis: 'unreviewed',
          },
          settings,
        ),
      ).rejects.toEqual(code('MODEL_ENDPOINT_NOT_ALLOWED'));
    });
  });

  describe('the key', () => {
    it('hosted: refused without the review setting, before anything is sealed (FD-21)', async () => {
      const view = await createModelProfile(app.db, a.owner, hosted(unique('h')), settings);
      const key = throwawayModelKey();
      await expect(captureKey(a.owner, view.id, view.version, key, null)).rejects.toEqual(
        code('MODEL_CREDENTIALS_NOT_REVIEWED'),
      );
      expect((await row(a.owner, view.id)).secretRef).toBeNull();
    });

    it('public compatible address: refused without it too, so the interlock cannot be walked around', async () => {
      const view = await createModelProfile(
        app.db,
        a.owner,
        {
          ...local(unique('c')),
          provider_kind: 'openai_compatible',
          endpoint_url: 'https://models.example.invalid/v1',
          retention_basis: 'unreviewed',
        },
        settings,
      );
      await expect(
        captureKey(a.owner, view.id, view.version, throwawayModelKey(), null),
      ).rejects.toEqual(code('MODEL_CREDENTIALS_NOT_REVIEWED'));
    });

    it('hosted: attaching a stored reference directly is refused too', async () => {
      const view = await createModelProfile(app.db, a.owner, hosted(unique('h')), settings);
      const { secretRef } = await storeSecret(app.db, a.owner, {
        publicKeyPem,
        purpose: modelKeyPurpose(view.id, view.endpoint_url),
        plaintext: throwawayModelKey(),
      });
      await expect(
        attachModelKey(app.db, a.owner, {
          profileId: view.id,
          expectedVersion: view.version,
          secretRef,
          reviewInterlock: null,
        }),
      ).rejects.toEqual(code('MODEL_CREDENTIALS_NOT_REVIEWED'));
    });

    it('a private endpoint works without it, and only the fact of a key is shown', async () => {
      const view = await createModelProfile(app.db, a.owner, local(unique('l')), settings);
      const key = throwawayModelKey();
      const { secretRef, view: after } = await captureKey(a.owner, view.id, view.version, key);
      expect(after.has_credential).toBe(true);
      const shown = JSON.stringify([after, await getModelProfile(app.db, a.owner, view.id)]);
      expect(holdsCanary(shown, key)).toBe(false);
      expect(holdsCanary(shown, secretRef)).toBe(false);
      expect(shown).not.toContain('secret_ref');
    });

    it('cannot be read back by the web role, by any route', async () => {
      const view = await createModelProfile(app.db, a.owner, local(unique('l')), settings);
      await captureKey(a.owner, view.id, view.version, throwawayModelKey());
      await expect(
        withTenantTx(app.db, a.owner, (tx) => tx.select().from(sealedSecrets)),
      ).rejects.toThrow();
    });

    it('leaves no trace of itself in the database outside its ciphertext', async () => {
      const view = await createModelProfile(app.db, a.owner, local(unique('l')), settings);
      const key = throwawayModelKey();
      await captureKey(a.owner, view.id, view.version, key);
      const superuser = new pg.Client({ connectionString: urls.superuser() });
      await superuser.connect();
      try {
        for (const table of [
          'ai.model_profiles',
          'governance.audit_events',
          'platform.domain_events',
          'secrets.sealed_secrets',
        ]) {
          const { rows } = await superuser.query(
            `select row_to_json(t)::text as t from ${table} t`,
          );
          expect(holdsCanary(rows.map((r) => r.t as string).join('\n'), key), table).toBe(false);
        }
      } finally {
        await superuser.end();
      }
    });

    it('opens only for the broker, under the purpose naming this profile and address', async () => {
      const view = await createModelProfile(app.db, a.owner, local(unique('l')), settings);
      const key = throwawayModelKey();
      const { secretRef } = await captureKey(a.owner, view.id, view.version, key);
      const binding = { organizationId: a.organizationId, secretId: secretRef };
      await broker.withSecret(
        { ...binding, purpose: modelKeyPurpose(view.id, view.endpoint_url) },
        async (opened) => expect(opened.toString()).toBe(key),
      );
      await expect(
        broker.withSecret(
          { ...binding, purpose: modelKeyPurpose(view.id, 'http://other.example.invalid/v1') },
          async () => undefined,
        ),
      ).rejects.toBeInstanceOf(SecretUnavailable);
      await expect(
        broker.withSecret(
          { ...binding, purpose: modelKeyPurpose(randomUUID(), view.endpoint_url) },
          async () => undefined,
        ),
      ).rejects.toBeInstanceOf(SecretUnavailable);
    });

    it('a new key means testing again', async () => {
      const id = await seedActiveProfile(app.db, agent.db, a.owner);
      const before = await row(a.owner, id);
      const { view } = await captureKey(a.owner, id, before.version, throwawayModelKey());
      expect(view.status).toBe('draft');
      expect(view.qualified_at).toBeNull();
      expect(view.version).toBe(before.version + 1);
    });

    it('refuses a stale version before sealing anything', async () => {
      const view = await createModelProfile(app.db, a.owner, local(unique('l')), settings);
      await expect(
        captureKey(a.owner, view.id, view.version + 1, throwawayModelKey()),
      ).rejects.toEqual(code('VERSION_CONFLICT'));
    });
  });

  describe('changing the endpoint', () => {
    it('voids the key, returns the profile to draft and bumps its version', async () => {
      const view = await createModelProfile(
        app.db,
        a.owner,
        { ...local(unique('l')), endpoint_url: `${PRIVATE}/v1` },
        settings,
      );
      const { view: keyed } = await captureKey(a.owner, view.id, view.version, throwawayModelKey());
      const after = await updateModelProfile(
        app.db,
        a.owner,
        {
          profileId: view.id,
          patch: { expected_version: keyed.version, endpoint_url: `${PRIVATE}/v2` },
        },
        settings,
      );
      expect(after.has_credential).toBe(false);
      expect(after.status).toBe('draft');
      expect(after.version).toBe(keyed.version + 1);
      expect((await row(a.owner, view.id)).secretRef).toBeNull();
    });

    it('takes an active profile out of service', async () => {
      const id = await seedActiveProfile(app.db, agent.db, a.owner);
      const before = await row(a.owner, id);
      const after = await updateModelProfile(
        app.db,
        a.owner,
        {
          profileId: id,
          patch: { expected_version: before.version, endpoint_url: `${PRIVATE}/other` },
        },
        settings,
      );
      expect(after.status).toBe('draft');
      expect(after.qualified_at).toBeNull();
    });

    it('a change of name alone voids nothing', async () => {
      const view = await createModelProfile(app.db, a.owner, local(unique('l')), settings);
      const { view: keyed } = await captureKey(a.owner, view.id, view.version, throwawayModelKey());
      const after = await updateModelProfile(
        app.db,
        a.owner,
        { profileId: view.id, patch: { expected_version: keyed.version, alias: unique('new') } },
        settings,
      );
      expect(after.has_credential).toBe(true);
    });

    it('refuses a stale version', async () => {
      const view = await createModelProfile(app.db, a.owner, local(unique('l')), settings);
      await expect(
        updateModelProfile(
          app.db,
          a.owner,
          { profileId: view.id, patch: { expected_version: view.version + 1, alias: 'x' } },
          settings,
        ),
      ).rejects.toEqual(code('VERSION_CONFLICT'));
    });
  });

  describe('activation', () => {
    it('web cannot mark a profile active, even writing the row itself', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      // Into probing the way production gets there: the owner's MFA-stepped-up probe request.
      await requestModelProbe(app.db, a.owner, { profileId: id, expectedVersion: 1 });
      await expect(
        withTenantTx(app.db, a.owner, (tx) =>
          tx.update(modelProfiles).set({ status: 'active' }).where(eq(modelProfiles.id, id)),
        ),
      ).rejects.toThrow();
      expect((await row(a.owner, id)).status).toBe('probing');
    });

    it('web has no grant to write qualified_at', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      await expect(
        withTenantTx(app.db, a.owner, (tx) =>
          tx.update(modelProfiles).set({ qualifiedAt: new Date() }).where(eq(modelProfiles.id, id)),
        ),
      ).rejects.toThrow();
    });

    it('even the agent role cannot mark active without a pass recorded', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      // Into probing the way production gets there: the owner's MFA-stepped-up probe request.
      await requestModelProbe(app.db, a.owner, { profileId: id, expectedVersion: 1 });
      await expect(
        withRunLookupTx(agent.db, a.organizationId, (tx) =>
          tx.update(modelProfiles).set({ status: 'active' }).where(eq(modelProfiles.id, id)),
        ),
      ).rejects.toThrow();
    });

    it('asking for a probe moves to probing and writes its event and outbox row together', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      await requestModelProbe(app.db, a.owner, { profileId: id, expectedVersion: 1 });
      expect((await row(a.owner, id)).status).toBe('probing');
      expect((await row(a.owner, id)).probeRequestedByMembershipId).toBe(a.owner.membershipId);
      const events = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select({ id: domainEvents.id, payload: domainEvents.payload })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.aggregateId, id),
              eq(domainEvents.eventType, MODEL_PROFILE_PROBE_REQUESTED),
            ),
          ),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({});
      const outbox = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(outboxEvents).where(eq(outboxEvents.eventId, events[0]!.id)),
      );
      expect(outbox).toHaveLength(1);
    });

    it('a hosted profile with no key cannot ask for a probe', async () => {
      const view = await createModelProfile(app.db, a.owner, hosted(unique('h')), settings);
      await expect(
        requestModelProbe(app.db, a.owner, { profileId: view.id, expectedVersion: view.version }),
      ).rejects.toEqual(code('INVALID_STATE'));
      expect((await row(a.owner, view.id)).status).toBe('draft');
    });

    it('a stale request changes nothing and emits nothing', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      await expect(
        requestModelProbe(app.db, a.owner, { profileId: id, expectedVersion: 9 }),
      ).rejects.toEqual(code('VERSION_CONFLICT'));
      const events = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, id)),
      );
      expect(events).toEqual([]);
    });
  });

  describe('the probe’s result', () => {
    const scripted = (
      script: ConstructorParameters<typeof ScriptedModelAdapter>[0],
      organizationId: string,
    ) => {
      const adapter = new ScriptedModelAdapter(script);
      const lender = new RecordingLender(randomBytes(16));
      const probe = createProfileProber({
        load: (input) => loadProfileForProbe(agent.db, input),
        adapter,
        guard: { fetchFor: () => fetch },
        credentials: lender,
        privateEndpoints: [`http://127.0.0.1:59999`],
      });
      const activities = createModelProbeActivities({ database: agent.db, probe });
      return { adapter, lender, activities, organizationId };
    };

    async function probing(context: TenantContext) {
      const id = await seedDraftProfile(app.db, context);
      await requestModelProbe(app.db, context, { profileId: id, expectedVersion: 1 });
      return id;
    }

    it('a pass makes the profile active, with its evaluation and audit rows', async () => {
      const id = await probing(a.owner);
      const { activities } = scripted([{ kind: 'final', text: 'ready' }], a.organizationId);
      await expect(
        activities.runModelProbe({ organizationId: a.organizationId, modelProfileId: id }),
      ).resolves.toBe('passed');
      const after = await row(a.owner, id);
      expect(after.status).toBe('active');
      expect(after.qualifiedAt).toBeInstanceOf(Date);
      const evaluations = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(modelEvaluations).where(eq(modelEvaluations.profileId, id)),
      );
      expect(evaluations).toMatchObject([{ suite: 'probe', passed: true, profileVersion: 1 }]);
      const audit = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select({ action: auditEvents.action })
          .from(auditEvents)
          .where(eq(auditEvents.targetRef, `model_profile:${id}`)),
      );
      expect(audit.map((entry) => entry.action)).toContain('model_profile.probe_passed');
    });

    it.each([
      ['an adapter failure', [{ kind: 'failure', failure: 'server_error' }]],
      ['a bug in an adapter', [{ kind: 'throw' }]],
      ['a tool call nobody offered', [{ kind: 'tool_call', toolId: 'work.read', args: {} }]],
      ['an empty answer', [{ kind: 'final', text: '  ' }]],
    ] as const)('%s fails closed', async (_name, script) => {
      const id = await probing(a.owner);
      const { activities } = scripted(script, a.organizationId);
      await expect(
        activities.runModelProbe({ organizationId: a.organizationId, modelProfileId: id }),
      ).resolves.toBe('failed');
      const after = await row(a.owner, id);
      expect(after.status).toBe('probe_failed');
      expect(after.qualifiedAt).toBeNull();
    });

    it('a profile not waiting for a probe is skipped: no call, no key, no write', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      const { activities, adapter, lender } = scripted([], a.organizationId);
      await expect(
        activities.runModelProbe({ organizationId: a.organizationId, modelProfileId: id }),
      ).resolves.toBe('skipped');
      expect(adapter.hits).toBe(0);
      expect(lender.asked).toEqual([]);
      expect((await row(a.owner, id)).status).toBe('draft');
    });

    it('a stale version writes nothing at all', async () => {
      const id = await probing(a.owner);
      await recordProbeResult(agent.db, {
        organizationId: a.organizationId,
        profileId: id,
        profileVersion: 99,
        passed: true,
      });
      const after = await row(a.owner, id);
      expect(after.status).toBe('probing');
      expect(after.qualifiedAt).toBeNull();
      const evaluations = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(modelEvaluations).where(eq(modelEvaluations.profileId, id)),
      );
      expect(evaluations).toEqual([]);
    });

    it('a change during the test wins: the pass that follows it writes nothing', async () => {
      const id = await probing(a.owner);
      const tested = await loadProfileForProbe(agent.db, {
        organizationId: a.organizationId,
        profileId: id,
      });
      const changed = await updateModelProfile(
        app.db,
        a.owner,
        {
          profileId: id,
          patch: { expected_version: tested!.version, endpoint_url: `${PRIVATE}/changed` },
        },
        settings,
      );
      await recordProbeResult(agent.db, {
        organizationId: a.organizationId,
        profileId: id,
        profileVersion: tested!.version,
        passed: true,
      });
      const after = await row(a.owner, id);
      expect(after.status).toBe('draft');
      expect(after.version).toBe(changed.version);
    });

    it('cannot write into another tenant', async () => {
      const id = await probing(a.owner);
      await recordProbeResult(agent.db, {
        organizationId: b.organizationId,
        profileId: id,
        profileVersion: 1,
        passed: true,
      });
      expect((await row(a.owner, id)).status).toBe('probing');
      await expect(
        loadProfileForProbe(agent.db, { organizationId: b.organizationId, profileId: id }),
      ).resolves.toBeNull();
    });

    it('only an active profile is a routing candidate', async () => {
      const active = await seedActiveProfile(app.db, agent.db, a.owner);
      const draft = await seedDraftProfile(app.db, a.owner);
      const version = await seedAgentVersion(app.db, a.owner);
      const runId = await seedQueuedRun(app.db, a.owner, {
        workUnitId: await seedWork(a.owner),
        version,
      });
      const context = await createAgentContext(agent.db, {
        organizationId: a.organizationId,
        initiatorMembershipId: a.owner.membershipId,
        agentRunId: runId,
      });
      const ids = (await createProfileStore(agent.db).listCandidates(context)).map((p) => p.id);
      expect(ids).toContain(active);
      expect(ids).not.toContain(draft);
      await expect(createProfileStore(agent.db).getProfile(context, draft)).resolves.toMatchObject({
        id: draft,
        status: 'draft',
        destination: 'customer_private_inference',
      });
    });
  });

  describe('turning off, and rate cards', () => {
    it('turning off takes a profile out of routing at once', async () => {
      const id = await seedActiveProfile(app.db, agent.db, a.owner);
      const before = await row(a.owner, id);
      await disableModelProfile(app.db, a.owner, {
        profileId: id,
        expectedVersion: before.version,
      });
      expect((await row(a.owner, id)).status).toBe('disabled');
    });

    it('rate cards count up, and an earlier one cannot be changed', async () => {
      const id = await seedDraftProfile(app.db, a.owner);
      const first = await addRateCard(app.db, a.owner, {
        profileId: id,
        inputMicrosPerMtok: 7,
        outputMicrosPerMtok: 11,
      });
      const second = await addRateCard(app.db, a.owner, {
        profileId: id,
        inputMicrosPerMtok: 8,
        outputMicrosPerMtok: 12,
      });
      expect([first.version, second.version]).toEqual([1, 2]);
    });
  });
});
