// MODEL-01, COMM-02, SEC-016: the rules of model profiles, against a recording transaction. Real roles,
// RLS and triggers are in tests/integration/ai-model-profiles.test.ts. These prove the refusals come
// first and that a refused request writes nothing.
import { randomUUID } from 'node:crypto';
import {
  auditEvents,
  domainEvents,
  modelProfiles,
  outboxEvents,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import type { CreateModelProfile } from '@ensemus/contracts/ai';
import type { ProviderKind } from '@ensemus/domain/ai';
import { modelKeyPurpose } from '@ensemus/domain/ai-binding';
import { MODEL_PROFILE_PROBE_REQUESTED } from '@ensemus/domain/ai-events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors';
import { assertInteractivePrivilege } from '../product/privileged';
import {
  addRateCard,
  assertKeyMayBeStored,
  attachModelKey,
  createModelProfile,
  destinationFor,
  disableModelProfile,
  endpointHoldsNoSecrets,
  getModelProfile,
  latestRateCardFor,
  listModelProfiles,
  needsReviewInterlock,
  patchColumns,
  prepareModelKeyCapture,
  probeRefusal,
  requestModelProbe,
  retentionHolds,
  toModelProfileView,
  toRoutableProfile,
  updateModelProfile,
  type ModelProfileRow,
} from './model-profiles';

// A context can only be made by the database package, so its binding is replaced here, and the tx is the
// test's own. What the transport slice's checkEndpoint will hold is stood in for by the host list below.
vi.mock('@ensemus/database', async (original) => ({
  ...(await original<typeof import('@ensemus/database')>()),
  withTenantTx: (database: { tx: unknown }, _context: unknown, fn: (tx: unknown) => unknown) =>
    fn(database.tx),
}));
// This recording transaction exercises profile rules. Real native/auth authority is covered by
// interactive-privileges.test.ts; its explicit double still verifies that refusal precedes writes.
vi.mock('../product/privileged', async (original) => ({
  ...(await original<typeof import('../product/privileged')>()),
  assertInteractivePrivilege: vi.fn(async () => undefined),
}));
vi.mock('@ensemus/policy/endpoint', () => ({
  checkEndpoint: (kind: string, endpointUrl: string, settings: { privateEndpoints: string[] }) => {
    const { host, origin } = new URL(endpointUrl);
    const allowed =
      kind === 'openai_hosted'
        ? host === 'api.openai.com'
        : kind === 'local_openai_compatible'
          ? settings.privateEndpoints.includes(origin)
          : true;
    return allowed
      ? { ok: true, host, port: 443, viaPrivateAllowlist: false }
      : { ok: false, code: 'MODEL_ENDPOINT_NOT_ALLOWED' };
  },
}));

const ORG = randomUUID();
const PROFILE = randomUUID();
const CANARY_REF = randomUUID();
const context = (role: string) =>
  ({
    organizationId: ORG,
    userId: randomUUID(),
    membershipId: randomUUID(),
    role,
    actorType: 'user',
  }) as unknown as TenantContext;
const owner = context('owner');
const member = context('member');

const row = (overrides: Partial<ModelProfileRow> = {}): ModelProfileRow => ({
  organizationId: ORG,
  id: PROFILE,
  version: 3,
  providerKind: 'local_openai_compatible',
  modelId: 'scripted-test-model',
  alias: 'A model',
  endpointUrl: 'http://models.example.invalid:8080/v1',
  secretRef: null,
  billingOwner: 'customer',
  region: null,
  capabilities: ['text'],
  limits: { maxInputTokens: 4096, maxOutputTokens: 512 },
  allowedClasses: ['public'],
  allowedPurposes: ['reason'],
  retentionBasis: 'self_hosted',
  contractRef: null,
  fallbackProfileIds: [],
  crossBillingApprovedByMembershipId: null,
  status: 'draft',
  qualifiedAt: null,
  probeRequestedByMembershipId: null,
  probeAuthorizedProfileVersion: null,
  probeAuthorizedMembershipId: null,
  probeAuthorizedSessionId: null,
  probeAuthorizedAt: null,
  createdByMembershipId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/** Answers selects from `rows`, and records every write. A chain, as Drizzle's is, that can be awaited. */
function recordingDatabase(rows: readonly unknown[] = []) {
  const writes: { kind: 'insert' | 'update'; table: unknown; values: unknown }[] = [];
  const chain = (result: unknown): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) => resolve(result),
    };
    for (const method of ['from', 'where', 'for', 'orderBy', 'limit', 'returning']) {
      self[method] = () => self;
    }
    return self;
  };
  const tx = {
    select: () => chain(rows),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ kind: 'insert', table, values });
        return chain([{ ...row(), ...values }]);
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ kind: 'update', table, values });
        return chain([{ ...(rows[0] as object), ...values }]);
      },
    }),
  };
  return { database: { tx } as unknown as AppDatabase, writes };
}

