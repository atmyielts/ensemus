// The lender over the real sealing crypto, with no database: `sealSecret` as web uses it and `openSealed` as
// SecretBroker uses it, with an in-memory row in place of `secrets.sealed_secrets`. The same checks as real
// roles are in tests/integration/ai-credentials.test.ts, which needs containers and is unverified.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { SecretLease } from '@ensemus/application';
import { modelKeyPurpose } from '@ensemus/domain/ai-binding';
import {
  createCredentialLender,
  createEndpointGuard,
  createModelAdapter,
  type ProfileKeyRef,
} from '@ensemus/intelligence';
import { FileKeyProvider, openSealed, SecretUnavailable } from '@ensemus/secrets/broker';
import { sealSecret } from '@ensemus/secrets/seal';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { holdsCanary, throwawayModelKey } from '../helpers/ai/canaries';
import { startFakeModel, type FakeModel } from './fake-model';

type Row = ReturnType<typeof sealSecret> & { organizationId: string; id: string; purpose: string };

function vault() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const provider = new FileKeyProvider([privateKeyPem]);
  const rows = new Map<string, Row>();
  let opened = 0;

  const seal = (input: { organizationId: string; purpose: string; plaintext: string }) => {
    const secretId = randomUUID();
    const sealed = sealSecret({ publicKeyPem, secretId, ...input });
    rows.set(`${input.organizationId}/${secretId}`, {
      ...sealed,
      organizationId: input.organizationId,
      id: secretId,
      purpose: input.purpose,
    });
    return secretId;
  };

  // The body of SecretBroker.withSecret, with a map for the database read. RLS scopes that read to the
  // tenant, which is what the composite key does here.
  const lease: SecretLease = {
    async withSecret(binding, use) {
      const row = rows.get(`${binding.organizationId}/${binding.secretId}`);
      if (!row || row.purpose !== binding.purpose) throw new SecretUnavailable();
      const secret = openSealed(provider, row, binding);
      opened += 1;
      try {
        return await use(secret);
      } finally {
        secret.fill(0);
      }
    },
    revoke: () => Promise.resolve(),
  };

  return { seal, lease, rows, opened: () => opened };
}

const ENDPOINT = 'http://10.0.0.5:11434/v1';

