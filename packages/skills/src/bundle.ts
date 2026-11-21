// Worker-only parsing of untrusted packages (EXP-04, ADR-034 D2). No filesystem, network or execution.
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  skillBundleSchema,
  skillJsonSchemaSchema,
  type SkillBundle,
  type SkillManifest,
} from '@ensemus/contracts/skills';
import { canonicalJson } from '@ensemus/domain/approval';
import { SKILL_BUNDLE_MAX_BYTES, type SkillRejectCode } from '@ensemus/domain/skill';

export const SKILL_DIGEST_DOMAIN = 'ensemus.skill.digest.v1\0';
export type ParsedSkillBundle = {
  bundle: SkillBundle;
  manifest: SkillManifest;
  files: ReadonlyMap<string, Buffer>;
  digest: string;
};
export type BundleCheck =
  { ok: true; parsed: ParsedSkillBundle } | { ok: false; code: SkillRejectCode };
const refuse = (code: SkillRejectCode): BundleCheck => ({ ok: false, code });
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function manifestDigest(manifest: SkillManifest): string {
  return createHash('sha256')
    .update(SKILL_DIGEST_DOMAIN)
    .update(canonicalJson(manifest))
    .digest('hex');
}

/** Bound before parsing or decoding, then verify every byte against the signed manifest. */
export function parseSkillBundle(bytes: Buffer): BundleCheck {
  if (bytes.length > SKILL_BUNDLE_MAX_BYTES) return refuse('BUNDLE_TOO_LARGE');
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return refuse('BUNDLE_MALFORMED');
  }
  const checked = skillBundleSchema.safeParse(value);
  if (!checked.success) {
    const issues = checked.error.issues;
    if (issues.some((issue) => issue.message === 'SCHEMA_NOT_SUPPORTED'))
      return refuse('SCHEMA_NOT_SUPPORTED');
    if (issues.some((issue) => issue.message === 'FILE_DUPLICATED'))
      return refuse('FILE_DUPLICATED');
    if (
      issues.some(
        (issue) =>
          ['path', 'instructions', 'entry', 'input', 'expected_output'].includes(
            String(issue.path.at(-1)),
          ) && issue.code === 'invalid_format',
      )
    )
      return refuse('PATH_UNSAFE');
    return refuse('MANIFEST_INVALID');
  }
  const signature = Buffer.from(checked.data.signature.value_base64, 'base64');
  if (
    signature.length !== 64 ||
    signature.toString('base64') !== checked.data.signature.value_base64
  )
    return refuse('SIGNATURE_INVALID');
  const bundle = checked.data,
    manifest = bundle.manifest;
  if (manifest.files.reduce((sum, file) => sum + file.size_bytes, 0) > SKILL_BUNDLE_MAX_BYTES)
    return refuse('BUNDLE_TOO_LARGE');
  const declarations = new Map(manifest.files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  let decodedBytes = 0;
  for (const file of bundle.files) {
    if (seen.has(file.path)) return refuse('FILE_DUPLICATED');
    seen.add(file.path);
    if (!declarations.has(file.path)) return refuse('FILE_UNDECLARED');
    const padding = file.content_base64.endsWith('==')
      ? 2
      : file.content_base64.endsWith('=')
        ? 1
        : 0;
    decodedBytes += (file.content_base64.length / 4) * 3 - padding;
    if (decodedBytes > SKILL_BUNDLE_MAX_BYTES) return refuse('BUNDLE_TOO_LARGE');
  }
  if (seen.size !== declarations.size) return refuse('FILE_MISSING');
  const required = [
    manifest.instructions,
    ...manifest.tests.flatMap((test) => [test.input, test.expected_output]),
    ...(manifest.execution.kind === 'sandbox' ? [manifest.execution.entry] : []),
  ];
  if (required.some((path) => !declarations.has(path))) return refuse('FILE_MISSING');
  const files = new Map<string, Buffer>();
  for (const file of bundle.files) {
    const declaration = declarations.get(file.path)!;
    const content = Buffer.from(file.content_base64, 'base64');
    if (content.toString('base64') !== file.content_base64) return refuse('BUNDLE_MALFORMED');
    if (content.length !== declaration.size_bytes) return refuse('FILE_SIZE_MISMATCH');
    if (createHash('sha256').update(content).digest('hex') !== declaration.sha256)
      return refuse('FILE_HASH_MISMATCH');
    files.set(file.path, content);
  }
  return { ok: true, parsed: { bundle, manifest, files, digest: manifestDigest(manifest) } };
}

/** Direct callers also get a bounded, JSON-only input check; prototypes never satisfy required keys. */
function isJsonValue(value: unknown, depth = 0, budget = { left: 20_000 }): boolean {
  budget.left -= 1;
  if (budget.left < 0 || depth > 8) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1, budget));
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function matches(schema: Record<string, unknown>, value: unknown): boolean {
  const typeMatches = (type: unknown) => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object')
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    return typeof value === type;
  };
  if (
    schema.type !== undefined &&
    !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(typeMatches)
  )
    return false;
  if (Object.hasOwn(schema, 'const') && !equal(schema.const, value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => equal(option, value)))
    return false;
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (
      schema.items &&
      !value.every((item) => matches(schema.items as Record<string, unknown>, item))
    )
      return false;
  } else if (value !== null && typeof value === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    if (
      Array.isArray(schema.required) &&
      schema.required.some((key) => !Object.hasOwn(value, key as string))
    )
      return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!matches(properties[key]!, item)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object' &&
        !matches(schema.additionalProperties as Record<string, unknown>, item)
      )
        return false;
    }
  }
  return true;
}
export function matchesSkillSchema(schema: unknown, value: unknown): boolean {
  try {
    const checked = skillJsonSchemaSchema.safeParse(schema);
    return checked.success && isJsonValue(value) && matches(checked.data, value);
  } catch {
    return false;
  }
}
function readFixture(
  parsed: ParsedSkillBundle,
  position: number,
): { position: number; input: unknown; expectedOutput: unknown } | null {
  try {
    const test = parsed.manifest.tests[position];
    if (!test) return null;
    const input = parsed.files.get(test.input),
      expected = parsed.files.get(test.expected_output);
    if (!input || !expected) return null;
    return {
      position,
      input: JSON.parse(decoder.decode(input)) as unknown,
      expectedOutput: JSON.parse(decoder.decode(expected)) as unknown,
    };
  } catch {
    return null;
  }
}
export function readFixtures(
  parsed: ParsedSkillBundle,
): ReadonlyArray<{ position: number; input: unknown; expectedOutput: unknown }> | null {
  const fixtures = parsed.manifest.tests.map((_, position) => readFixture(parsed, position));
  if (fixtures.some((fixture) => fixture === null)) return null;
  return fixtures.filter((fixture) => fixture !== null);
}
export function runContractTests(parsed: ParsedSkillBundle): {
  total: number;
  passed: number;
  firstFailed: number | null;
} {
  const total = parsed.manifest.tests.length;
  let passed = 0,
    firstFailed: number | null = null;
  for (let position = 0; position < total; position += 1) {
    const fixture = readFixture(parsed, position);
    if (
      fixture &&
      matchesSkillSchema(parsed.manifest.input_schema, fixture.input) &&
      matchesSkillSchema(parsed.manifest.output_schema, fixture.expectedOutput)
    )
      passed += 1;
    else firstFailed ??= position;
  }
  return { total, passed, firstFailed };
}
