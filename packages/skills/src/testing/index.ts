// Test doubles and generators. Lint keeps this out of anything that ships, and a package built from these
// is signed with a key generated on the spot. Owned by the skill-format slice.
import { createHash, generateKeyPairSync } from 'node:crypto';
import type { SkillBundle, SkillManifest } from '@ensemus/contracts/skills';
import { keyIdOf } from '@ensemus/skills/signature';
import { signSkillDigest } from '@ensemus/skills/sign';
import { manifestDigest } from '@ensemus/skills/bundle';

export type TestKeyPair = { publicKey: Buffer; privateKeyPem: string; keyId: string };

/** A fresh Ed25519 pair. Never stored and never reused between runs. */
export function generateTestKey(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return {
    publicKey: raw,
    keyId: keyIdOf(raw),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
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
export function buildTestBundle(options: TestBundleOptions): {
  bundle: SkillBundle;
  bytes: Buffer;
  digest: string;
} {
  const files = new Map<string, Buffer>([
    ['instructions.md', Buffer.from('Generated test instructions. No real data.')],
  ]);
  const fixtures = options.fixtures ?? [
    { input: { sample: true }, expectedOutput: { sample: true } },
  ];
  const tests = fixtures.map((fixture, position) => {
    const input = `tests/${position}-input.json`,
      expected_output = `tests/${position}-output.json`;
    files.set(input, Buffer.from(JSON.stringify(fixture.input)));
    files.set(expected_output, Buffer.from(JSON.stringify(fixture.expectedOutput)));
    return { name: `Generated fixture ${position + 1}`, input, expected_output };
  });
  if (options.source !== undefined) files.set('main.js', Buffer.from(options.source));
  const manifest: SkillManifest = {
    schema_version: 1,
    name: options.name ?? 'generated-skill',
    version: options.version ?? '1.0.0',
    display_name: 'Generated skill',
    summary: 'A generated test, not a distributed package.',
    license: options.license ?? 'MIT',
    instructions: 'instructions.md',
    input_schema: {},
    output_schema: {},
    tool_boundaries: [],
    max_classification: 'internal',
    dependencies: [],
    tests,
    execution:
      options.source === undefined
        ? { kind: 'declarative' }
        : {
            kind: 'sandbox',
            runtime: 'node24',
            entry: 'main.js',
            network: { mode: 'none' },
            limits: {
              wall_ms: 30_000,
              cpu_ms: 20_000,
              memory_mb: 256,
              tmpfs_mb: 64,
              output_kb: 1024,
              pids: 32,
            },
          },
    files: [...files].map(([path, bytes]) => ({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size_bytes: bytes.length,
    })),
  };
  const digest = manifestDigest(manifest);
  const bundle: SkillBundle = {
    format: 'ensemus.skill.bundle.v1',
    manifest: options.tamper?.(manifest) ?? manifest,
    files: [...files].map(([path, bytes]) => ({ path, content_base64: bytes.toString('base64') })),
    signature: {
      algorithm: 'ed25519',
      key_id: options.key.keyId,
      value_base64: signSkillDigest({ digest, privateKeyPem: options.key.privateKeyPem }).toString(
        'base64',
      ),
    },
  };
  return { bundle, bytes: Buffer.from(JSON.stringify(bundle)), digest };
}
