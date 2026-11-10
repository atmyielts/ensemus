import 'server-only';
import { idSchema } from '@ensemus/application';
import type { ProcessRunView } from '@ensemus/application/process-runs';
import type { ProcessSpecView } from '@ensemus/application/process-specs';
import { processRunViewSchema, processSpecViewSchema } from '@ensemus/contracts/studio';
import { organizationParams } from './api';
export const processRunParams = organizationParams.extend({ processRunId: idSchema });
export const processSpecDto = (row: ProcessSpecView) =>
  processSpecViewSchema.parse({
    id: row.id,
    process_key: row.processKey,
    version_number: row.versionNumber,
    name: row.name,
    classification: row.classification,
    spec: row.spec,
    spec_sha256: row.specSha256,
    source: row.source,
    source_ref: row.sourceRef,
    published_at: row.publishedAt.toISOString(),
  });
export const processRunDto = (row: ProcessRunView) =>
  processRunViewSchema.parse({
    id: row.id,
    spec_id: row.specId,
    title: row.title,
    process_name: row.processName,
    root_work_unit_id: row.rootWorkUnitId,
    status: row.status,
    stop_code: row.stopCode,
    steps: row.steps.map((step) => ({
      key: step.key,
      label: step.label,
      kind: step.kind,
      after: step.after,
      tool_id: step.toolId,
      status: step.status,
      stop_code: step.stopCode,
      work_unit_id: step.workUnitId,
      approval_id: step.approvalId,
      external_action_id: step.externalActionId,
      agent_run_id: step.agentRunId,
    })),
    cost:
      row.cost === null
        ? null
        : { cost_micros: row.cost.costMicros, is_estimate: row.cost.isEstimate },
    can_manage: row.canManage,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
  });
