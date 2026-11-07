import 'server-only';
import type { CompanyPulse } from '@ensemus/application/pulse';
import { companyPulseSchema, type CompanyPulseBody } from '@ensemus/contracts/experience';

/** An explicit output allowlist: no row body, owner, source text, provider response or person score. */
export function pulseDto(view: CompanyPulse): CompanyPulseBody {
  return companyPulseSchema.parse({
    generated_at: view.generatedAt.toISOString(),
    signals: view.signals.map((signal) => ({
      key: signal.key,
      kind: signal.kind,
      severity: signal.severity,
      scope: { project_id: signal.scope.projectId, client_id: signal.scope.clientId },
      work: { id: signal.work.id, title: signal.work.title },
      evidence: signal.evidence.map((item) => ({
        kind: item.kind,
        id: item.id,
        reason_code: item.reasonCode,
        observed_at: item.observedAt.toISOString(),
      })),
      since: signal.since.toISOString(),
      personal_state: signal.personalState,
      snoozed_until: signal.snoozedUntil?.toISOString() ?? null,
    })),
    summary: {
      open_work: view.summary.openWork,
      overdue: view.summary.overdue,
      waiting_on_approval: view.summary.waitingOnApproval,
      needs_decision: view.summary.needsDecision,
    },
    partial: view.partial,
  });
}
