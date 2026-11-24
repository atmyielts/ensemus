import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SkillBundle, SkillManifest } from '@ensemus/contracts/skills';
import { canonicalJson } from '@ensemus/domain/approval';
import { SKILL_BUNDLE_MAX_BYTES } from '@ensemus/domain/skill';
import {
  manifestDigest,
  parseSkillBundle,
  matchesSkillSchema,
  readFixtures,
  runContractTests,
} from './bundle';
import { checkManifestSupplyChain, policyForManifest } from './supply-chain';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';

function fixture() {
  const files = new Map([
    ['instructions.md', Buffer.from('A generated test.')],
    ['input.json', Buffer.from('{"count":1}')],
    ['output.json', Buffer.from('{"count":2}')],
    ['empty.txt', Buffer.alloc(0)],
  ]);
  const manifest: SkillManifest = {
    schema_version: 1,
    name: 'sample-skill',
    version: '1.0.0',
    display_name: 'Sample',
    summary: 'Generated test.',
    license: 'MIT',
    instructions: 'instructions.md',
    input_schema: {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 0 } },
      required: ['count'],
      additionalProperties: false,
    },
    output_schema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
      additionalProperties: false,
    },
    tool_boundaries: [],
    max_classification: 'internal',
    dependencies: [],
    execution: { kind: 'declarative' },
    tests: [{ name: 'Adds one', input: 'input.json', expected_output: 'output.json' }],
    files: [...files].map(([path, bytes]) => ({
      path,
      size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
  const digest = createHash('sha256')
    .update('ensemus.skill.digest.v1\0' + canonicalJson(manifest))
    .digest('hex');
  const key = generateKeyPairSync('ed25519');
  const bundle: SkillBundle = {
    format: 'ensemus.skill.bundle.v1',
    manifest,
    files: [...files].map(([path, bytes]) => ({ path, content_base64: bytes.toString('base64') })),
    signature: {
      algorithm: 'ed25519',
      key_id: createHash('sha256')
        .update(key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))
        .digest('hex'),
      value_base64: sign(
        null,
        Buffer.from('ensemus.skill.signature.v1\0' + digest),
        key.privateKey,
      ).toString('base64'),
    },
  };
  return { bundle, digest, files };
}
const encoded = (bundle: unknown) => Buffer.from(JSON.stringify(bundle));
describe('untrusted skill bundles', () => {
  it('round-trips signed bytes, including an empty file, without fetching or executing anything', () => {
    const source = fixture();
    const result = parseSkillBundle(encoded(source.bundle));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(manifestDigest(source.bundle.manifest)).toBe(source.digest);
    expect(result.parsed.digest).toBe(source.digest);
    expect(result.parsed.files).toEqual(source.files);
    expect(readFixtures(result.parsed)).toEqual([
      { position: 0, input: { count: 1 }, expectedOutput: { count: 2 } },
    ]);
    expect(runContractTests(result.parsed)).toEqual({ total: 1, passed: 1, firstFailed: null });
  });
  it('rejects malformed transport before looking at a manifest', () => {
    expect(parseSkillBundle(Buffer.alloc(SKILL_BUNDLE_MAX_BYTES + 1))).toEqual({
      ok: false,
      code: 'BUNDLE_TOO_LARGE',
    });
    for (const bytes of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from('null')])
      expect(parseSkillBundle(bytes).ok).toBe(false);
  });
  it.each([
    ['FILE_DUPLICATED', (b: SkillBundle) => b.files.push(b.files[0]!)],
    [
      'FILE_UNDECLARED',
      (b: SkillBundle) => b.files.push({ path: 'extra.txt', content_base64: 'YQ==' }),
    ],
    ['FILE_MISSING', (b: SkillBundle) => b.files.pop()],
    [
      'FILE_HASH_MISMATCH',
      (b: SkillBundle) => {
        b.files[0]!.content_base64 = Buffer.from('Different test text').toString('base64');
        b.manifest.files[0]!.size_bytes = 19;
      },
    ],
    [
      'FILE_SIZE_MISMATCH',
      (b: SkillBundle) => {
        b.manifest.files[0]!.size_bytes += 1;
      },
    ],
    [
      'FILE_MISSING',
      (b: SkillBundle) => {
        b.manifest.instructions = 'absent.md';
      },
    ],
    [
      'PATH_UNSAFE',
      (b: SkillBundle) => {
        b.files[0]!.path = '../escape';
      },
    ],
    [
      'SCHEMA_NOT_SUPPORTED',
      (b: SkillBundle) => {
        b.manifest.input_schema = { pattern: '(a+)+' };
      },
    ],
  ] as const)('answers %s for invalid package contents', (code, mutate) => {
    const { bundle } = fixture();
    mutate(bundle);
    expect(parseSkillBundle(encoded(bundle))).toEqual({ ok: false, code });
  });
  it('refuses ambiguous base64, invalid fixtures and hostile schema objects', () => {
    const { bundle } = fixture();
    bundle.files[0]!.content_base64 = 'YR==';
    expect(parseSkillBundle(encoded(bundle)).ok).toBe(false);
    const parsed = parseSkillBundle(encoded(fixture().bundle));
    if (!parsed.ok) throw new Error(parsed.code);
    const changed = {
      ...parsed.parsed,
      files: new Map(parsed.parsed.files).set('input.json', Buffer.from([0xff])),
    };
    expect(readFixtures(changed)).toBeNull();
    expect(runContractTests(changed)).toEqual({ total: 1, passed: 0, firstFailed: 0 });
    expect(matchesSkillSchema({ type: 'object', required: ['constructor'] }, {})).toBe(false);
    expect(
      matchesSkillSchema(
        { type: 'object', required: ['__proto__'] },
        JSON.parse('{"__proto__":{}}'),
      ),
    ).toBe(true);
  });
});

