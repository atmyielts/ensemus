// Owned by the agents slice (AGENT-01). See docs/06-delivery/m4-slices.md and ADR-028 FD-19. Needs
// `agent.publish`. Every stub refuses.
import type { AgentVersionView } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';

/** Checks the spec, lints its grants, requires a report bound to its hash, then writes one immutable row. */
export function publishAgentVersion(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { spec: unknown; evaluationReport: unknown; policyVersion: string },
): Promise<AgentVersionView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listAgentVersions(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly AgentVersionView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getAgentVersion(
  _database: AppDatabase,
  _context: TenantContext,
  _versionId: string,
): Promise<AgentVersionView> {
  throw new Error('NOT_IMPLEMENTED');
}
