// Additional department review rules (EXP-01, ADR-033 D1), on the same format the actual installer reads.

// Use the installer's actual format, so later changes cannot silently fork the pack contract.
import type { PackManifest, PackCapabilityKind } from './pack';
export type { PackCapability, PackCapabilityKind } from './pack';
export type DepartmentPackManifest = PackManifest;
export type PackClassification = PackManifest['objectTypes'][number]['classification'];
export type PackObjectField = PackManifest['objectTypes'][number]['fields'][number];
export type PackObjectRelation = PackManifest['objectTypes'][number]['relations'][number];
export type PackAgentAnswers = PackManifest['agentDrafts'][number]['answers'];
export type PackGraph = PackManifest['processes'][number]['graph'];
export type PackGraphNode = PackGraph['nodes'][number];
export type PackScenario = PackManifest['scenarios'][number];

export type PackFinding = {
  /** A fixed code, so a test can name exactly which rule a pack broke. */
  rule: string;
  /** The offending key, tool or name. Never the words of a string. */
  subject: string;
};

type Add = (rule: string, subject: string) => void;

const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const CAPABILITY_KEY = /^[a-z][a-z0-9_.-]{1,127}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Copied from M7's OBJECT_LIMITS and RESERVED_OBJECT_SLUGS, which its own validation holds too. */
const MAX_FIELDS = 64;
const MAX_INDEXED_FIELDS = 8;
const MAX_NODES = 64;
const MAX_EDGES = 128;
const MAX_LABEL_LENGTH = 120;
const RESERVED_SLUGS = new Set([
  'work_unit',
  'approval',
  'grant',
  'invoice',
  'billing',
  'membership',
  'organization',
  'agent',
  'secret',
]);

/** Tools that move money, in any spelling. No pack may ask for one, in any department, by default. */
const MONEY_MOVEMENT = /(^|[._-])(transfer|payment|payout|pay|wire|refund|disburse|remit)([._-]|$)/;
/** Tools that reach many people at once. Bulk outreach needs a sanctioned path that does not exist. */
const BULK_OUTREACH = /(^|[._-])(bulk|blast|mass|broadcast)([._-]|$)/;
/** Never in any request, whatever else is true. */
const NEVER_ALLOWED = /(^|[._-])secrets?([._-]|$)/;
/** A pack cannot say it provides compliance (catalog, "Universality constraints"). */
const COMPLIANCE_CLAIM = /\b(compliant|compliance with|certified|guarantee[sd]?)\b/i;
/** A name reads as a read or a draft inside Ensemus only with one of these. Anything else is an effect. */
const READ_ONLY_VERB = /[._-](read|search|list|get|draft)([._-]|$)/;

const toolsOf = (pack: DepartmentPackManifest): ReadonlySet<string> =>
  new Set([
    ...pack.agentDrafts.flatMap((agent) => agent.answers.toolIds),
    ...pack.processes.flatMap((process) =>
      process.graph.nodes.flatMap((node) => (node.toolId ? [node.toolId] : [])),
    ),
  ]);

function checkTools(pack: DepartmentPackManifest, add: Add) {
  const subjects = pack.capabilities
    .filter(
      (capability) => capability.kind === 'agent_tool' || capability.kind === 'external_effect',
    )
    .map((capability) => capability.subject);
  for (const tool of new Set([...toolsOf(pack), ...subjects])) {
    if (MONEY_MOVEMENT.test(tool)) add('TOOL_MOVES_MONEY', tool);
    if (BULK_OUTREACH.test(tool)) add('TOOL_BULK_OUTREACH', tool);
    if (NEVER_ALLOWED.test(tool)) add('TOOL_NEVER_ALLOWED', tool);
  }
}

const hasCapability = (
  pack: DepartmentPackManifest,
  kind: PackCapabilityKind,
  subject: string,
): boolean =>
  pack.capabilities.some(
    (capability) => capability.kind === kind && capability.subject === subject,
  );

