// Test doubles and generators. Lint keeps this out of anything that ships, and a package built from these
// is signed with a key generated on the spot. Owned by the skill-format slice.
import type { SkillBundle, SkillManifest } from '@ensemus/contracts/skills';

export type TestKeyPair = { publicKey: Buffer; privateKeyPem: string; keyId: string };

/** A fresh Ed25519 pair. Never stored and never reused between runs. */
export function generateTestKey(): TestKeyPair {
  throw new Error('NOT_IMPLEMENTED');
}

export type TestBundleOptions = {
  key: TestKeyPair;
  name?: string;
  version?: string;
  /** A sandbox package with this source as its entry point. Declarative if left out. */
  source?: string;
  fixtures?: ReadonlyArray<{ input: unknown; expectedOutput: unknown }>;
  license?: string;
  /** Changes the manifest after signing, to prove the signature notices. */
  tamper?: (manifest: SkillManifest) => SkillManifest;
};

/** A complete, correctly signed bundle. */
export function buildTestBundle(_options: TestBundleOptions): {
  bundle: SkillBundle;
  bytes: Buffer;
  digest: string;
} {
  throw new Error('NOT_IMPLEMENTED');
}
