// The pack itself, against the same rules as anyone's (AGENT-14, QA-039, QA-040). `validateObjectSchema`,
// `planTypeMigration` and `compileProcessGraph` are other slices' stubs on this branch. Each double stands in
// only while the real one says NOT_IMPLEMENTED, so after the merge this runs against the real rules unedited.
import type { ObjectField, TypeMigrationPlan } from '@ensemus/domain/custom-object';
import {
  dataAccessStringKey,
  itemsAllowedBy,
  planPackItems,
  planPackUpgrade,
  sideEffectsStringKey,
  validatePackManifest,
  type PackManifest,
} from '@ensemus/domain/pack';
import type { CompileResult, ProcessGraph } from '@ensemus/domain/process-spec';
import { describe, expect, it, vi } from 'vitest';
import { findPack, PACK_CATALOG } from '../index';
import { salesOperationsPack } from './index';

const stubs = vi.hoisted(() => ({
  orElse:
    <A extends unknown[], R>(real: (...args: A) => R, fallback: (...args: A) => R) =>
    (...args: A): R => {
      try {
        return real(...args);
      } catch (error) {
        if (error instanceof Error && error.message === 'NOT_IMPLEMENTED') return fallback(...args);
        throw error;
      }
    },
}));

vi.mock('@ensemus/domain/custom-object', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ensemus/domain/custom-object')>();
  const plan = (from: readonly ObjectField[], to: readonly ObjectField[]): TypeMigrationPlan => {
    const steps: TypeMigrationPlan['steps'][number][] = [];
    for (const field of from) {
      if (!to.some((candidate) => candidate.key === field.key)) {
        steps.push({ kind: 'remove', key: field.key, refused: true });
      }
    }
    for (const field of to) {
      if (from.some((candidate) => candidate.key === field.key)) continue;
      steps.push(
        field.required
          ? { kind: 'add_required', key: field.key, refused: true }
          : { kind: 'add_optional', key: field.key },
      );
    }
    return { safe: !steps.some((step) => 'refused' in step), steps };
  };
  return {
    ...real,
    validateObjectSchema: stubs.orElse(real.validateObjectSchema, () => []),
    planTypeMigration: stubs.orElse(real.planTypeMigration, plan),
  };
});

vi.mock('@ensemus/domain/process-spec', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ensemus/domain/process-spec')>();
  const compile = (_graph: ProcessGraph): CompileResult => ({
    ok: true,
    spec: { schemaVersion: 1, classification: 'internal', steps: [] },
    specSha256: '',
    issues: [],
  });
  return { ...real, compileProcessGraph: stubs.orElse(real.compileProcessGraph, compile) };
});

const [first, second] = salesOperationsPack as readonly [PackManifest, PackManifest];

const toolIdsOf = (manifest: PackManifest) => [
  ...manifest.agentDrafts.flatMap((draft) => draft.answers.toolIds),
  ...manifest.processes.flatMap((process) =>
    process.graph.nodes.flatMap((node) => (node.toolId ? [node.toolId] : [])),
  ),
  ...manifest.capabilities
    .filter((capability) => ['agent_tool', 'external_effect'].includes(capability.kind))
    .map((capability) => capability.subject),
];

const accepted = (manifest: PackManifest) =>
  Object.fromEntries(manifest.capabilities.map((item) => [item.key, 'accepted' as const]));

/** M4's catalog as `git show m4-foundation:packages/domain/src/ai-tools.ts` has it. */
const M4_TOOLS = [
  { id: 'work.read', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'artifact.read_text', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'artifact.draft.create', version: '1', class: 'draft_only', requiresApproval: false },
  { id: 'email.send', version: '1', class: 'external_write', requiresApproval: true },
  { id: 'agent.delegate', version: '1', class: 'delegation', requiresApproval: false },
] as const;