/** Everything an administrator is asked about, and everything it could cover, has to line up. */
function checkCapabilities(pack: DepartmentPackManifest, add: Add) {
  const items = new Set([
    ...pack.objectTypes.flatMap((object) => [object.slug, `object_type:${object.slug}`]),
    ...pack.agentDrafts.flatMap((agent) => [agent.key, `agent_draft:${agent.key}`]),
    ...pack.processes.flatMap((process) => [process.key, `process_draft:${process.key}`]),
  ]);
  const keys = new Set<string>();
  for (const capability of pack.capabilities) {
    if (!CAPABILITY_KEY.test(capability.key)) add('CAPABILITY_KEY_FORMAT', capability.key);
    if (keys.has(capability.key)) add('CAPABILITY_KEY_REPEATED', capability.key);
    keys.add(capability.key);
    if (capability.requiredBy.length === 0) add('CAPABILITY_REQUIRED_BY_NOTHING', capability.key);
    for (const item of capability.requiredBy) {
      if (!items.has(item)) add('CAPABILITY_UNKNOWN_ITEM', `${capability.key}:${item}`);
    }
    if (capability.kind === 'external_effect' && capability.risk !== 'elevated') {
      add('CAPABILITY_EFFECT_NOT_ELEVATED', capability.key);
    }
  }
  for (const object of pack.objectTypes) {
    if (!hasCapability(pack, 'object_type', object.slug)) add('OBJECT_NOT_ASKED', object.slug);
    if (object.classification === 'confidential' || object.classification === 'restricted') {
      if (!hasCapability(pack, 'data_class', object.classification)) {
        add('DATA_CLASS_NOT_ASKED', object.slug);
      }
    }
    // Restricted data is the catalog's "strict employment data isolation", so it is never a low-risk ask.
    if (
      object.classification === 'restricted' &&
      pack.capabilities.some(
        (capability) =>
          capability.kind === 'data_class' &&
          capability.subject === 'restricted' &&
          capability.risk !== 'elevated',
      )
    ) {
      add('RESTRICTED_NOT_ELEVATED', object.slug);
    }
  }
  for (const agent of pack.agentDrafts) {
    for (const tool of agent.answers.toolIds) {
      if (!hasCapability(pack, 'agent_tool', tool)) add('TOOL_NOT_ASKED', tool);
    }
  }
  for (const process of pack.processes) {
    for (const node of process.graph.nodes) {
      if (node.kind === 'external_action' && node.toolId) {
        if (!hasCapability(pack, 'external_effect', node.toolId))
          add('EFFECT_NOT_ASKED', node.toolId);
      }
    }
  }
}

function checkObjects(pack: DepartmentPackManifest, add: Add) {
  const slugs = new Set(pack.objectTypes.map((object) => object.slug));
  if (slugs.size !== pack.objectTypes.length) add('OBJECT_SLUG_REPEATED', pack.key);
  for (const object of pack.objectTypes) {
    if (!KEY.test(object.slug)) add('OBJECT_SLUG_FORMAT', object.slug);
    if (RESERVED_SLUGS.has(object.slug)) add('OBJECT_SLUG_RESERVED', object.slug);
    if (object.fields.length === 0) add('OBJECT_NO_FIELDS', object.slug);
    if (object.fields.length > MAX_FIELDS) add('OBJECT_TOO_MANY_FIELDS', object.slug);
    if (object.fields.filter((field) => field.indexed).length > MAX_INDEXED_FIELDS) {
      add('OBJECT_TOO_MANY_INDEXED', object.slug);
    }
    const fieldKeys = new Set<string>();
    for (const field of object.fields) {
      const name = `${object.slug}.${field.key}`;
      if (!KEY.test(field.key)) add('FIELD_KEY_FORMAT', name);
      if (fieldKeys.has(field.key)) add('FIELD_KEY_REPEATED', name);
      fieldKeys.add(field.key);
      if (field.kind === 'enum' && !field.options?.length) add('ENUM_NO_OPTIONS', name);
    }
    for (const relation of object.relations) {
      if (!slugs.has(relation.toTypeSlug)) {
        add('RELATION_UNKNOWN_TYPE', `${object.slug}.${relation.key}`);
      }
    }
  }
}

function checkAgents(pack: DepartmentPackManifest, add: Add) {
  const keys = new Set<string>();
  for (const { key, answers } of pack.agentDrafts) {
    if (!KEY.test(key)) add('AGENT_KEY_FORMAT', key);
    if (keys.has(key)) add('AGENT_KEY_REPEATED', key);
    keys.add(key);
    // A limit is a person's to set, and a number here would read as a price nobody agreed to.
    if (answers.maxCostMicros !== null) add('AGENT_SETS_COST', key);
    // An agent in a pack proposes. An effect is a process step behind a person's approval.
    if (answers.autonomy === 'act_with_approval') add('AGENT_ACTS', key);
    for (const tool of answers.toolIds) {
      if (!READ_ONLY_VERB.test(tool)) add('AGENT_TOOL_HAS_EFFECT', tool);
    }
    if (answers.boundaries.length === 0) add('AGENT_NO_BOUNDARIES', key);
  }
}