const refused = (code: string) => expect.objectContaining({ code });
const validCreate: CreateModelProfile = {
  provider_kind: 'openai_hosted',
  model_id: 'a-model',
  alias: 'A model',
  endpoint_url: 'https://api.openai.com/v1',
  billing_owner: 'customer',
  region: null,
  capabilities: ['text'],
  limits: { max_input_tokens: 1024, max_output_tokens: 128 },
  allowed_classes: ['public'],
  allowed_purposes: ['reason'],
  retention_basis: 'unreviewed',
  contract_ref: null,
  fallback_profile_ids: [],
};

afterEach(() => vi.clearAllMocks());

describe('who can do what', () => {
  const untouched = { tx: undefined } as unknown as AppDatabase;
  it.each([
    ['create', () => createModelProfile(untouched, member, validCreate)],
    ['list', () => listModelProfiles(untouched, member)],
    ['read', () => getModelProfile(untouched, member, PROFILE)],
    [
      'update',
      () =>
        updateModelProfile(untouched, member, {
          profileId: PROFILE,
          patch: { expected_version: 1, alias: 'x' },
        }),
    ],
    [
      'prepare a key',
      () =>
        prepareModelKeyCapture(untouched, member, {
          profileId: PROFILE,
          expectedVersion: 1,
          reviewInterlock: 'review-ref',
        }),
    ],
    [
      'attach a key',
      () =>
        attachModelKey(untouched, member, {
          profileId: PROFILE,
          expectedVersion: 1,
          secretRef: CANARY_REF,
          reviewInterlock: 'review-ref',
        }),
    ],
    [
      'ask for a probe',
      () => requestModelProbe(untouched, member, { profileId: PROFILE, expectedVersion: 1 }),
    ],
    [
      'disable',
      () => disableModelProfile(untouched, member, { profileId: PROFILE, expectedVersion: 1 }),
    ],
    [
      'add a rate card',
      () =>
        addRateCard(untouched, member, {
          profileId: PROFILE,
          inputMicrosPerMtok: 1,
          outputMicrosPerMtok: 1,
        }),
    ],
    ['read a rate card', () => latestRateCardFor(untouched, member, PROFILE)],
  ])('a member cannot %s, and the database is never asked', async (_name, attempt) => {
    await expect(attempt()).rejects.toEqual(refused('FORBIDDEN'));
  });
});

describe('what a view shows', () => {
  it('says a key is on file, and carries neither its reference nor any other extra', () => {
    const view = toModelProfileView(row({ secretRef: CANARY_REF }));
    expect(view.has_credential).toBe(true);
    expect(JSON.stringify(view)).not.toContain(CANARY_REF);
    expect(Object.keys(view)).not.toContain('secret_ref');
    expect(Object.keys(view)).not.toContain('secretRef');
    expect(Object.keys(view)).not.toContain('cross_billing_approved_by_membership_id');
  });

  it('says when no key is on file', () => {
    expect(toModelProfileView(row()).has_credential).toBe(false);
  });

  it('refuses to show a row whose limits are not what they should be', () => {
    expect(() => toModelProfileView(row({ limits: { maxInputTokens: 'lots' } }))).toThrow();
  });
});

