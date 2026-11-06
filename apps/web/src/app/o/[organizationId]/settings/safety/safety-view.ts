// The safety page's words. A switch's row holds codes, so nothing a person or a model wrote can reach here.

/** Why someone stopped agents. A list and not a text box: this goes on the audit record. */
export const HALT_REASONS = [
  { code: 'INCIDENT', label: 'A security incident' },
  { code: 'SUSPECTED_INJECTION', label: 'An agent may have been manipulated by something it read' },
  { code: 'UNEXPECTED_ACTIONS', label: 'An agent is doing something it should not' },
  { code: 'COST_CONCERN', label: 'Agents are spending more than expected' },
  { code: 'OTHER', label: 'Another reason' },
] as const;

const REASON_WORDS = new Map<string, string>(HALT_REASONS.map(({ code, label }) => [code, label]));

/** An operator can use any code, so one with no words here is shown as it is. */
export const reasonLabel = (code: string) => REASON_WORDS.get(code) ?? code;

const PROVIDER_WORDS: Record<string, string> = {
  openai_hosted: 'OpenAI',
  anthropic_hosted: 'Anthropic',
  openai_compatible: 'OpenAI-compatible endpoints',
  local_openai_compatible: 'private inference endpoints',
};

/** What a stop covers, in a sentence. `versionName` is the agent's name, when it can still be found. */
export function scopeLabel(
  row: { scope: string; targetRef: string | null },
  versionName?: string,
): string {
  switch (row.scope) {
    case 'global':
      return 'Every agent, in every organization on this deployment';
    case 'organization':
      return 'Every agent in this organization';
    case 'provider':
      return `Every agent using ${PROVIDER_WORDS[row.targetRef ?? ''] ?? 'one model provider'}`;
    case 'agent_version':
      return versionName ? `One agent: ${versionName}` : 'One agent version';
    default:
      return 'Agents on this deployment';
  }
}
