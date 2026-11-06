// Agent Studio's guided builder (AGENT-08). The answers a person gives, and how they turn into a typed spec.
// A person never edits a raw prompt or a raw grant list here. Owned by the studio slice.

export const AUTONOMY_MODES = ['suggest_only', 'draft_for_review', 'act_with_approval'] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export const MEMORY_WRITE_MODES = ['none', 'propose_only'] as const;
export type MemoryWriteMode = (typeof MEMORY_WRITE_MODES)[number];

/** What the wizard collects (docs/03-intelligence/03-agent-studio-and-skills.md, User model). */
export type AgentDraftAnswers = {
  /** Who it is, in plain words. Goes into the spec's instructions under its own role. */
  role: string;
  intendedOutcome: string;
  boundaries: readonly string[];
  knowledgeSourceIds: readonly string[];
  /** Tool IDs from the catalog port. An ID that is not in the catalog fails to compile. */
  toolIds: readonly string[];
  triggerKind: 'manual';
  /** Micro-USD, because a float cannot be reconciled (M4 FD-6). No default: nothing means no run. */
  maxCostMicros: number | null;
  maxTurns: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  timeoutSeconds: number;
  qualityTier: 'economy' | 'balanced' | 'high';
  autonomy: AutonomyMode;
  memoryWrite: MemoryWriteMode;
  outputFormat: 'markdown_brief' | 'structured_report';
  dataClasses: readonly ('public' | 'internal' | 'confidential')[];
  ownerMembershipId: string;
};

/** The same shape as M4's `ToolManifest`, reached through ToolCatalogPort. */
export type ToolFacts = {
  id: string;
  version: string;
  class: 'read_only' | 'draft_only' | 'external_write' | 'delegation';
  requiresApproval: boolean;
};

export type DraftIssue = {
  path: string;
  code:
    | 'REQUIRED'
    | 'UNKNOWN_TOOL'
    | 'TOOL_NEEDS_APPROVAL_MODE'
    | 'SECRET_TOOL_REFUSED'
    | 'LIMIT_TOO_HIGH'
    | 'NO_BUDGET'
    | 'RESTRICTED_NOT_OFFERED';
};

export type RiskFinding = {
  code:
    | 'WRITES_OUTSIDE'
    | 'DELEGATES'
    | 'READS_CONFIDENTIAL'
    | 'ACTS_WITH_APPROVAL'
    | 'PROPOSES_MEMORY';
  /** The tool or data class it is about, as data for the page to word. */
  subject: string;
};

export type DraftAssessment = {
  /** The spec as the registry expects it, or null while there are issues. */
  spec: Record<string, unknown> | null;
  specSha256: string | null;
  issues: readonly DraftIssue[];
  risk: readonly RiskFinding[];
  /** `elevated` needs a second person to review it (ADR-031 D6). */
  riskLevel: 'standard' | 'elevated';
};

/**
 * Pure. Compiles to M4's `AgentSpecV1` (ADR-031 D5, `api_version: 'ensemus.ai/v1'`). Refuses rather than
 * repairs: no `secrets.*` tool, no restricted data class, no external write without `act_with_approval`, and
 * a limit above `orgLimits` is an issue, not a silent cap. Implemented by the studio slice. `sha256` is passed in, so this file
 * stays free of Node modules and can run anywhere.
 */
export function assessDraft(
  _answers: AgentDraftAnswers,
  _tools: readonly ToolFacts[],
  _orgLimits: { maxTurns: number; maxToolCalls: number; timeoutSeconds: number },
  _sha256: (canonical: string) => string,
): DraftAssessment {
  throw new Error('NOT_IMPLEMENTED');
}