describe('what routing reads', () => {
  it.each<[ProviderKind, 'customer' | 'ensemus', string]>([
    ['openai_hosted', 'customer', 'customer_byom_public_api'],
    ['anthropic_hosted', 'customer', 'customer_byom_public_api'],
    ['openai_compatible', 'customer', 'customer_byom_public_api'],
    ['openai_hosted', 'ensemus', 'ensemus_cloud_managed_model'],
    ['anthropic_hosted', 'ensemus', 'ensemus_cloud_managed_model'],
    ['openai_compatible', 'ensemus', 'ensemus_cloud_managed_model'],
    ['local_openai_compatible', 'customer', 'customer_private_inference'],
    ['local_openai_compatible', 'ensemus', 'customer_private_inference'],
  ])('%s billed to %s goes under %s', (kind, billing, destination) => {
    expect(destinationFor(kind, billing)).toBe(destination);
    const routable = toRoutableProfile(row({ providerKind: kind, billingOwner: billing }));
    expect(routable.destination).toBe(destination);
  });

  it('counts a fallback across who pays as approved only with a stored approval', () => {
    expect(toRoutableProfile(row()).crossBillingApproved).toBe(false);
    expect(
      toRoutableProfile(row({ crossBillingApprovedByMembershipId: randomUUID() }))
        .crossBillingApproved,
    ).toBe(true);
  });
});

describe('the review interlock (FD-21)', () => {
  it.each<[ProviderKind, boolean]>([
    ['openai_hosted', true],
    ['anthropic_hosted', true],
    // Otherwise a real key could go in by pointing this kind at a provider's own API.
    ['openai_compatible', true],
    ['local_openai_compatible', false],
  ])('%s needing it is %s', (kind, needs) => {
    expect(needsReviewInterlock(kind)).toBe(needs);
  });

  it.each([null, '', '   '])('counts %j as not set', (value) => {
    expect(() => assertKeyMayBeStored('openai_hosted', value)).toThrow(
      refused('MODEL_CREDENTIALS_NOT_REVIEWED'),
    );
  });

  it('lets a key through when the operator gave a reference', () => {
    expect(() => assertKeyMayBeStored('openai_hosted', 'review-2026-01')).not.toThrow();
  });
});

describe('what an address may hold', () => {
  it.each([
    ['a user and password', 'https://user:pass@models.example.invalid/v1'],
    ['a query, where a key could sit', 'https://models.example.invalid/v1?api_key=abc'],
    ['a fragment', 'https://models.example.invalid/v1#abc'],
    ['nothing a URL can be', 'not a url'],
  ])('refuses %s', (_name, url) => {
    expect(endpointHoldsNoSecrets(url)).toBe(false);
  });

  it('accepts a plain address', () => {
    expect(endpointHoldsNoSecrets('https://models.example.invalid/v1')).toBe(true);
  });
});

describe('what can be claimed about retention', () => {
  it.each<
    [ProviderKind, 'unreviewed' | 'contract_recorded' | 'self_hosted', string | null, boolean]
  >([
    ['openai_hosted', 'self_hosted', null, false],
    ['openai_compatible', 'self_hosted', null, false],
    ['local_openai_compatible', 'self_hosted', null, true],
    ['openai_hosted', 'contract_recorded', null, false],
    ['openai_hosted', 'contract_recorded', 'ref-1', true],
    ['openai_hosted', 'unreviewed', null, true],
  ])('%s with %s and reference %s is %s', (providerKind, retentionBasis, contractRef, holds) => {
    expect(retentionHolds({ providerKind, retentionBasis, contractRef })).toBe(holds);
  });
});

describe('asking for a test', () => {
  it('needs a key where a provider needs one', () => {
    expect(probeRefusal({ providerKind: 'openai_hosted', secretRef: null })).toBe('INVALID_STATE');
    expect(probeRefusal({ providerKind: 'openai_compatible', secretRef: null })).toBe(
      'INVALID_STATE',
    );
    expect(probeRefusal({ providerKind: 'openai_hosted', secretRef: CANARY_REF })).toBeNull();
  });

  it('does not need one for a local model', () => {
    expect(probeRefusal({ providerKind: 'local_openai_compatible', secretRef: null })).toBeNull();
  });
});

describe('patching', () => {
  it('sets only what the patch names', () => {
    expect(patchColumns({ expected_version: 1, alias: 'New name' })).toEqual({
      alias: 'New name',
    });
  });

  it('can clear a nullable field', () => {
    expect(patchColumns({ expected_version: 1, region: null, contract_ref: null })).toEqual({
      region: null,
      contractRef: null,
    });
  });

  it('removes repeats', () => {
    expect(patchColumns({ expected_version: 1, capabilities: ['text', 'text'] })).toEqual({
      capabilities: ['text'],
    });
  });
});