describe('fixture failure positions', () => {
  it('reports the actual first invalid fixture rather than blaming an earlier valid one', () => {
    const parsed = parseSkillBundle(encoded(fixture().bundle));
    if (!parsed.ok) throw new Error(parsed.code);
    const tests = [
      ...parsed.parsed.manifest.tests,
      { name: 'Broken second fixture', input: 'broken.json', expected_output: 'output.json' },
    ];
    const changed = {
      ...parsed.parsed,
      manifest: { ...parsed.parsed.manifest, tests },
      files: new Map(parsed.parsed.files).set('broken.json', Buffer.from('not JSON')),
    };
    expect(runContractTests(changed)).toEqual({ total: 2, passed: 1, firstFailed: 1 });
  });
});

describe('bounded skill schema interpreter', () => {
  it.each([
    [{ type: 'integer', minimum: 1, maximum: 2 }, 1, true],
    [{ type: 'integer' }, 1.5, false],
    [{ type: ['string', 'null'], minLength: 2, maxLength: 3 }, 'ab', true],
    [{ type: 'string', minLength: 1, maxLength: 1 }, '😀', true],
    [
      { type: 'array', minItems: 1, maxItems: 2, items: { enum: ['yes', 'no'] } },
      ['yes', 'other'],
      false,
    ],
    [{ const: { a: 1, b: 2 } }, { b: 2, a: 1 }, true],
    [{ type: 'object', additionalProperties: { type: 'boolean' } }, { extra: 0 }, false],
    [{ pattern: '.*' }, 'anything', false],
    [{ type: 'invalid' }, 'anything', false],
    [{ minimum: 'one' }, 2, false],
    [{ required: 'constructor' }, {}, false],
    [{ properties: { x: { $ref: 'https://example.invalid' } } }, {}, false],
  ])('evaluates only the supported schema dialect (%j)', (schema, value, result) =>
    expect(matchesSkillSchema(schema, value)).toBe(result),
  );
  it('stops on cyclic, too-deep and non-JSON inputs', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.items = cyclic;
    let deep: unknown = {};
    for (let i = 0; i < 10; i += 1) deep = { items: deep };
    for (const schema of [cyclic, deep]) expect(matchesSkillSchema(schema, [])).toBe(false);
    for (const value of [NaN, Infinity, undefined, () => 1, 1n, new Date(), cyclic])
      expect(matchesSkillSchema({}, value)).toBe(false);
  });
});
describe('manifest supply-chain admission', () => {
  it('refuses unknown licenses and conflicting bundled dependency versions', () => {
    const manifest = fixture().bundle.manifest;
    expect(checkManifestSupplyChain(manifest)).toBe('ok');
    expect(checkManifestSupplyChain({ ...manifest, license: 'Unreviewed' })).toBe(
      'LICENSE_NOT_ALLOWED',
    );
    expect(
      checkManifestSupplyChain({
        ...manifest,
        dependencies: [
          { name: 'sample', version: '1', license: 'MIT' },
          { name: 'sample', version: '2', license: 'MIT' },
        ],
      }),
    ).toBe('DEPENDENCY_NOT_ALLOWED');
    expect(
      checkManifestSupplyChain({
        ...manifest,
        dependencies: [{ name: 'sample', version: '1', license: 'Unreviewed' }],
      }),
    ).toBe('DEPENDENCY_NOT_ALLOWED');
    expect(policyForManifest(manifest, SANDBOX_DEFAULT_CEILINGS)).toEqual({
      ok: true,
      policy: null,
    });
  });
});
