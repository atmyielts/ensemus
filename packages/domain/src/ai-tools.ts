// The tool list is code, not a table (ADR-028 FD-18). A tool not named here does not exist, and no
// `secrets.*` tool exists at all. Argument schemas are in @ensemus/contracts/ai-tools.

export const TOOL_CLASSES = ['read_only', 'draft_only', 'external_write', 'delegation'] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

export type ToolManifest = {
  id: string;
  version: string;
  class: ToolClass;
  /** External effects always ask a person. An agent's manifest cannot turn this off. */
  requiresApproval: boolean;
};

export const TOOL_MANIFESTS = [
  { id: 'work.read', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'artifact.read_text', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'artifact.draft.create', version: '1', class: 'draft_only', requiresApproval: false },
  { id: 'email.send', version: '1', class: 'external_write', requiresApproval: true },
  { id: 'agent.delegate', version: '1', class: 'delegation', requiresApproval: false },
] as const satisfies readonly ToolManifest[];

export type ToolId = (typeof TOOL_MANIFESTS)[number]['id'];

export const TOOL_IDS: readonly ToolId[] = TOOL_MANIFESTS.map((tool) => tool.id);

export function toolManifest(id: string): ToolManifest | undefined {
  return TOOL_MANIFESTS.find((tool) => tool.id === id);
}

/** A name a manifest may never allow, even as a future tool: lint at publish refuses these. */
export const FORBIDDEN_TOOL_PREFIXES = ['secrets.', 'model.', 'budget.', 'policy.', 'grant.'];
