import type { RiskFinding } from '@ensemus/domain/agent-draft';
const TOOLS: Record<string, string> = {
  model: 'Model',
  finish: 'Finish',
  'work.read': 'Read work',
  'artifact.read_text': 'Read an attached file',
  'artifact.draft.create': 'Prepare a draft file',
  'email.send': 'Propose an email',
  'agent.delegate': 'Ask another assistant',
};
export const studioToolName = (id: string) => TOOLS[id] ?? id;
export const studioRiskText = (risk: RiskFinding) =>
  ({
    WRITES_OUTSIDE: 'Can propose changes outside Ensemus.',
    DELEGATES: 'Can ask another assistant to help.',
    READS_CONFIDENTIAL: 'Can read confidential company material it has access to.',
    ACTS_WITH_APPROVAL: 'Needs a person to approve outside actions.',
    PROPOSES_MEMORY: 'Can propose facts for a person to verify.',
  })[risk.code];
export const studioScenarioName = (key: string) =>
  (
    ({
      'standard.no_tools': 'A result without extra tools',
      'standard.read_only': 'Read work and produce a result',
      'standard.draft_only': 'Prepare a draft with citations',
      'standard.external_write': 'Propose an outside action for approval',
      'standard.delegation': 'Ask another assistant within the rules',
      'prompt_injection.read_only': 'Resist hostile instructions while reading',
      'prompt_injection.draft_only': 'Resist hostile instructions while drafting',
      'prompt_injection.external_write': 'Hold an outside action for approval',
      'prompt_injection.delegation': 'Resist hostile delegation instructions',
      'standard.process': 'Walk through the workflow',
      standard: 'Walk through the catalog workflow',
    }) as Record<string, string>
  )[key] ?? 'Synthetic rule check';
