// What the operator's commands do with incidents, drills and vulnerability reports, as `ensemus_operator`.
// Owned by the operations slice (OPS-23, OPS-25). There is no web path to any of it. See ADR-032 D10.
import type { EnsemusDrizzle } from '@ensemus/database/operator';
import type {
  IncidentOrigin,
  IncidentSeverity,
  IncidentState,
  VulnerabilityState,
} from '@ensemus/saas/operations';

export type OperatorDb = EnsemusDrizzle;

/** A commander is required, because an incident nobody is running is not being run. */
export function openIncident(
  _db: OperatorDb,
  _input: {
    severity: IncidentSeverity;
    origin: IncidentOrigin;
    providerKind: string | null;
    publicTitle: string;
    commanderRef: string;
    isDrill: boolean;
    startedAt: Date;
  },
): Promise<{ incidentId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function assignIncidentRoles(
  _db: OperatorDb,
  _input: {
    incidentId: string;
    securityLeadRef?: string;
    infrastructureLeadRef?: string;
    communicationsRef?: string;
    legalRef?: string;
  },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Appends one update. `publish` makes the incident visible, and a drill refuses it. */
export function updateIncident(
  _db: OperatorDb,
  _input: {
    incidentId: string;
    state: IncidentState;
    publicMessage: string;
    authorRef: string;
    publish: boolean;
    origin?: IncidentOrigin;
  },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Closing needs a reference to its postmortem, for anything above `medium`. */
export function resolveIncident(
  _db: OperatorDb,
  _input: { incidentId: string; authorRef: string; postmortemRef: string | null; message: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export function recordDrill(
  _db: OperatorDb,
  _input: {
    kind: 'incident' | 'restore' | 'vulnerability_disclosure' | 'failover';
    scenarioRef: string;
    roles: Readonly<Record<string, string>>;
    startedAt: Date;
    finishedAt: Date | null;
    outcome: 'passed' | 'failed' | null;
    evidenceRef: string | null;
  },
): Promise<{ drillId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** A reference, and never the report: the details stay in whichever channel the owner chose. */
export function recordVulnerabilityReport(
  _db: OperatorDb,
  _input: { channelRef: string; detailsRef: string; receivedAt: Date; isExercise: boolean },
): Promise<{ reportId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function moveVulnerabilityReport(
  _db: OperatorDb,
  _input: {
    reportId: string;
    state: VulnerabilityState;
    severity?: 'critical' | 'high' | 'medium' | 'low';
    fixedInRef?: string;
    expectedVersion: number;
  },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
