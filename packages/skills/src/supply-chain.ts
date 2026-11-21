// Owned by the skill-format slice (EXP-04). See docs/06-delivery/m11b-slices.md and ADR-034 D2. The checks that
// the spec's supply-chain section names and that need nothing but the manifest and this deployment's limits.
import type { SkillManifest } from '@ensemus/contracts/skills';
import {
  compileSandboxPolicy,
  type SandboxLimits,
  type SandboxPolicy,
} from '@ensemus/domain/sandbox';
import { SKILL_ALLOWED_LICENSES, type SkillRejectCode } from '@ensemus/domain/skill';

/**
 * The package's own licence and every dependency's are on SKILL_ALLOWED_LICENSES, and no two dependencies
 * of the same name disagree about their version. Answers the first problem found.
 */
export function checkManifestSupplyChain(
  manifest: SkillManifest,
): 'ok' | Extract<SkillRejectCode, 'LICENSE_NOT_ALLOWED' | 'DEPENDENCY_NOT_ALLOWED'> {
  const allowed = (license: string) =>
    (SKILL_ALLOWED_LICENSES as readonly string[]).includes(license);
  if (!allowed(manifest.license)) return 'LICENSE_NOT_ALLOWED';
  const versions = new Map<string, string>();
  for (const dependency of manifest.dependencies) {
    if (
      !allowed(dependency.license) ||
      (versions.has(dependency.name) && versions.get(dependency.name) !== dependency.version)
    )
      return 'DEPENDENCY_NOT_ALLOWED';
    versions.set(dependency.name, dependency.version);
  }
  return 'ok';
}

/**
 * The compiled policy for a package with code, through compileSandboxPolicy, on this deployment's ceilings.
 * Null for a declarative package. A refusal is the reject code of the same name.
 */
export function policyForManifest(
  manifest: SkillManifest,
  ceilings: SandboxLimits,
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
  const execution = manifest.execution;
  if (execution.kind === 'declarative') return { ok: true, policy: null };
  const limits = execution.limits;
  return compileSandboxPolicy(
    {
      runtime: execution.runtime,
      entry: execution.entry,
      network: execution.network,
      limits: {
        wallMs: limits.wall_ms,
        cpuMs: limits.cpu_ms,
        memoryMb: limits.memory_mb,
        tmpfsMb: limits.tmpfs_mb,
        outputKb: limits.output_kb,
        pids: limits.pids,
      },
    },
    ceilings,
  );
}