/** Whether any path from `start` reaches an effect with no approval on the way. Also what M7's compiler says. */
function effectsWithoutApproval(graph: PackGraph): readonly string[] {
  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const start = graph.nodes.find((node) => node.kind === 'start');
  const found = new Set<string>();
  if (!start) return [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    // Past an approval, this path is allowed, so it stops being this walk's concern.
    if (kinds.get(id) === 'human_approval') return;
    if (kinds.get(id) === 'external_action') found.add(id);
    for (const edge of graph.edges) if (edge.from === id) walk(edge.to);
  };
  walk(start.id);
  return [...found];
}

function hasCycle(graph: PackGraph): boolean {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'visiting') return true;
    state.set(id, 'visiting');
    const cycle = graph.edges.some((edge) => edge.from === id && visit(edge.to));
    state.set(id, 'done');
    return cycle;
  };
  return graph.nodes.some((node) => visit(node.id));
}

function checkProcesses(pack: DepartmentPackManifest, add: Add) {
  const keys = new Set<string>();
  for (const process of pack.processes) {
    const { key, graph, classification } = process;
    if (!KEY.test(key)) add('PROCESS_KEY_FORMAT', key);
    if (keys.has(key)) add('PROCESS_KEY_REPEATED', key);
    keys.add(key);
    if (graph.nodes.length > MAX_NODES || graph.edges.length > MAX_EDGES) {
      add('PROCESS_TOO_LARGE', key);
    }
    if (graph.nodes.filter((node) => node.kind === 'start').length !== 1) {
      add('PROCESS_ONE_START', key);
    }
    if (!graph.nodes.some((node) => node.kind === 'end')) add('PROCESS_NO_END', key);
    const ids = new Set(graph.nodes.map((node) => node.id));
    if (ids.size !== graph.nodes.length) add('PROCESS_NODE_REPEATED', key);
    if (graph.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) {
      add('PROCESS_DANGLING_EDGE', key);
    }
    // No unbounded loops, which the catalog forbids, and which a spec cannot express.
    if (hasCycle(graph)) add('PROCESS_CYCLE', key);
    for (const id of effectsWithoutApproval(graph)) add('PROCESS_EFFECT_WITHOUT_APPROVAL', id);
    for (const node of graph.nodes) {
      if (node.label.length > MAX_LABEL_LENGTH) add('PROCESS_LABEL_TOO_LONG', node.id);
      if (node.kind === 'external_action' && classification === 'restricted') {
        add('PROCESS_RESTRICTED_EFFECT', node.id);
      }
      if (node.kind === 'external_action' && !node.toolId) add('PROCESS_EFFECT_NO_TOOL', node.id);
    }
  }
}

function checkScenarios(pack: DepartmentPackManifest, add: Add) {
  const items = [
    ...pack.agentDrafts.map((agent) => agent.key),
    ...pack.processes.map((process) => process.key),
  ];
  const keys = new Set(pack.scenarios.map((scenario) => scenario.key));
  if (keys.size !== pack.scenarios.length) add('SCENARIO_KEY_REPEATED', pack.key);
  for (const item of items) {
    if (!pack.scenarios.some((scenario) => scenario.key.startsWith(`${item}.`))) {
      add('SCENARIO_ITEM_NOT_COVERED', item);
    }
  }
  for (const scenario of pack.scenarios) {
    if (!items.some((item) => scenario.key.startsWith(`${item}.`))) {
      add('SCENARIO_UNKNOWN_ITEM', scenario.key);
    }
  }
  if (!pack.scenarios.some((scenario) => scenario.key.includes('.denied_'))) {
    add('SCENARIO_NO_GUARDRAIL', pack.key);
  }
}

function checkWords(pack: DepartmentPackManifest, add: Add) {
  for (const capability of pack.capabilities) {
    if (!pack.strings[capability.reasonCode]) add('STRINGS_MISSING_KEY', capability.reasonCode);
  }
  const claims: readonly (readonly [string, string])[] = [
    ['name', pack.name],
    ['description', pack.description],
    ...Object.entries(pack.strings),
    ...pack.agentDrafts.flatMap(({ key, answers }) => [
      [`${key}.role`, answers.role] as const,
      [`${key}.outcome`, answers.intendedOutcome] as const,
    ]),
  ];
  for (const [where, words] of claims) {
    if (COMPLIANCE_CLAIM.test(words)) add('STRINGS_COMPLIANCE_CLAIM', where);
  }
}

