// What M7 needs from milestones written at the same time (ADR-031 D2). M4 and M5 implement these at the
// final merge, in one wiring file each for the web and the worker. Until then every port says plainly that
// the capability is not available here, and each page shows that: no fake ever ships as a default.
import type { TenantContext, Tx } from '@ensemus/database';
import type { ToolFacts } from '@ensemus/domain/agent-draft';
import { AppError } from '../errors';

/** Thrown by a port with nothing behind it. Services let it through, and pages word it honestly. */
export const capabilityUnavailable = () => new AppError('CAPABILITY_UNAVAILABLE');

// --- M4: agents

export type PublishedAgentVersion = {
  definitionId: string;
  versionId: string;
  versionNumber: number;
  specSha256: string;
};

export type AgentVersionSummary = PublishedAgentVersion & {
  name: string;
  publishedAt: Date;
  active: boolean;
};

/** M4 S7. Writes the immutable version in the caller's transaction, so a publish is all or nothing. */
export interface AgentRegistryPort {
  publish(
    tx: Tx,
    context: TenantContext,
    input: {
      definitionId: string | null;
      name: string;
      ownerMembershipId: string;
      spec: Record<string, unknown>;
      specSha256: string;
      /** The hash of the passed simulation report, which M4 FD-19 calls the evaluation report. */
      evaluationReportSha256: string;
    },
  ): Promise<PublishedAgentVersion>;
  list(context: TenantContext, input: { definitionId?: string }): Promise<AgentVersionSummary[]>;
  /** Points the definition back at an older version. Work already running keeps its own version. */
  pin(tx: Tx, context: TenantContext, input: { versionId: string }): Promise<void>;
  /** The caps a draft may not exceed. M4 calls these org policy. */
  orgLimits(
    context: TenantContext,
  ): Promise<{ maxTurns: number; maxToolCalls: number; timeoutSeconds: number }>;
}

/** M4 S10. The tools that exist, from its code-defined registry. */
export interface ToolCatalogPort {
  list(context: TenantContext): Promise<readonly ToolFacts[]>;
}

/** What one run looks like to the person who asked for it. Codes, never model text (AGENT-06). */
export type DelegatedRun = {
  id: string;
  workUnitId: string;
  workTitle: string;
  agentName: string;
  status: string;
  stopCode: string | null;
  turnsUsed: number;
  toolCallsUsed: number;
  /** Null when no rate card applies. Always shown as an estimate where that is what it is. */
  costMicros: number | null;
  costIsEstimate: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  canStop: boolean;
  steps: readonly { labelCode: string; state: string; at: Date }[];
};

/** M4 S13. Reading and stopping are filtered by who can read the Work Unit, inside the implementation. */
export interface AgentRunsPort {
  listMine(
    context: TenantContext,
    input: { status?: string; after?: string; limit?: number },
  ): Promise<{ items: DelegatedRun[]; next: string | null }>;
  get(context: TenantContext, runId: string): Promise<DelegatedRun>;
  requestStop(context: TenantContext, runId: string): Promise<void>;
  /** Used by a process step, in the caller's transaction. Commits the run and its outbox event together. */
  startInTx(
    tx: Tx,
    context: TenantContext,
    input: { workUnitId: string; agentDefinitionId: string; initiatorMembershipId: string },
  ): Promise<{ runId: string }>;
  /** Whether a run has finished, for a process step that waits on one. */
  outcome(
    context: TenantContext,
    runId: string,
  ): Promise<'running' | 'completed' | 'failed' | 'stopped' | 'unknown'>;
}

/** M4 S5. Counts only: onboarding says whether a model is ready, and never touches a key. */
export interface ModelReadinessPort {
  summary(context: TenantContext): Promise<{ activeProfiles: number; draftProfiles: number }>;
}

/** M4 S6. What a Work Unit's runs have cost, from the ledger. */
export interface UsageReadPort {
  costForWorkUnit(
    context: TenantContext,
    workUnitId: string,
  ): Promise<{ costMicros: number; isEstimate: boolean } | null>;
}

// --- M5: knowledge

export type KnowledgeSourceView = {
  id: string;
  name: string;
  kind: string;
  classification: string;
  /** `ok`, `stale` or `denied`: what the reader may rely on, as M5's UX-18 defines it. */
  freshness: 'ok' | 'stale' | 'unknown';
  lastSyncedAt: Date | null;
  accessState: 'full' | 'partial';
};

export type KnowledgeHit = {
  sourceId: string;
  title: string;
  /** A short passage, already filtered by the viewer's access inside M5. */
  excerpt: string;
  citationId: string;
  freshness: 'ok' | 'stale' | 'unknown';
  originalUrl: string | null;
};

/** M5 KNOW-01, KNOW-02 and UX-22. ACLs apply inside it. M7 never filters a result itself, or sees more. */
export interface KnowledgeReadPort {
  listSources(context: TenantContext): Promise<readonly KnowledgeSourceView[]>;
  search(
    context: TenantContext,
    input: { query: string; limit?: number },
  ): Promise<readonly KnowledgeHit[]>;
}

/** M5 AGENT-11. What would go where under a proposed provider, with nothing actually sent. */
export interface EgressSimulationPort {
  simulate(
    context: TenantContext,
    input: { modelProfileId: string },
  ): Promise<{ workflowsAffected: number; classesReaching: readonly string[] }>;
}

export type ProductPorts = {
  agentRegistry: AgentRegistryPort;
  toolCatalog: ToolCatalogPort;
  agentRuns: AgentRunsPort;
  modelReadiness: ModelReadinessPort;
  usage: UsageReadPort;
  knowledge: KnowledgeReadPort;
  egressSimulation: EgressSimulationPort;
};

const unavailable = async (): Promise<never> => {
  throw capabilityUnavailable();
};

/** The only default anywhere. It does nothing and says so. The final merge replaces each entry. */
export function unavailablePorts(): ProductPorts {
  return {
    agentRegistry: {
      publish: unavailable,
      list: unavailable,
      pin: unavailable,
      orgLimits: unavailable,
    },
    toolCatalog: { list: unavailable },
    agentRuns: {
      listMine: unavailable,
      get: unavailable,
      requestStop: unavailable,
      startInTx: unavailable,
      outcome: unavailable,
    },
    modelReadiness: { summary: unavailable },
    usage: { costForWorkUnit: unavailable },
    knowledge: { listSources: unavailable, search: unavailable },
    egressSimulation: { simulate: unavailable },
  };
}
