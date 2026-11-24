import { describe, expect, it } from 'vitest';
import { validatePackManifest, planPackItems, planPackUpgrade } from '@ensemus/domain/pack';
import { checkDepartmentPack } from '@ensemus/domain/department-pack';
import { hrOperationsPack } from './index';
import { describePackConformance } from '../testing';
import { compileProcessGraph } from '@ensemus/domain/process-spec';
import { simulateProcess } from '@ensemus/domain/process-run';

describePackConformance(hrOperationsPack, {
  forbiddenTools: [/(send|secret|payment|transfer|employment\.read)/i],
});

describe('HR through the actual installer contract', () => {
  it('ships both versions for real upgrade and rollback', () => {
    expect(hrOperationsPack.map((pack) => pack.version)).toEqual(['1.0.0', '1.1.0']);
    for (const pack of hrOperationsPack) {
      expect(validatePackManifest(pack)).toEqual([]);
      expect(checkDepartmentPack(pack)).toEqual([]);
    }
    expect(planPackUpgrade(hrOperationsPack[0]!, hrOperationsPack[1]!).refused).toBe(false);
  });
  it('keeps all personal record types out when restricted review is declined', () => {
    const pack = hrOperationsPack[0]!;
    expect(pack).toBeDefined();
    const decisions = Object.fromEntries(
      pack.capabilities.map(
        (cap) => [cap.key, cap.subject === 'restricted' ? 'declined' : 'accepted'] as const,
      ),
    );
    const plan = planPackItems(pack, decisions, [
      { id: 'work.read', version: '1', class: 'read_only', requiresApproval: false },
      { id: 'artifact.draft.create', version: '1', class: 'draft_only', requiresApproval: false },
    ]);
    expect(plan.objectTypes).toEqual([]);
    expect(plan.agentDrafts).toHaveLength(1);
    expect(plan.processes).toHaveLength(1);
  });
  it('gives the assistant only public/internal work and draft tools and makes no personal judgement fields', () => {
    expect(hrOperationsPack).toHaveLength(2);
    for (const pack of hrOperationsPack) {
      expect(JSON.stringify(pack)).not.toMatch(/\b(score|rating|performance)\b/i);
      for (const type of pack.objectTypes) expect(type.classification).toBe('restricted');
      const assistant = pack.agentDrafts[0]!;
      expect(assistant.answers.dataClasses).toEqual(['public', 'internal']);
      expect(assistant.answers.toolIds).toEqual(['work.read', 'artifact.draft.create']);
      expect(assistant.answers.maxCostMicros).toBeNull();
      expect(
        pack.processes.flatMap((process) =>
          process.graph.nodes.filter((node) => node.kind === 'external_action'),
        ),
      ).toEqual([]);
    }
  });
  it('requires a human decision before fulfilling a checklist and refuses restricted effects', () => {
    const pack = hrOperationsPack[0]!,
      process = pack.processes[0]!;
    const compiled = compileProcessGraph(
      process.graph,
      { classification: 'internal', agentDefinitionIds: new Set(), toolIds: new Set() },
      () => '0'.repeat(64),
    );
    expect(compiled.issues).toEqual([]);
    const denied = pack.scenarios.find(
      (scenario) => scenario.key === 'new_employee_onboarding.denied_skip_human_decision',
    )!;
    expect(simulateProcess(compiled.spec!, '0'.repeat(64), denied).outcome).toBe('failed');
    expect(
      checkDepartmentPack({
        ...pack,
        capabilities: pack.capabilities.map((cap) =>
          cap.subject === 'restricted' ? { ...cap, risk: 'low' } : cap,
        ),
      }).map((finding) => finding.rule),
    ).toContain('RESTRICTED_NOT_ELEVATED');
    expect(
      checkDepartmentPack({
        ...pack,
        processes: [
          {
            ...process,
            classification: 'restricted',
            graph: {
              ...process.graph,
              nodes: [
                ...process.graph.nodes,
                {
                  id: 'effect',
                  kind: 'external_action',
                  toolId: 'email.send',
                  label: 'Unapproved effect',
                  x: 0,
                  y: 1,
                },
              ],
              edges: [
                ...process.graph.edges,
                { from: 'start', to: 'effect' },
                { from: 'effect', to: 'end' },
              ],
            },
          },
        ],
      }).map((finding) => finding.rule),
    ).toContain('PROCESS_RESTRICTED_EFFECT');
  });
});
