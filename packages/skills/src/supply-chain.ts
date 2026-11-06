// Owned by the skill-format slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D2. The checks that
// the spec's supply-chain section names and that need nothing but the manifest and this deployment's limits.
import type { SkillManifest } from '@ensemus/contracts/skills';
import type { SandboxLimits, SandboxPolicy } from '@ensemus/domain/sandbox';
import type { SkillRejectCode } from '@ensemus/domain/skill';

/**
 * The package's own licence and every dependency's are on SKILL_ALLOWED_LICENSES, and no two dependencies
 * of the same name disagree about their version. Answers the first problem found.
 */
export function checkManifestSupplyChain(
  _manifest: SkillManifest,
): 'ok' | Extract<SkillRejectCode, 'LICENSE_NOT_ALLOWED' | 'DEPENDENCY_NOT_ALLOWED'> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The compiled policy for a package with code, through compileSandboxPolicy, on this deployment's ceilings.
 * Null for a declarative package. A refusal is the reject code of the same name.
 */
export function policyForManifest(
  _manifest: SkillManifest,
  _ceilings: SandboxLimits,
):
  | { ok: true; policy: SandboxPolicy; policyHash: string }
  | { ok: true; policy: null }
  | {
      ok: false;
      code: Extract<
        SkillRejectCode,
        'RUNTIME_NOT_SUPPORTED' | 'NETWORK_NOT_ALLOWED' | 'LIMITS_OVER_CEILING'
      >;
    } {
  throw new Error('NOT_IMPLEMENTED');
}
