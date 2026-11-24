import { describe, expect, it } from 'vitest';
import { checkDepartmentPack } from '@ensemus/domain/department-pack';
import { compileProcessGraph } from '@ensemus/domain/process-spec';
import { simulateProcess } from '@ensemus/domain/process-run';
import { validatePackManifest, planPackUpgrade, planPackItems } from '@ensemus/domain/pack';
import { marketingOperationsPack } from './index';
import { describePackConformance } from '../testing';

describePackConformance(marketingOperationsPack, {
  forbiddenTools: [/(bulk|broadcast|mass|secret|payment|transfer)/i],
});
describe('marketing through the actual installer contract', () => {
  it.each(marketingOperationsPack)('validates the exact manifest at $version', (pack) => {
    expect(validatePackManifest(pack)).toEqual([]);
    const declined = planPackItems(
      pack,
      Object.fromEntries(
        pack.capabilities.map((capability) => [capability.key, 'declined'] as const),
      ),
      null,
    );
    expect(declined.objectTypes).toEqual([]);
    expect(declined.agentDrafts).toEqual([]);
    expect(declined.processes).toEqual([]);
  });
  it('adds an optional field without dropping old data or silently adding a capability', () => {
    const [old, next] = marketingOperationsPack;
    expect(planPackUpgrade(old!, next!).refused).toBe(false);
    expect(next!.objectTypes[0]!.fields.length).toBe(old!.objectTypes[0]!.fields.length + 1);
    expect(next!.objectTypes[0]!.fields.at(-1)?.required).toBe(false);
  });
  it('requires the source review and a person before the proposed send', () => {
    const pack = marketingOperationsPack[0]!;
    const graph = pack.processes[0]!.graph;
    const compile = (value: typeof graph) =>
      compileProcessGraph(
        value,
        {
          classification: 'internal',
          agentDefinitionIds: new Set(),
          toolIds: new Set(['email.send']),
        },
        () => '0'.repeat(64),
      );
    const good = compile(graph);
    expect(good.issues).toEqual([]);
    const denied = pack.scenarios.find(
      (scenario) => scenario.key === 'campaign_review.denied_send_without_approval',
    )!;
    expect(simulateProcess(good.spec!, '0'.repeat(64), denied).outcome).toBe('failed');
    const reordered = {
      ...graph,
      edges: graph.edges.filter((edge) => edge.to !== 'send').concat({ from: 'draft', to: 'send' }),
    };
    expect(
      checkDepartmentPack({
        ...pack,
        processes: [{ ...pack.processes[0]!, graph: reordered }],
      }).map((finding) => finding.rule),
    ).toContain('PROCESS_EFFECT_WITHOUT_APPROVAL');
  });
  it('keeps source-less claims as a denied evidence scenario and all agents as inactive drafts', () => {
    const pack = marketingOperationsPack[0]!;
    expect(
      pack.scenarios.find(
        (scenario) => scenario.key === 'claims_checker.denied_claim_without_source',
      )?.turns,
    ).toContainEqual({ kind: 'finish', citesEvidence: false });
    for (const agent of pack.agentDrafts) {
      expect(agent.answers.autonomy).toBe('draft_for_review');
      expect(agent.answers.maxCostMicros).toBeNull();
      expect(agent.answers.toolIds).not.toContain('email.send');
    }
  });
});
