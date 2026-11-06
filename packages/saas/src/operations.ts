// Incidents and status (OPS-23, OPS-25). Pure. Severity words come from 04-security/06 §4. Times and
// notification deadlines belong to legal and SLA policy, so there are none here.
// The tables of values are fixed. The functions are owned by the operations slice.

export const INCIDENT_SEVERITIES = ['critical', 'high', 'medium'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const INCIDENT_STATES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

/** A provider's outage is said to be a provider's. It is never reported as Ensemus's, or the other way. */
export const INCIDENT_ORIGINS = [
  'ensemus',
  'model_provider',
  'connector_provider',
  'unknown',
] as const;
export type IncidentOrigin = (typeof INCIDENT_ORIGINS)[number];

/** The roles in 04-security/06 §7. A drill that names nobody proves nothing. */
export const INCIDENT_ROLES = [
  'commander',
  'security_lead',
  'infrastructure_lead',
  'communications',
  'legal',
] as const;
export type IncidentRole = (typeof INCIDENT_ROLES)[number];

export type PublishedIncident = {
  severity: IncidentSeverity;
  state: IncidentState;
  origin: IncidentOrigin;
  title: string;
  startedAt: Date;
  resolvedAt: Date | null;
};

export type ServiceStatus = 'operational' | 'provider_degraded' | 'degraded' | 'unknown';

/**
 * What the status page says at the top, from published incidents only. An open `model_provider` incident
 * says `provider_degraded` and never `degraded`. It has no uptime percentage, since none is measured.
 */
export function overallStatus(open: readonly PublishedIncident[]): ServiceStatus {
  const active = open.filter((incident) => incident.state !== 'resolved');
  if (active.some((incident) => incident.origin === 'ensemus')) return 'degraded';
  if (active.some((incident) => incident.origin === 'unknown')) return 'unknown';
  return active.length ? 'provider_degraded' : 'operational';
}

export const VULNERABILITY_STATES = [
  'received',
  'triaged',
  'fixing',
  'fixed',
  'disclosed',
  'rejected',
] as const;
export type VulnerabilityState = (typeof VULNERABILITY_STATES)[number];
