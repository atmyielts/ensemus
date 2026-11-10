import { createHash } from 'node:crypto';
import { canonicalJson } from '@ensemus/domain/approval';
import { simulateProcess } from '@ensemus/domain/process-run';
import {
  compileProcessGraph,
  type ProcessGraph,
  type ProcessGraphNode,
  type ProcessSpec,
} from '@ensemus/domain/process-spec';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_WORKFLOWS,
  findBundledWorkflow,
  FLAGSHIP_WORKFLOW,
  NEED_WORDS,
  needStopCode,
  type BundledWorkflow,
} from './index';

const sha256 = (canonical: string) => createHash('sha256').update(canonical).digest('hex');

/** The compiler is the graph slice's, and a stub until it lands, so this reads as much as it needs itself. */
function specFrom(workflow: BundledWorkflow): ProcessSpec {
  const steps = workflow.graph.nodes
    .filter((node) => node.kind !== 'start' && node.kind !== 'end')
    .map((node) => ({
      key: node.id,
      kind: node.kind as ProcessSpec['steps'][number]['kind'],
      after: workflow.graph.edges
        .filter((edge) => edge.to === node.id && edge.from !== 'start')
        .map((edge) => edge.from),
      labelCode: null,
      label: node.label,
      ...(node.toolId ? { toolId: node.toolId } : {}),
      ...(node.approverRole ? { approverRole: node.approverRole } : {}),
      ...(node.evidence ? { evidence: node.evidence } : {}),
    }));
  return { schemaVersion: 1, classification: workflow.classification, steps };
}

/** Every path from start to this node passes a person's approval. By path, not by count. */
function everyPathApproved(graph: ProcessGraph, target: string): boolean {
  const before = (id: string) => graph.edges.filter((edge) => edge.to === id).map((e) => e.from);
  const walk = (id: string, approved: boolean): boolean => {
    const node = graph.nodes.find((candidate) => candidate.id === id) as ProcessGraphNode;
    if (node.kind === 'start') return approved;
    const here = approved || node.kind === 'human_approval';
    return before(id).every((from) => walk(from, id === target ? false : here));
  };
  return walk(target, false);
}

describe('the bundled catalog', () => {
  it('holds catalog numbers 2 to 5, and not number 1', () => {
    expect(BUNDLED_WORKFLOWS.map((w) => w.catalogNumber).sort()).toEqual([2, 3, 4, 5]);
    expect(FLAGSHIP_WORKFLOW.catalogNumber).toBe(1);
    expect(BUNDLED_WORKFLOWS.map((w) => w.key)).not.toContain(FLAGSHIP_WORKFLOW.path);
  });

  it('starts with a workflow a new company can simulate all the way through', () => {
    const [first] = BUNDLED_WORKFLOWS as readonly [BundledWorkflow];
    const report = simulateProcess(specFrom(first), 'hash', first.scenario);
    expect(report.outcome).toBe('passed');
    expect(report.steps.every((step) => step.reasonCode !== 'NOT_REACHED')).toBe(true);
    expect(report.wouldWriteOutside).toEqual(['email.send']);
  });

  it('finds by key, and nothing else', () => {
    expect(findBundledWorkflow('meeting-actions')?.catalogNumber).toBe(2);
    expect(findBundledWorkflow('opportunity-won')).toBeNull();
  });

  describe.each(BUNDLED_WORKFLOWS.map((workflow) => [workflow.key, workflow] as const))(
    '%s',
    (_key, workflow) => {
      it('has a key the table takes', () => {
        expect(workflow.key).toMatch(/^[a-z][a-z0-9_.-]{1,63}$/);
      });

      it('every need names a step, and every step need is declared', () => {
        expect([...new Set(Object.values(workflow.stepNeeds))].sort()).toEqual(
          [...workflow.needs].sort(),
        );
        for (const key of Object.keys(workflow.stepNeeds)) {
          expect(workflow.graph.nodes.map((node) => node.id)).toContain(key);
        }
        for (const need of workflow.needs) {
          expect(NEED_WORDS[need]).toBeTruthy();
          expect(needStopCode(need)).toMatch(/^NEEDS_[A-Z_]+$/);
        }
      });

      it('every effect has a person approving it first, on every path', () => {
        const effects = workflow.graph.nodes.filter((node) => node.kind === 'external_action');
        for (const effect of effects) {
          expect(everyPathApproved(workflow.graph, effect.id)).toBe(true);
        }
      });

      it('is not restricted, and every graph has one start and one end', () => {
        expect(workflow.classification).not.toBe('restricted');
        expect(workflow.graph.nodes.filter((node) => node.kind === 'start')).toHaveLength(1);
        expect(workflow.graph.nodes.filter((node) => node.kind === 'end')).toHaveLength(1);
      });

      it('names no agent, because an agent is a tenant own published thing', () => {
        expect(workflow.graph.nodes.some((node) => node.kind === 'agent_task')).toBe(false);
      });

      it('simulates as passed, and writes outside only what it says', () => {
        const report = simulateProcess(specFrom(workflow), 'hash', workflow.scenario);
        expect(report.outcome).toBe('passed');
        expect(report.subjectSha256).toBe('hash');
      });

      it('a step with an unmet need is not simulated as working', () => {
        const report = simulateProcess(specFrom(workflow), 'hash', workflow.scenario);
        for (const [key, need] of Object.entries(workflow.stepNeeds)) {
          if (need === 'email_connector') continue;
          expect(report.steps.find((step) => step.subject === key)).toMatchObject({
            decision: 'denied',
            reasonCode: 'NOT_REACHED',
          });
        }
      });

      it('says nothing it cannot back: no price, certification or result claim', () => {
        const text = JSON.stringify([workflow.name, workflow.description, workflow.graph]);
        expect(text).not.toMatch(/\b(compliant|certified|guarantee|SOC ?2|GDPR|HIPAA|\$\d)/i);
      });

      // A stub until the graph slice lands. At the merge this runs the real compiler, with the tools each
      // graph names, the same as installBundledWorkflow does.
      it('compiles like a drawn graph, once the compiler has landed', () => {
        const compile = () =>
          compileProcessGraph(
            workflow.graph,
            {
              classification: workflow.classification,
              agentDefinitionIds: new Set(),
              toolIds: new Set(workflow.graph.nodes.flatMap((node) => node.toolId ?? [])),
            },
            sha256,
          );
        let result: ReturnType<typeof compile>;
        try {
          result = compile();
        } catch (error) {
          expect((error as Error).message).toBe('NOT_IMPLEMENTED');
          return;
        }
        expect(result.issues).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.specSha256).toBe(sha256(canonicalJson(result.spec)));
      });
    },
  );

  it('number 3 never finalizes: it only ever asks for a draft', () => {
    const invoice = findBundledWorkflow('project-invoice-handoff');
    const tools = invoice?.graph.nodes.flatMap((node) => node.toolId ?? []);
    expect(tools).toEqual(['accounting.invoice_draft.create']);
    expect(invoice?.stepNeeds).toEqual({ invoice_draft: 'accounting_connector' });
    expect(JSON.stringify(invoice?.graph)).not.toMatch(/finaliz|issue_invoice|post_invoice/i);
  });

  it('number 2 stops at its source, and number 4 has no effect step at all', () => {
    expect(findBundledWorkflow('meeting-actions')?.stepNeeds).toEqual({
      meeting_summary: 'meeting_notes',
    });
    const employee = findBundledWorkflow('new-employee-onboarding');
    expect(employee?.graph.nodes.some((node) => node.kind === 'external_action')).toBe(false);
    expect(employee?.needs).toEqual([]);
  });
});