describe('creating', () => {
  it('refuses an arbitrary address for a hosted kind, and writes nothing', async () => {
    const { database, writes } = recordingDatabase();
    await expect(
      createModelProfile(database, owner, {
        ...validCreate,
        endpoint_url: 'https://attacker.example.invalid/v1',
      }),
    ).rejects.toEqual(refused('MODEL_ENDPOINT_NOT_ALLOWED'));
    expect(writes).toEqual([]);
  });

  it('refuses a private address unless the operator listed it', async () => {
    const local: CreateModelProfile = {
      ...validCreate,
      provider_kind: 'local_openai_compatible',
      endpoint_url: 'http://models.example.invalid:8080/v1',
      retention_basis: 'self_hosted',
    };
    await expect(createModelProfile(recordingDatabase().database, owner, local)).rejects.toEqual(
      refused('MODEL_ENDPOINT_NOT_ALLOWED'),
    );
    const allowed = recordingDatabase();
    const view = await createModelProfile(allowed.database, owner, local, {
      privateEndpoints: ['http://models.example.invalid:8080'],
    });
    expect(view.status).toBe('draft');
    expect(allowed.writes.map((write) => write.table)).toEqual([modelProfiles, auditEvents]);
  });

  it('refuses a request with a field the contract does not have', async () => {
    const { database, writes } = recordingDatabase();
    await expect(
      createModelProfile(database, owner, {
        ...validCreate,
        secret_ref: CANARY_REF,
      } as typeof validCreate),
    ).rejects.toEqual(refused('INVALID_INPUT'));
    expect(writes).toEqual([]);
  });

  it('refuses a fallback that is not one of this tenant’s profiles', async () => {
    const { database, writes } = recordingDatabase([]);
    await expect(
      createModelProfile(database, owner, {
        ...validCreate,
        fallback_profile_ids: [randomUUID()],
      }),
    ).rejects.toEqual(refused('INVALID_INPUT'));
    expect(writes).toEqual([]);
  });
});

describe('updating', () => {
  const profile = row({
    providerKind: 'openai_hosted',
    endpointUrl: 'https://api.openai.com/v1',
    retentionBasis: 'unreviewed',
    secretRef: CANARY_REF,
  });

  it('refuses an arbitrary address for a hosted kind, and writes nothing', async () => {
    const { database, writes } = recordingDatabase([profile]);
    await expect(
      updateModelProfile(database, owner, {
        profileId: PROFILE,
        patch: { expected_version: 3, endpoint_url: 'https://attacker.example.invalid/v1' },
      }),
    ).rejects.toEqual(refused('MODEL_ENDPOINT_NOT_ALLOWED'));
    expect(writes).toEqual([]);
  });

  it('refuses a stale version', async () => {
    const { database, writes } = recordingDatabase([profile]);
    await expect(
      updateModelProfile(database, owner, {
        profileId: PROFILE,
        patch: { expected_version: 2, alias: 'New' },
      }),
    ).rejects.toEqual(refused('VERSION_CONFLICT'));
    expect(writes).toEqual([]);
  });

  it('cannot be given a status, a kind or a reference', async () => {
    for (const extra of [
      { status: 'active' },
      { provider_kind: 'openai_compatible' },
      { secret_ref: CANARY_REF },
      { qualified_at: new Date().toISOString() },
    ]) {
      const { database, writes } = recordingDatabase([profile]);
      await expect(
        updateModelProfile(database, owner, {
          profileId: PROFILE,
          patch: { expected_version: 3, ...extra },
        }),
      ).rejects.toEqual(refused('INVALID_INPUT'));
      expect(writes).toEqual([]);
    }
  });

  it('records that a changed address voided the key', async () => {
    const { database, writes } = recordingDatabase([
      row({
        providerKind: 'openai_compatible',
        endpointUrl: 'https://one.example.invalid/v1',
        retentionBasis: 'unreviewed',
        secretRef: CANARY_REF,
      }),
    ]);
    await updateModelProfile(database, owner, {
      profileId: PROFILE,
      patch: { expected_version: 3, endpoint_url: 'https://two.example.invalid/v1' },
    });
    const actions = writes
      .filter((write) => write.table === auditEvents)
      .map((write) => (write.values as { action: string }).action);
    expect(actions).toEqual(['model_profile.updated', 'model_profile.key_voided']);
  });

  it('does not void anything when the address is the same', async () => {
    const { database, writes } = recordingDatabase([profile]);
    await updateModelProfile(database, owner, {
      profileId: PROFILE,
      patch: { expected_version: 3, endpoint_url: 'https://api.openai.com/v1' },
    });
    const actions = writes
      .filter((write) => write.table === auditEvents)
      .map((write) => (write.values as { action: string }).action);
    expect(actions).toEqual(['model_profile.updated']);
  });
});

