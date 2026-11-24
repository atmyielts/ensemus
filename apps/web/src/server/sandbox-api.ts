import type { SandboxRunView, SandboxStatusView } from '@ensemus/application';
import type { SandboxLimits } from '@ensemus/domain/sandbox';

function limitsDto(limits: SandboxLimits) {
  return {
    wall_ms: limits.wallMs,
    cpu_ms: limits.cpuMs,
    memory_mb: limits.memoryMb,
    tmpfs_mb: limits.tmpfsMb,
    output_kb: limits.outputKb,
    pids: limits.pids,
  };
}

export function sandboxRunDto(row: SandboxRunView) {
  return {
    id: row.id,
    skill_version_id: row.skillVersionId,
    purpose: row.purpose,
    classification: row.classification,
    status: row.status,
    outcome_code: row.outcomeCode,
    limits: limitsDto(row.limits),
    network: row.network,
    isolation_evidence: row.isolationEvidence,
    exit_code: row.exitCode,
    wall_ms: row.wallMs,
    cpu_ms: row.cpuMs,
    peak_memory_kb: row.peakMemoryKb,
    output: row.output,
    created_at: row.createdAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
    version: row.version,
  };
}

export function sandboxStatusDto(view: SandboxStatusView) {
  return {
    enabled: view.enabled,
    isolation_evidence: view.isolationEvidence,
    last_probe_passed_at: view.lastProbePassedAt?.toISOString() ?? null,
    ceilings: limitsDto(view.ceilings),
  };
}