/**
 * This milestone's review rules, as far as they can be checked without a person. An empty list means the pack
 * is fit to be reviewed, and not that it was. Whatever a person has to decide stays a capability, for them to
 * decide. `validatePackManifest` in M7 is the rest of the review, and a pack has to pass both.
 */
export function checkDepartmentPack(pack: DepartmentPackManifest): readonly PackFinding[] {
  const findings: PackFinding[] = [];
  const add: Add = (rule, subject) => findings.push({ rule, subject });
  if (pack.schemaVersion !== 1) add('PACK_SCHEMA_VERSION', pack.key);
  if (!KEY.test(pack.key)) add('PACK_KEY_FORMAT', pack.key);
  if (!SEMVER.test(pack.version)) add('PACK_VERSION_FORMAT', pack.key);
  if (pack.publisher !== 'ensemus') add('PACK_PUBLISHER', pack.key);
  if (pack.capabilities.length === 0) add('PACK_ASKS_NOTHING', pack.key);
  checkCapabilities(pack, add);
  checkObjects(pack, add);
  checkAgents(pack, add);
  checkProcesses(pack, add);
  checkTools(pack, add);
  checkScenarios(pack, add);
  checkWords(pack, add);
  return findings;
}

function versionAfter(from: string, to: string): boolean {
  const a = SEMVER.exec(from);
  const b = SEMVER.exec(to);
  if (!a || !b) return false;
  for (const part of [1, 2, 3]) {
    const difference = Number(b[part]) - Number(a[part]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * The rollback rules for one upgrade, as ADR-031 D10 states them: it has to move forward, it can remove
 * nothing, because rollback never loses data, and a capability cannot quietly change what it means. A new one
 * comes back for review under M7's installer, and `newCapabilitiesIn` is how a pack's test says which.
 */
export function checkPackUpgrade(
  from: DepartmentPackManifest,
  to: DepartmentPackManifest,
): readonly PackFinding[] {
  const findings: PackFinding[] = [];
  const add: Add = (rule, subject) => findings.push({ rule, subject });
  if (to.key !== from.key) add('UPGRADE_OTHER_PACK', to.key);
  if (!versionAfter(from.version, to.version)) add('UPGRADE_NOT_FORWARD', to.version);

  for (const object of from.objectTypes) {
    const next = to.objectTypes.find((candidate) => candidate.slug === object.slug);
    if (!next) {
      add('UPGRADE_REMOVES_ITEM', object.slug);
      continue;
    }
    if (next.classification !== object.classification) {
      add('UPGRADE_CHANGES_CLASS', object.slug);
    }
    for (const field of object.fields) {
      const kept = next.fields.find((candidate) => candidate.key === field.key);
      if (!kept) add('UPGRADE_REMOVES_FIELD', `${object.slug}.${field.key}`);
      else if (kept.kind !== field.kind)
        add('UPGRADE_CHANGES_FIELD', `${object.slug}.${field.key}`);
    }
  }
  for (const agent of from.agentDrafts) {
    if (!to.agentDrafts.some((candidate) => candidate.key === agent.key)) {
      add('UPGRADE_REMOVES_ITEM', agent.key);
    }
  }
  for (const process of from.processes) {
    if (!to.processes.some((candidate) => candidate.key === process.key)) {
      add('UPGRADE_REMOVES_ITEM', process.key);
    }
  }
  for (const capability of from.capabilities) {
    const next = to.capabilities.find((candidate) => candidate.key === capability.key);
    if (!next) add('UPGRADE_REMOVES_CAPABILITY', capability.key);
    else if (next.kind !== capability.kind || next.subject !== capability.subject) {
      // The old acceptance would otherwise read as agreeing to something else.
      add('UPGRADE_CHANGES_CAPABILITY', capability.key);
    }
  }
  return findings;
}

/** What an upgrade asks for that the old version did not. M7's installer sends each back to a person. */
export const newCapabilitiesIn = (
  from: DepartmentPackManifest,
  to: DepartmentPackManifest,
): readonly string[] =>
  to.capabilities
    .filter((capability) => !from.capabilities.some((old) => old.key === capability.key))
    .map((capability) => capability.key);