describe('taking a key', () => {
  const hosted = row({
    providerKind: 'anthropic_hosted',
    endpointUrl: 'https://api.anthropic.com',
    retentionBasis: 'unreviewed',
  });

  it('refuses before anything is sealed when the interlock is not set', async () => {
    const { database } = recordingDatabase([hosted]);
    await expect(
      prepareModelKeyCapture(database, owner, {
        profileId: PROFILE,
        expectedVersion: 3,
        reviewInterlock: null,
      }),
    ).rejects.toEqual(refused('MODEL_CREDENTIALS_NOT_REVIEWED'));
  });

  it('refuses a stale version before anything is sealed', async () => {
    const { database } = recordingDatabase([row()]);
    await expect(
      prepareModelKeyCapture(database, owner, {
        profileId: PROFILE,
        expectedVersion: 2,
        reviewInterlock: null,
      }),
    ).rejects.toEqual(refused('VERSION_CONFLICT'));
  });

  it('answers not found for a profile RLS does not show', async () => {
    const { database } = recordingDatabase([]);
    await expect(
      prepareModelKeyCapture(database, owner, {
        profileId: PROFILE,
        expectedVersion: 3,
        reviewInterlock: null,
      }),
    ).rejects.toEqual(refused('NOT_FOUND'));
  });

  it('seals under a purpose naming this profile and address', async () => {
    const { database } = recordingDatabase([row()]);
    await expect(
      prepareModelKeyCapture(database, owner, {
        profileId: PROFILE,
        expectedVersion: 3,
        reviewInterlock: null,
      }),
    ).resolves.toEqual({ purpose: modelKeyPurpose(PROFILE, row().endpointUrl) });
  });

  it('refuses again as the reference is attached, and writes nothing', async () => {
    const { database, writes } = recordingDatabase([hosted]);
    await expect(
      attachModelKey(database, owner, {
        profileId: PROFILE,
        expectedVersion: 3,
        secretRef: CANARY_REF,
        reviewInterlock: null,
      }),
    ).rejects.toEqual(refused('MODEL_CREDENTIALS_NOT_REVIEWED'));
    expect(writes).toEqual([]);
  });

  it('refuses a reference that is not an ID, so a key pasted there goes nowhere', async () => {
    const { database, writes } = recordingDatabase([row()]);
    await expect(
      attachModelKey(database, owner, {
        profileId: PROFILE,
        expectedVersion: 3,
        secretRef: 'pasted-key-value',
        reviewInterlock: null,
      }),
    ).rejects.toEqual(refused('INVALID_INPUT'));
    expect(writes).toEqual([]);
  });

  it('answers with a view that holds no reference', async () => {
    const { database } = recordingDatabase([row()]);
    const view = await attachModelKey(database, owner, {
      profileId: PROFILE,
      expectedVersion: 3,
      secretRef: CANARY_REF,
      reviewInterlock: null,
    });
    expect(view.has_credential).toBe(true);
    expect(JSON.stringify(view)).not.toContain(CANARY_REF);
  });
});