export function describeCredentialLenderOverRealSealing() {
  describe('credential lender over the real sealing', () => {
    function sealedProfile(store: ReturnType<typeof vault>, plaintext = throwawayModelKey()) {
      const organizationId = randomUUID();
      const profileId = randomUUID();
      const secretRef = store.seal({
        organizationId,
        purpose: modelKeyPurpose(profileId, ENDPOINT),
        plaintext,
      });
      const profile: ProfileKeyRef = {
        organizationId,
        profileId,
        secretRef,
        endpointUrl: ENDPOINT,
        providerKind: 'local_openai_compatible',
      };
      return { profile, plaintext };
    }

    it('opens the key for the profile and endpoint it was sealed for', async () => {
      const store = vault();
      const { profile, plaintext } = sealedProfile(store);
      const lender = createCredentialLender({ secrets: store.lease, reviewInterlock: null });
      await expect(lender.withKey(profile, async (key) => key.toString())).resolves.toBe(plaintext);
    });

    it('a key under a changed endpoint digest yields SecretUnavailable', async () => {
      const store = vault();
      const { profile } = sealedProfile(store);
      const lender = createCredentialLender({ secrets: store.lease, reviewInterlock: null });
      const use = vi.fn(async () => undefined);
      for (const endpointUrl of [
        'https://evil.example/v1',
        'http://10.0.0.5:11434/v2',
        'http://10.0.0.5:11435/v1',
      ]) {
        await expect(lender.withKey({ ...profile, endpointUrl }, use)).rejects.toBeInstanceOf(
          SecretUnavailable,
        );
      }
      expect(use).not.toHaveBeenCalled();
    });

    it('a row whose stored purpose was edited to match still fails AES-GCM', async () => {
      // The attack FD-10 names: someone who can write the row changes the endpoint and the purpose. The
      // purpose check passes, and the additional data still says the old one.
      const store = vault();
      const { profile } = sealedProfile(store);
      const lender = createCredentialLender({ secrets: store.lease, reviewInterlock: null });
      const endpointUrl = 'https://evil.example/v1';
      const row = store.rows.get(`${profile.organizationId}/${profile.secretRef}`);
      if (!row) throw new Error('row missing');
      row.purpose = modelKeyPurpose(profile.profileId, endpointUrl);
      await expect(
        lender.withKey({ ...profile, endpointUrl }, async () => undefined),
      ).rejects.toBeInstanceOf(SecretUnavailable);
    });

    it('another tenant cannot open it, even holding the reference', async () => {
      const store = vault();
      const { profile } = sealedProfile(store);
      const lender = createCredentialLender({ secrets: store.lease, reviewInterlock: null });
      await expect(
        lender.withKey({ ...profile, organizationId: randomUUID() }, async () => undefined),
      ).rejects.toBeInstanceOf(SecretUnavailable);
    });

    it('a row copied to another tenant fails, since the tenant is in the additional data', async () => {
      const store = vault();
      const { profile } = sealedProfile(store);
      const other = randomUUID();
      const row = store.rows.get(`${profile.organizationId}/${profile.secretRef}`);
      if (!row) throw new Error('row missing');
      store.rows.set(`${other}/${profile.secretRef}`, { ...row, organizationId: other });
      const lender = createCredentialLender({ secrets: store.lease, reviewInterlock: null });
      await expect(
        lender.withKey({ ...profile, organizationId: other }, async () => undefined),
      ).rejects.toBeInstanceOf(SecretUnavailable);
    });

    it('another purpose cannot be opened as a model key', async () => {
      const store = vault();
      const organizationId = randomUUID();
      const profileId = randomUUID();
      const secretRef = store.seal({
        organizationId,
        purpose: 'connector.credential',
        plaintext: throwawayModelKey(),
      });
      const lender = createCredentialLender({ secrets: store.lease, reviewInterlock: null });
      await expect(
        lender.withKey(
          {
            organizationId,
            profileId,
            secretRef,
            endpointUrl: ENDPOINT,
            providerKind: 'local_openai_compatible',
          },
          async () => undefined,
        ),
      ).rejects.toBeInstanceOf(SecretUnavailable);
    });

    it('another profile on the same endpoint cannot open it', async () => {
      const store = vault();
      const { profile } = sealedProfile(store);
      const lender = createCredentialLender({ secrets: store.lease, reviewInterlock: null });
      await expect(
        lender.withKey({ ...profile, profileId: randomUUID() }, async () => undefined),
      ).rejects.toBeInstanceOf(SecretUnavailable);
    });

    it('a hosted kind is refused before anything is opened, sealed or not', async () => {
      const store = vault();
      const { profile } = sealedProfile(store);
      const lender = createCredentialLender({ secrets: store.lease, reviewInterlock: null });
      await expect(
        lender.withKey({ ...profile, providerKind: 'openai_hosted' }, async () => undefined),
      ).rejects.toMatchObject({ code: 'MODEL_CREDENTIALS_NOT_REVIEWED' });
      expect(store.opened()).toBe(0);
    });

    describe('all the way to a 401 that echoes the key', () => {
      let fake: FakeModel;
      beforeAll(async () => {
        fake = await startFakeModel({ scenario: 'auth_echo' });
      });
      afterAll(() => fake.close());

      it('leaves the canary out of the result, the logs and any error, and wipes the buffer', async () => {
        const store = vault();
        const plaintext = throwawayModelKey();
        const organizationId = randomUUID();
        const profileId = randomUUID();
        const secretRef = store.seal({
          organizationId,
          purpose: modelKeyPurpose(profileId, fake.baseUrl),
          plaintext,
        });
        const lines: string[] = [];
        const keep = (...args: unknown[]) => lines.push(args.map(String).join(' '));
        const spies = [
          vi.spyOn(console, 'log').mockImplementation(keep),
          vi.spyOn(console, 'error').mockImplementation(keep),
          vi.spyOn(console, 'warn').mockImplementation(keep),
        ];
        const lender = createCredentialLender({ secrets: store.lease, reviewInterlock: null });
        const adapter = createModelAdapter();
        const guard = createEndpointGuard();
        let kept: Buffer | undefined;
        try {
          const result = await lender.withKey(
            {
              organizationId,
              profileId,
              secretRef,
              endpointUrl: fake.baseUrl,
              providerKind: 'local_openai_compatible',
            },
            (key) => {
              kept = key;
              return adapter.generate(
                {
                  providerKind: 'local_openai_compatible',
                  modelId: 'm',
                  endpointUrl: fake.baseUrl,
                  messages: [{ role: 'task', partId: 't', text: 'x', classification: 'internal' }],
                  tools: [],
                  responseSchema: null,
                  maxOutputTokens: 8,
                  timeoutMs: 5_000,
                  fetch: guard.fetchFor({
                    host: fake.host,
                    port: fake.port,
                    protocol: 'http:',
                    viaPrivateAllowlist: true,
                  }),
                  apiKey: key,
                },
                new AbortController().signal,
              );
            },
          );
          expect(result).toMatchObject({ kind: 'failure', failure: 'auth_failed' });
          expect(holdsCanary(JSON.stringify(result), plaintext)).toBe(false);
          expect(holdsCanary(lines.join('\n'), plaintext)).toBe(false);
          expect(kept?.every((byte) => byte === 0)).toBe(true);
          // Control: the key really did go out, and the fake really did send it back.
          expect(String(fake.requests[0]?.headers.authorization)).toContain(plaintext);
        } finally {
          spies.forEach((spy) => spy.mockRestore());
        }
      });
    });
  });
}
