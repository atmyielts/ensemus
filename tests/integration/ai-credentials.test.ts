// SEC-11, SEC-016, TR-022, FD-10, FD-21: sealing and lending as real roles. Needs the stack, so it counts as
// unverified until the owner runs it. Web's role seals, the secrets role opens, and each tenant is on its own
// connection through RLS. Generated test values only.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { modelProfiles, openAppDatabase, withTenantTx } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { modelKeyPurpose } from '@ensemus/domain/ai-binding';
import { createCredentialLender, type ProfileKeyRef } from '@ensemus/intelligence';
import { FileKeyProvider, SecretBroker, SecretUnavailable } from '@ensemus/secrets/broker';
import { storeSecret } from '@ensemus/secrets/seal';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { holdsCanary, throwawayModelKey } from '../helpers/ai/canaries';
import { seedAiTenant, seedDraftProfile, type AiTenant } from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

const ENDPOINT = 'http://10.0.0.5:11434/v1';

describe('model credentials as real roles', () => {
  // A key pair for this test alone, so nothing here depends on the deployment's sealing key.
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  let app: ReturnType<typeof openAppDatabase>;
  let secrets: ReturnType<typeof openSecretsDatabase>;
  let broker: SecretBroker;
  let tenantA: AiTenant;
  let tenantB: AiTenant;

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    secrets = openSecretsDatabase(urls.secrets());
    broker = new SecretBroker(secrets.db, new FileKeyProvider([privateKeyPem]));
    // Same name on purpose: nothing may tell two tenants apart by a label.
    tenantA = await seedAiTenant(app.db);
    tenantB = await seedAiTenant(app.db);
  });

  afterAll(async () => {
    await app?.close();
    await secrets?.close();
  });

  const lender = (reviewInterlock: string | null = null) =>
    createCredentialLender({ secrets: broker, reviewInterlock });

  async function sealFor(
    tenant: AiTenant,
    endpointUrl = ENDPOINT,
    plaintext = throwawayModelKey(),
  ) {
    const profileId = await seedDraftProfile(app.db, tenant.owner, { endpointUrl });
    const { secretRef } = await storeSecret(app.db, tenant.owner, {
      publicKeyPem,
      purpose: modelKeyPurpose(profileId, endpointUrl),
      plaintext,
    });
    await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.update(modelProfiles).set({ secretRef }).where(eq(modelProfiles.id, profileId)),
    );
    const ref: ProfileKeyRef = {
      organizationId: tenant.organizationId,
      profileId,
      endpointUrl,
      secretRef,
      providerKind: 'local_openai_compatible',
    };
    return { ref, plaintext };
  }

  it('lends the key sealed by the web role, to the secrets role', async () => {
    const { ref, plaintext } = await sealFor(tenantA);
    await expect(lender().withKey(ref, async (key) => key.toString())).resolves.toBe(plaintext);
  });

  it('wipes the buffer when the call returns, and when it throws', async () => {
    const { ref } = await sealFor(tenantA);
    let kept: Buffer | undefined;
    await lender().withKey(ref, async (key) => {
      kept = key;
    });
    expect(kept?.every((byte) => byte === 0)).toBe(true);
    await expect(
      lender().withKey(ref, async (key) => {
        kept = key;
        throw new Error('adapter bug');
      }),
    ).rejects.toThrow('adapter bug');
    expect(kept?.every((byte) => byte === 0)).toBe(true);
  });

  it('a key under a changed endpoint digest yields SecretUnavailable', async () => {
    const { ref } = await sealFor(tenantA);
    const use = vi.fn(async () => undefined);
    await expect(
      lender().withKey({ ...ref, endpointUrl: 'https://evil.example/v1' }, use),
    ).rejects.toBeInstanceOf(SecretUnavailable);
    expect(use).not.toHaveBeenCalled();
  });

  it('another tenant cannot open it, even holding the reference', async () => {
    const { ref } = await sealFor(tenantA);
    const use = vi.fn(async () => undefined);
    await expect(
      lender().withKey({ ...ref, organizationId: tenantB.organizationId }, use),
    ).rejects.toBeInstanceOf(SecretUnavailable);
    expect(use).not.toHaveBeenCalled();
  });

  it('another profile cannot open it', async () => {
    const { ref } = await sealFor(tenantA);
    const use = vi.fn(async () => undefined);
    await expect(lender().withKey({ ...ref, profileId: randomUUID() }, use)).rejects.toBeInstanceOf(
      SecretUnavailable,
    );
    expect(use).not.toHaveBeenCalled();
  });

  it('a secret sealed for another purpose cannot be opened as a model key', async () => {
    const profileId = await seedDraftProfile(app.db, tenantA.owner, { endpointUrl: ENDPOINT });
    const { secretRef } = await storeSecret(app.db, tenantA.owner, {
      publicKeyPem,
      purpose: 'connector.credential',
      plaintext: throwawayModelKey(),
    });
    await expect(
      lender().withKey(
        {
          organizationId: tenantA.organizationId,
          profileId,
          endpointUrl: ENDPOINT,
          secretRef,
          providerKind: 'local_openai_compatible',
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(SecretUnavailable);
  });

  it('a revoked key cannot be opened', async () => {
    const { ref } = await sealFor(tenantA);
    await broker.revoke(ref.organizationId, ref.secretRef);
    await expect(lender().withKey(ref, async () => undefined)).rejects.toBeInstanceOf(
      SecretUnavailable,
    );
  });

  it('refuses a hosted kind with no interlock, before asking the database', async () => {
    const { ref } = await sealFor(tenantA);
    const opened = vi.spyOn(broker, 'withSecret');
    await expect(
      lender(null).withKey({ ...ref, providerKind: 'anthropic_hosted' }, async () => undefined),
    ).rejects.toMatchObject({ code: 'MODEL_CREDENTIALS_NOT_REVIEWED' });
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
  });

  it('the web role cannot read a sealed key back', async () => {
    await sealFor(tenantA);
    const refusal = await withTenantTx(app.db, tenantA.owner, (tx) =>
      tx.execute('select * from secrets.sealed_secrets'),
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
  });

  it('the profile row holds a reference and not the key', async () => {
    const { ref, plaintext } = await sealFor(tenantA);
    const rows = await withTenantTx(app.db, tenantA.owner, (tx) =>
      tx.select().from(modelProfiles).where(eq(modelProfiles.id, ref.profileId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secretRef).toBe(ref.secretRef);
    expect(holdsCanary(JSON.stringify(rows), plaintext)).toBe(false);
  });

  it('changing the endpoint clears the reference, back to draft, with a new version', async () => {
    const { ref } = await sealFor(tenantA);
    const [before] = await withTenantTx(app.db, tenantA.owner, (tx) =>
      tx.select().from(modelProfiles).where(eq(modelProfiles.id, ref.profileId)),
    );
    await withTenantTx(app.db, tenantA.owner, (tx) =>
      tx
        .update(modelProfiles)
        .set({ endpointUrl: 'http://10.0.0.6:11434/v1' })
        .where(eq(modelProfiles.id, ref.profileId)),
    );
    const [after] = await withTenantTx(app.db, tenantA.owner, (tx) =>
      tx.select().from(modelProfiles).where(eq(modelProfiles.id, ref.profileId)),
    );
    expect(after?.secretRef).toBeNull();
    expect(after?.status).toBe('draft');
    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });

  it('another tenant cannot see the profile that names the reference', async () => {
    const { ref } = await sealFor(tenantA);
    const rows = await withTenantTx(app.db, tenantB.owner, (tx) =>
      tx.select().from(modelProfiles).where(eq(modelProfiles.id, ref.profileId)),
    );
    expect(rows).toHaveLength(0);
  });
});
