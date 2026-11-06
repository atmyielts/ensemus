// Owned by the skill-format slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D2. Reads what a
// stranger wrote, so nothing here may write a file, reach a network, compile a pattern or run anything.
import type { SkillBundle, SkillManifest } from '@ensemus/contracts/skills';
import type { SkillRejectCode } from '@ensemus/domain/skill';

/** The fixed prefix on what a digest hashes, so it can never collide with any other hash in the product. */
export const SKILL_DIGEST_DOMAIN = 'ensemus.skill.digest.v1\0';

export type ParsedSkillBundle = {
  bundle: SkillBundle;
  manifest: SkillManifest;
  /** Every declared file, decoded, by path. */
  files: ReadonlyMap<string, Buffer>;
  digest: string;
};

export type BundleCheck = { ok: true; parsed: ParsedSkillBundle } | { ok: false; code: SkillRejectCode };

/** SHA-256 of the domain prefix and the manifest's canonicalJson. What a signature covers. */
export function manifestDigest(_manifest: SkillManifest): string {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Checks in this order, stopping at the first failure: size, UTF-8 and JSON, the contract, every path,
 * every file exactly once with the declared hash and size, and every path the manifest names (instructions,
 * entry, fixtures) present in the files. Decoded sizes are summed against SKILL_BUNDLE_MAX_BYTES before any
 * base64 is decoded in full. Does not check a signature: that needs a key, and signature.ts has it.
 */
export function parseSkillBundle(_bytes: Buffer): BundleCheck {
  throw new Error('NOT_IMPLEMENTED');
}

/** Whether a value fits the supported subset of JSON Schema. No regular expressions, no recursion past 8. */
export function matchesSkillSchema(_schema: unknown, _value: unknown): boolean {
  throw new Error('NOT_IMPLEMENTED');
}

/** The fixture's two JSON files, parsed, by position. Null if either is not JSON. */
export function readFixtures(
  _parsed: ParsedSkillBundle,
): ReadonlyArray<{ position: number; input: unknown; expectedOutput: unknown }> | null {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The contract test: each fixture's input fits the input schema and its expected output fits the output
 * schema. It says the package's tests make sense. It cannot say the instructions are good, and a package
 * with code still has to run them. Returns how many passed and the first that did not.
 */
export function runContractTests(_parsed: ParsedSkillBundle): {
  total: number;
  passed: number;
  firstFailed: number | null;
} {
  throw new Error('NOT_IMPLEMENTED');
}
