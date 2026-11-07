import { describe, expect, it } from 'vitest';
import { agentFormAnswers } from '../../apps/web/src/lib/studio-input';
const owner = 'e6f6b4c3-6c7f-42f7-9612-bbfaaf6db747';
function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    role: 'Prepare a short brief.',
    intendedOutcome: 'A factual brief with citations.',
    boundaries: 'Do not send anything.\nUse only the supplied facts.',
    ownerMembershipId: owner.toUpperCase(),
    maxCostUsd: '0.125001',
    maxTurns: '4',
    maxToolCalls: '2',
    maxTotalTokens: '1000',
    timeoutSeconds: '60',
    qualityTier: 'balanced',
    autonomy: 'draft_for_review',
    memoryWrite: 'none',
    outputFormat: 'markdown_brief',
    dataCeiling: 'internal',
  }))
    data.set(key, value);
  return data;
}
describe('guided Studio form inputs', () => {
  it('converts explicit money exactly and canonicalizes selected IDs', () => {
    const data = form();
    data.append('knowledgeSourceIds', owner.toUpperCase());
    data.append('toolIds', 'work.read');
    const answers = agentFormAnswers(data);
    expect(answers.maxCostMicros).toBe(125001);
    expect(answers.ownerMembershipId).toBe(owner);
    expect(answers.knowledgeSourceIds).toEqual([owner]);
    expect(answers.dataClasses).toEqual(['internal']);
    expect(answers.boundaries).toEqual(['Do not send anything.', 'Use only the supplied facts.']);
  });
  it('retains no-spend draft semantics instead of inventing a budget', () => {
    const data = form();
    data.set('maxCostUsd', '');
    expect(agentFormAnswers(data).maxCostMicros).toBeNull();
  });
  it.each([
    ['maxCostUsd', '1e3'],
    ['maxCostUsd', '0.0000001'],
    ['maxTurns', ''],
    ['maxTurns', 'Infinity'],
    ['maxTotalTokens', '-1'],
    ['dataCeiling', 'restricted'],
    ['ownerMembershipId', 'not-an-id'],
  ])('refuses malformed %s', (key, value) => {
    const data = form();
    data.set(key, value);
    expect(() => agentFormAnswers(data)).toThrow();
  });
  it('does not take identity or proof from a forged field', () => {
    const data = form();
    data.set('sessionId', owner);
    data.set('userId', owner);
    expect(agentFormAnswers(data)).not.toHaveProperty('sessionId');
    expect(agentFormAnswers(data)).not.toHaveProperty('userId');
  });
});
