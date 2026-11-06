// The words around a pack's own strings. A pack says what it wants in its own voice, and these are the parts
// Ensemus says itself, so a pack cannot word its way out of them.
const STATUS: Record<string, { label: string; tone: string }> = {
  reviewing: { label: 'Being reviewed', tone: 'attention' },
  active: { label: 'Installed', tone: 'done' },
  superseded: { label: 'Replaced by a newer version', tone: '' },
  rolled_back: { label: 'Rolled back', tone: '' },
  cancelled: { label: 'Review cancelled', tone: '' },
};

export function PackStatusBadge({ status }: { status: string }) {
  const known = STATUS[status] ?? { label: 'Unknown', tone: '' };
  return <span className={`badge ${known.tone}`}>{known.label}</span>;
}

export function DecisionBadge({ decision }: { decision: string }) {
  if (decision === 'accepted') return <span className="badge done">Accepted</span>;
  if (decision === 'declined') return <span className="badge">Declined</span>;
  return <span className="badge attention">Not decided</span>;
}

export const KIND_WORDS: Record<string, string> = {
  object_type: 'A new type of record',
  agent_tool: 'A tool an agent would use',
  data_class: 'A level of data',
  knowledge_source: 'A knowledge source',
  external_effect: 'An action outside your organization',
};

const CLASS_WORDS: Record<string, string> = {
  read_only: 'This deployment lists this tool as reading only.',
  draft_only: 'This deployment lists this tool as writing drafts only.',
  external_write: 'This deployment lists this tool as reaching outside your organization.',
  delegation: 'This deployment lists this tool as handing work to another agent.',
};

export function toolSentence(tool: {
  availability: 'available' | 'unavailable' | 'unknown';
  class: string | null;
  requiresApproval: boolean | null;
}): string {
  if (tool.availability === 'unknown') {
    return 'The list of tools cannot be read on this deployment yet, so anything that needs this tool will be left out.';
  }
  if (tool.availability === 'unavailable') {
    return 'This deployment does not have this tool, so anything that needs it will be left out.';
  }
  const kind = (tool.class && CLASS_WORDS[tool.class]) || 'This deployment has this tool.';
  return tool.requiresApproval ? `${kind} A person approves each use.` : kind;
}

export const LEFT_OUT_WORDS: Record<string, string> = {
  declined: 'You declined something it needs.',
  undecided: 'Something it needs is not decided yet.',
  tool_unavailable: 'This deployment does not have a tool it needs',
  catalog_unavailable: 'The list of tools cannot be read on this deployment yet.',
  tool_needs_approval_mode: 'It would need to ask a person first, and it is not set up to.',
  tool_without_approval: 'A tool it needs does not ask a person first on this deployment',
  capability_understated: 'A tool it needs does more here than the pack said',
  name_in_use: 'Your organization already has a record type with this name, and a pack never takes one over.',
};

export const ITEM_KIND_WORDS: Record<string, string> = {
  object_type: 'Record type',
  agent_draft: 'Agent draft',
  process_draft: 'Workflow draft',
  process_spec: 'Published workflow',
};

/** Where a person goes to carry on with something a pack made. Each of these checks access itself. */
export function itemHref(base: string, item: { kind: string; id: string }): string | null {
  switch (item.kind) {
    case 'object_type':
      return `${base}/objects`;
    case 'agent_draft':
      return `${base}/studio/agents/${item.id}`;
    case 'process_draft':
      return `${base}/studio/workflows/${item.id}`;
    default:
      return null;
  }
}
