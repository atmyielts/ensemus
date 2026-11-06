// FD-10 and FD-21 at the lender. The real sealing crypto runs in tests/conformance/credential-lender.suite.ts,
// which can reach @ensemus/secrets. Here a lease records what it was asked, and opens only what matches.
import { randomUUID } from 'node:crypto';
import { modelKeyPurpose } from '@ensemus/domain/ai-binding';
import type { ProviderKind } from '@ensemus/domain/ai';
import { describe, expect, it } from 'vitest';
import { createCredentialLender, CredentialsNotReviewed } from './credentials';
import type { ProfileKeyRef } from './types';

class SecretUnavailableDouble extends Error {}

/** Holds one key under the exact binding it was sealed for, as AES-GCM additional data would. */
function leaseFor(sealedFor: { organizationId: string; secretId: string; purpose: string }) {
  const asked: { organizationId: string; secretId: string; purpose: string }[] = [];
  return {
    asked,
    async withSecret<T>(
      binding: { organizationId: string; secretId: string; purpose: string },
      use: (secret: Buffer) => Promise<T>,
    ): Promise<T> {
      asked.push(binding);
      const matches =
        binding.organizationId === sealedFor.organizationId &&
        binding.secretId === sealedFor.secretId &&
        binding.purpose === sealedFor.purpose;
      if (!matches) throw new SecretUnavailableDouble();
      return use(Buffer.from('generated-test-value'));
    },
    revoke: () => Promise.resolve(),
  };
}

const ENDPOINT = 'http://10.0.0.5:11434/v1';

function ref(overrides: Partial<ProfileKeyRef> = {}): ProfileKeyRef {
  return {
    organizationId: randomUUID(),
    profileId: randomUUID(),
    endpointUrl: ENDPOINT,
    secretRef: randomUUID(),
    providerKind: 'local_openai_compatible',
    ...overrides,
  };
}

const bindingOf = (profile: ProfileKeyRef) => ({
  organizationId: profile.organizationId,
  secretId: profile.secretRef,
  purpose: modelKeyPurpose(profile.profileId, profile.endpointUrl),
});

describe('the review interlock (FD-21)', () => {
  it.each<ProviderKind>(['openai_hosted', 'anthropic_hosted'])(
    'refuses %s with no interlock, and never asks the broker',
    async (providerKind) => {
      const profile = ref({ providerKind, endpointUrl: 'https://api.openai.com/v1' });
      const lease = leaseFor(bindingOf(profile));
      const lender = createCredentialLender({ secrets: lease, reviewInterlock: null });
      let used = false;
      await expect(
        lender.withKey(profile, async () => {
          used = true;
        }),
      ).rejects.toBeInstanceOf(CredentialsNotReviewed);
      expect(used).toBe(false);
      expect(lease.asked).toHaveLength(0);
    },
  );

  it.each(['', '   ', '\t'])('treats a blank interlock, %j, as not set', async (value) => {
    const profile = ref({ providerKind: 'openai_hosted' });
    const lease = leaseFor(bindingOf(profile));
    const lender = createCredentialLender({ secrets: lease, reviewInterlock: value });
    await expect(lender.withKey(profile, async () => undefined)).rejects.toMatchObject({
      code: 'MODEL_CREDENTIALS_NOT_REVIEWED',
    });
    expect(lease.asked).toHaveLength(0);
  });

  it('lends a hosted key once the interlock names a review', async () => {
    const profile = ref({ providerKind: 'anthropic_hosted' });
    const lender = createCredentialLender({
      secrets: leaseFor(bindingOf(profile)),
      reviewInterlock: 'review-reference',
    });
    await expect(lender.withKey(profile, async () => 'used')).resolves.toBe('used');
  });

  it.each<ProviderKind>(['local_openai_compatible', 'openai_compatible'])(
    'does not hold back %s, which needs no review',
    async (providerKind) => {
      const profile = ref({ providerKind });
      const lender = createCredentialLender({
        secrets: leaseFor(bindingOf(profile)),
        reviewInterlock: null,
      });
      await expect(lender.withKey(profile, async () => 'used')).resolves.toBe('used');
    },
  );
});

describe('what the key is bound to (FD-10)', () => {
  it('asks for the purpose derived from the profile and endpoint, under the row tenant', async () => {
    const profile = ref();
    const lease = leaseFor(bindingOf(profile));
    await createCredentialLender({ secrets: lease, reviewInterlock: null }).withKey(
      profile,
      async () => undefined,
    );
    expect(lease.asked).toEqual([bindingOf(profile)]);
    expect(lease.asked[0]?.purpose).toMatch(/^model_key:[0-9a-f-]+:[0-9a-f]{64}$/);
  });

  it('a changed endpoint asks under a different purpose, so the key stays shut', async () => {
    const sealed = ref();
    const lease = leaseFor(bindingOf(sealed));
    const lender = createCredentialLender({ secrets: lease, reviewInterlock: null });
    let used = false;
    for (const endpointUrl of [
      'https://evil.example/v1',
      'http://10.0.0.5:11434/v2',
      'http://10.0.0.5:11435/v1',
      'https://10.0.0.5:11434/v1',
    ]) {
      await expect(
        lender.withKey({ ...sealed, endpointUrl }, async () => {
          used = true;
        }),
      ).rejects.toBeInstanceOf(SecretUnavailableDouble);
    }
    expect(used).toBe(false);
  });

  it('another profile, another tenant or another secret stays shut', async () => {
    const sealed = ref();
    const lease = leaseFor(bindingOf(sealed));
    const lender = createCredentialLender({ secrets: lease, reviewInterlock: null });
    for (const other of [
      { ...sealed, profileId: randomUUID() },
      { ...sealed, organizationId: randomUUID() },
      { ...sealed, secretRef: randomUUID() },
    ]) {
      await expect(lender.withKey(other, async () => undefined)).rejects.toBeInstanceOf(
        SecretUnavailableDouble,
      );
    }
  });
});

describe('wiping the buffer', () => {
  it('zeroes the key when use returns', async () => {
    const profile = ref();
    const lender = createCredentialLender({
      secrets: leaseFor(bindingOf(profile)),
      reviewInterlock: null,
    });
    let kept: Buffer | undefined;
    await lender.withKey(profile, async (key) => {
      kept = key;
      expect(key.toString()).toBe('generated-test-value');
    });
    expect(kept?.every((byte) => byte === 0)).toBe(true);
  });

  it('zeroes the key when use throws, and passes the error on', async () => {
    const profile = ref();
    const lender = createCredentialLender({
      secrets: leaseFor(bindingOf(profile)),
      reviewInterlock: null,
    });
    let kept: Buffer | undefined;
    await expect(
      lender.withKey(profile, async (key) => {
        kept = key;
        throw new Error('adapter bug');
      }),
    ).rejects.toThrow('adapter bug');
    expect(kept?.every((byte) => byte === 0)).toBe(true);
  });
});