describe('asking for a probe', () => {
  it('refuses a missing interactive proof before any profile write', async () => {
    const { database, writes } = recordingDatabase([row()]);
    vi.mocked(assertInteractivePrivilege).mockRejectedValueOnce(new AppError('MFA_REQUIRED'));
    await expect(
      requestModelProbe(database, owner, { profileId: PROFILE, expectedVersion: 3 }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    expect(writes).toEqual([]);
  });
  it('moves to probing and emits its event, in one transaction', async () => {
    const { database, writes } = recordingDatabase([row()]);
    await requestModelProbe(database, owner, { profileId: PROFILE, expectedVersion: 3 });
    expect(writes.map((write) => write.table)).toEqual([
      modelProfiles,
      domainEvents,
      outboxEvents,
      auditEvents,
    ]);
    expect(writes[0]?.values).toMatchObject({
      status: 'probing',
      probeRequestedByMembershipId: owner.membershipId,
    });
    expect(writes[1]?.values).toMatchObject({
      eventType: MODEL_PROFILE_PROBE_REQUESTED,
      aggregateType: 'model_profile',
      aggregateId: PROFILE,
      payload: {},
    });
  });

  it('can be asked again while a test is said to be running, which is the way out of one that died', async () => {
    const { database, writes } = recordingDatabase([row({ status: 'probing' })]);
    await requestModelProbe(database, owner, { profileId: PROFILE, expectedVersion: 3 });
    expect(writes.map((write) => write.table)).toContain(domainEvents);
  });

  it.each([
    ['a stale version', row(), 2, 'VERSION_CONFLICT'],
    [
      'a provider with no key',
      row({ providerKind: 'openai_hosted', secretRef: null }),
      3,
      'INVALID_STATE',
    ],
  ])('refuses %s and emits nothing', async (_name, profile, expectedVersion, code) => {
    const { database, writes } = recordingDatabase([profile]);
    await expect(
      requestModelProbe(database, owner, { profileId: PROFILE, expectedVersion }),
    ).rejects.toEqual(refused(code));
    expect(writes).toEqual([]);
  });

  it('answers not found for an ID that cannot exist', async () => {
    const { database } = recordingDatabase([]);
    await expect(
      requestModelProbe(database, owner, { profileId: 'nonsense', expectedVersion: 3 }),
    ).rejects.toEqual(refused('NOT_FOUND'));
  });
});

describe('disabling', () => {
  it('turning off what is already off does nothing', async () => {
    const { database, writes } = recordingDatabase([row({ status: 'disabled' })]);
    await disableModelProfile(database, owner, { profileId: PROFILE, expectedVersion: 3 });
    expect(writes).toEqual([]);
  });

  it('writes the status, its event and the audit row', async () => {
    const { database, writes } = recordingDatabase([row({ status: 'active' })]);
    await disableModelProfile(database, owner, { profileId: PROFILE, expectedVersion: 3 });
    expect(writes[0]?.values).toMatchObject({ status: 'disabled' });
    expect(writes.map((write) => write.table)).toEqual([
      modelProfiles,
      domainEvents,
      outboxEvents,
      auditEvents,
    ]);
  });
});

describe('rate cards', () => {
  it.each([
    ['a negative price', -1],
    ['a fraction of a micro-dollar', 1.5],
    ['more than an integer can hold', 2 ** 60],
  ])('refuses %s', async (_name, inputMicrosPerMtok) => {
    const { database, writes } = recordingDatabase([row()]);
    await expect(
      addRateCard(database, owner, {
        profileId: PROFILE,
        inputMicrosPerMtok,
        outputMicrosPerMtok: 1,
      }),
    ).rejects.toEqual(refused('INVALID_INPUT'));
    expect(writes).toEqual([]);
  });

  it('answers not found for a profile RLS does not show, and writes nothing', async () => {
    const { database, writes } = recordingDatabase([]);
    await expect(
      addRateCard(database, owner, {
        profileId: PROFILE,
        inputMicrosPerMtok: 5,
        outputMicrosPerMtok: 9,
      }),
    ).rejects.toEqual(refused('NOT_FOUND'));
    expect(writes).toEqual([]);
  });

  it('is always the tenant’s own estimate', async () => {
    const { database, writes } = recordingDatabase([row()]);
    await addRateCard(database, owner, {
      profileId: PROFILE,
      inputMicrosPerMtok: 5,
      outputMicrosPerMtok: 9,
    });
    expect(writes[0]?.values).toMatchObject({
      inputMicrosPerMtok: 5,
      outputMicrosPerMtok: 9,
      source: 'tenant_estimate',
    });
  });
});
