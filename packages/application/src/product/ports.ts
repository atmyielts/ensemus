// What M7 needs from milestones written at the same time (ADR-031 D2). M4 and M5 implement these at the
// final merge, in one wiring file each for the web and the worker. Until then every port says plainly that
// the capability is not available here, and each page shows that: no fake ever ships as a default.
import type { TenantContext } from '@ensemus/database';
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

export type AgentVersionSummary = PublishedAgentVersion & { publishedAt: Date };

/**
 * M4's `evaluationReportSchema`, which its publish route requires. A simulation fills it with
 * `scripted_model: true`, which says plainly that it proves the gates and not the model (ADR-031 D5).
 */
export type EvaluationReportInput = {
  report_version: 1;
  spec_sha256: string;
  policy_version: string;
  suite_ref: string;
  dataset_version: string;
  model_label: string;
  pass_rate: number;
  cases: number;
  passed: boolean;
  scripted_model: boolean;
};

/**
 * M4's `publishAgentVersion` and `listAgentVersions`. Publishing commits in M4's own transaction, so
 * `publishApproved` finds an earlier attempt by hash through `list` before it publishes (ADR-031 D6).
 */
export interface AgentRegistryPort {
  publish(
    context: TenantContext,
    input: { spec: Record<string, unknown>; evaluationReport: EvaluationReportInput },
  ): Promise<PublishedAgentVersion>;
  list(context: TenantContext): Promise<readonly AgentVersionSummary[]>;
  /** Points an agent back at an older version. Work already running keeps its own version. */
  pin(context: TenantContext, input: { versionId: string }): Promise<void>;
  /** The caps a draft may not exceed, and the policy version a report has to name. */
  orgLimits(context: TenantContext): Promise<{
    maxTurns: number;
    maxToolCalls: number;
    timeoutSeconds: number;
    policyVersion: string;
  }>;
}

/** M4's `TOOL_MANIFESTS`, from `@ensemus/domain/ai-tools`. */
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

/**
 * M4's `getAgentRun`, `listRunSteps`, `controlAgentRun` and `startAgentRun`, each filtered by who can read
 * the Work Unit inside M4. `listMine` has no M4 service yet, and the adapter adds that one query.
 */
export interface AgentRunsPort {
  listMine(
    context: TenantContext,
    input: { status?: string; after?: string; limit?: number },
  ): Promise<{ items: DelegatedRun[]; next: string | null }>;
  get(context: TenantContext, runId: string): Promise<DelegatedRun>;
  requestStop(context: TenantContext, runId: string): Promise<void>;
  /** The newest version of a published agent, which a process step pins when it starts. */
  latestVersionOf(context: TenantContext, agentDefinitionId: string): Promise<string | null>;
  /**
   * For a process step. Commits in M4's own transaction and acts as the initiator, never as a service (M4
   * FD-3). M4 allows one live run per Work Unit, so a repeated step finds its run through
   * `listForWorkUnit` first and starts no second one.
   */
  start(
    context: TenantContext,
    input: { workUnitId: string; agentVersionId: string; initiatorMembershipId: string },
  ): Promise<{ runId: string }>;
  listForWorkUnit(context: TenantContext, workUnitId: string): Promise<readonly { id: string }[]>;
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

/**
 * M5's `listSources`, as a count: onboarding only has to know whether a first source exists. M5's own `ui`
 * slice builds the Knowledge pages (UX-18), so M7 reads nothing else from it (ADR-031 D2).
 */
export interface KnowledgeReadPort {
  summary(context: TenantContext): Promise<{ sources: number }>;
}

export type ProductPorts = {
  agentRegistry: AgentRegistryPort;
  toolCatalog: ToolCatalogPort;
  agentRuns: AgentRunsPort;
  modelReadiness: ModelReadinessPort;
  usage: UsageReadPort;
  knowledge: KnowledgeReadPort;
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
      latestVersionOf: unavailable,
      start: unavailable,
      listForWorkUnit: unavailable,
      outcome: unavailable,
    },
    modelReadiness: { summary: unavailable },
    usage: { costForWorkUnit: unavailable },
    knowledge: { summary: unavailable },
  };
}