describe('the Sales operations pack', () => {
  it('ships 1.0.0 and 1.1.0, oldest first, both in the catalog', () => {
    expect(salesOperationsPack.map((pack) => pack.version)).toEqual(['1.0.0', '1.1.0']);
    expect(PACK_CATALOG).toEqual(expect.arrayContaining([...salesOperationsPack]));
    expect(findPack('sales-operations', '1.0.0')).toBe(first);
    expect(findPack('sales-operations', '9.9.9')).toBeNull();
    expect(findPack('other', '1.0.0')).toBeNull();
  });

  it.each(salesOperationsPack.map((pack) => [pack.version, pack] as const))(
    '%s passes validation like anyone else',
    (_version, pack) => {
      expect(validatePackManifest(pack)).toEqual([]);
    },
  );

  it.each(salesOperationsPack.map((pack) => [pack.version, pack] as const))(
    '%s names no bulk tool, and every tool it names is one M4 has',
    (_version, pack) => {
      const known: readonly string[] = M4_TOOLS.map((tool) => tool.id);
      for (const toolId of toolIdsOf(pack)) {
        expect(toolId).not.toMatch(/bulk|mass|broadcast|campaign|blast|list/i);
        expect(known).toContain(toolId);
      }
    },
  );

  it.each(salesOperationsPack.map((pack) => [pack.version, pack] as const))(
    '%s sends only by acting with approval, or past a person in a workflow',
    (_version, pack) => {
      for (const draft of pack.agentDrafts) {
        if (draft.answers.toolIds.includes('email.send')) {
          expect(draft.answers.autonomy).toBe('act_with_approval');
        }
      }
      const sends = pack.processes.filter((process) =>
        process.graph.nodes.some((node) => node.kind === 'external_action'),
      );
      expect(sends.length).toBeGreaterThan(0);
      for (const process of sends) {
        const order = process.graph.nodes.map((node) => node.kind);
        expect(order.indexOf('human_approval')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('human_approval')).toBeLessThan(order.indexOf('external_action'));
      }
    },
  );

  it.each(salesOperationsPack.map((pack) => [pack.version, pack] as const))(
    '%s leaves every spending cap to the person who owns the draft',
    (_version, pack) => {
      for (const draft of pack.agentDrafts) expect(draft.answers.maxCostMicros).toBeNull();
    },
  );

  it.each(salesOperationsPack.map((pack) => [pack.version, pack] as const))(
    '%s says in plain words what each request reads and changes',
    (_version, pack) => {
      for (const capability of pack.capabilities) {
        expect(pack.strings[capability.reasonCode]).toBeTruthy();
        expect(pack.strings[dataAccessStringKey(capability.key)]).toBeTruthy();
        expect(pack.strings[sideEffectsStringKey(capability.key)]).toBeTruthy();
      }
    },
  );

  it.each(salesOperationsPack.map((pack) => [pack.version, pack] as const))(
    '%s scenarios are scripts with a standard and a hostile case per kind of tool',
    (_version, pack) => {
      const keys = pack.scenarios.map((scenario) => scenario.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'sales.follow_up.standard',
          'sales.follow_up.prompt_injection',
          'sales.send.standard',
          'sales.send.prompt_injection',
        ]),
      );
      // Codes and tool names only, so no made-up person, address or company can sit in a report.
      for (const scenario of pack.scenarios) {
        for (const turn of scenario.turns) {
          expect(Object.keys(turn).sort()).toEqual(
            turn.kind === 'tool' ? ['dataClass', 'kind', 'toolId'] : ['citesEvidence', 'kind'],
          );
        }
      }
    },
  );

  it('upgrades forward, with new requests coming back, and refuses to go the other way', () => {
    const plan = planPackUpgrade(first, second);
    expect(plan.refused).toBe(false);
    expect(plan.needsReview).toBe(true);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        { kind: 'new_capability', key: 'tool.artifact.read_text' },
        { kind: 'new_capability', key: 'type.sales_research_note' },
        { kind: 'migrate_type', key: 'sales_lead' },
        { kind: 'add_item', itemKind: 'object_type', key: 'sales_research_note' },
        { kind: 'new_draft_version', key: 'lead_research' },
        { kind: 'keep_item', itemKind: 'agent_draft', key: 'pipeline_follow_up' },
      ]),
    );
    expect(planPackUpgrade(second, first).refused).toBe(true);
  });

  it('still installs without the send when that one request is declined', () => {
    const allowed = itemsAllowedBy(first, { ...accepted(first), 'effect.email.send': 'declined' });
    expect(allowed.agentDrafts).toEqual([
      'pipeline_follow_up',
      'lead_research',
      'client_onboarding_plan',
    ]);
    expect(allowed.processes).toEqual(['client_onboarding_start']);
    expect(allowed.objectTypes).toEqual(['sales_lead', 'sales_follow_up']);
  });

  it('makes all it asks for once M4 has the tools, and only types and a toolless workflow before', () => {
    const ready = planPackItems(first, accepted(first), M4_TOOLS);
    expect(ready.leftOut).toEqual([]);
    const notYet = planPackItems(first, accepted(first), null);
    expect(notYet.objectTypes).toEqual(['sales_lead', 'sales_follow_up']);
    expect(notYet.agentDrafts).toEqual([]);
    expect(notYet.processes).toEqual(['client_onboarding_start']);
  });
});
