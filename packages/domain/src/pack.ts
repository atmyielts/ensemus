// Pack format (AGENT-14, docs/01-product/04-capability-catalog.md). A pack is data: it proposes things and
// grants nothing. Installing makes drafts and types, and each draft still goes through Studio's simulation
// and review before anything can act (ADR-031 D10). Owned by the packs slice.
import { AUTONOMY_MODES, MEMORY_WRITE_MODES } from './agent-draft';
import type { AgentDraftAnswers, ToolFacts } from './agent-draft';
import { planTypeMigration, validateObjectSchema } from './custom-object';
import type { ObjectField, ObjectRelationDefinition, TypeMigrationPlan } from './custom-object';
import { compileProcessGraph } from './process-spec';
import type { ProcessGraph, ProcessSpec } from './process-spec';
import type { SimulationScenario } from './simulation';

export type PackCapabilityKind =
  'object_type' | 'agent_tool' | 'data_class' | 'knowledge_source' | 'external_effect';

/** One thing an administrator is asked to accept or decline, in words on the page and data here. */
export type PackCapability = {
  key: string;
  kind: PackCapabilityKind;
  /** The tool, data class or type it concerns. */
  subject: string;
  /** Why the pack needs it, as a code the pack's own strings can word. */
  reasonCode: string;
  risk: 'low' | 'elevated';
  /** Declining this leaves the listed items out, and the pack still installs without them. */
  requiredBy: readonly string[];
};

export type PackManifest = {
  schemaVersion: 1;
  key: string;
  /** Semantic version. An upgrade must move it forward. */
  version: string;
  name: string;
  description: string;
  publisher: 'ensemus';
  capabilities: readonly PackCapability[];
  objectTypes: readonly {
    slug: string;
    displayName: string;
    classification: 'public' | 'internal' | 'confidential' | 'restricted';
    fields: readonly ObjectField[];
    relations: readonly ObjectRelationDefinition[];
  }[];
  /** The owner is whoever activates the pack, so a manifest cannot name one. */
  agentDrafts: readonly {
    key: string;
    name: string;
    answers: Omit<AgentDraftAnswers, 'ownerMembershipId' | 'knowledgeSourceIds'>;
  }[];
  processes: readonly {
    key: string;
    name: string;
    classification: ProcessSpec['classification'];
    graph: ProcessGraph;
  }[];
  /** Evaluation scenarios, synthetic, which Studio runs like any other. */
  scenarios: readonly SimulationScenario[];
  /** Word for every code above. Only `en` ships in M7. */
  strings: Readonly<Record<string, string>>;
};

export type UpgradeStep =
  | { kind: 'add_item'; itemKind: string; key: string }
  | { kind: 'keep_item'; itemKind: string; key: string }
  | { kind: 'migrate_type'; key: string }
  | { kind: 'new_draft_version'; key: string }
  | { kind: 'remove_item'; itemKind: string; key: string; refused: true }
  | { kind: 'new_capability'; key: string };

export type UpgradePlan = {
  fromVersion: string;
  toVersion: string;
  steps: readonly UpgradeStep[];
  /** A new capability always comes back for review, whatever was accepted before. */
  needsReview: boolean;
  refused: boolean;
};

export type PackIssue = { path: string; code: string };

/** How a capability's `requiredBy` names one of the manifest's items. */
export type PackItemKind = 'object_type' | 'agent_draft' | 'process_draft';
export const packItemRef = (kind: PackItemKind, key: string) => `${kind}:${key}`;

/** Where the page finds the plain words every request has to carry (docs/01-product/01, extensions). */
export const dataAccessStringKey = (capabilityKey: string) =>
  `capability.${capabilityKey}.data_access`;
export const sideEffectsStringKey = (capabilityKey: string) =>
  `capability.${capabilityKey}.side_effects`;

const PACK_KEY = /^[a-z][a-z0-9_-]{1,63}$/;
const ITEM_KEY = /^[a-z][a-z0-9_]{1,63}$/;
/** The same shape `decidePackCapabilitySchema` accepts, so every capability can actually be decided. */
const CAPABILITY_KEY = /^[a-z][a-z0-9_.-]{1,127}$/;
const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const CLASSIFICATIONS: readonly string[] = ['public', 'internal', 'confidential', 'restricted'];
const CAPABILITY_KINDS: readonly string[] = [
  'object_type',
  'agent_tool',
  'data_class',
  'knowledge_source',
  'external_effect',
];
/** M4 refuses these names at publish even for a future tool, so a pack cannot name one either. */
const FORBIDDEN_TOOL = /^(secrets?|model|budget|policy|grant)(\.|$)/i;
/** The catalog's guardrail for sales: no unsanctioned bulk outreach. No pack names a tool shaped like one. */
const BULK_TOOL = /(^|[._-])(bulk|mass|broadcast|blast|campaign|mailing)([._-]|$)/i;
/**
 * The catalog: integration packs cannot claim compliance. The owner's rule goes further for every string in a
 * pack: no compliance, legal, price or result claims. A word list cannot catch everything, and it does catch
 * the mistakes that are easy to make when writing a pack.
 */
const CLAIM =
  /\b(complian(t|ce)|certif(y|ied|ication)|gdpr|hipaa|ccpa|pci|soc ?2|iso ?27001|guarantee[sd]?|warrant(y|ies|ed)|legal(ly)?|lawful(ly)?|regulat(ed|ory|ions?)|audit[- ]?ready|pric(e|es|ing)|discounts?|roi|proven|best[- ]in[- ]class|increase[sd]?|boosts?|doubles?|revenue|win rate|conversions?|more (deals|sales|leads))\b|[$€£¥]\s?\d|\d\s?%/i;

/** Order-free comparison of plain data, so a key's position never makes two shapes look different. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

const parseVersion = (version: string): readonly [number, number, number] | null => {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

/** Negative when `a` comes first. Null when either is not a version at all. */
export function comparePackVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function checkClaims(manifest: PackManifest, add: (path: string, code: string) => void) {
  const check = (path: string, text: string) => {
    if (CLAIM.test(text)) add(path, 'CLAIM_NOT_ALLOWED');
  };
  check('name', manifest.name);
  check('description', manifest.description);
  for (const [key, text] of Object.entries(manifest.strings)) check(`strings.${key}`, text);
  manifest.objectTypes.forEach((type, index) => {
    check(`objectTypes[${index}].displayName`, type.displayName);
    type.fields.forEach((field, at) =>
      check(`objectTypes[${index}].fields[${at}].label`, field.label),
    );
  });
  manifest.agentDrafts.forEach((draft, index) => {
    const path = `agentDrafts[${index}]`;
    check(`${path}.name`, draft.name);
    check(`${path}.answers.role`, draft.answers.role);
    check(`${path}.answers.intendedOutcome`, draft.answers.intendedOutcome);
    draft.answers.boundaries.forEach((line, at) => check(`${path}.answers.boundaries[${at}]`, line));
  });
  manifest.processes.forEach((process, index) => {
    check(`processes[${index}].name`, process.name);
    process.graph.nodes.forEach((node, at) =>
      check(`processes[${index}].graph.nodes[${at}].label`, node.label),
    );
  });
}

function checkAgentDrafts(
  manifest: PackManifest,
  covered: (kinds: readonly PackCapabilityKind[], subject: string, ref: string) => boolean,
  add: (path: string, code: string) => void,
) {
  const effects = new Set(
    manifest.capabilities
      .filter((capability) => capability.kind === 'external_effect')
      .map((capability) => capability.subject),
  );
  manifest.agentDrafts.forEach((draft, index) => {
    const path = `agentDrafts[${index}]`;
    const ref = packItemRef('agent_draft', draft.key);
    const { answers } = draft;
    if (!ITEM_KEY.test(draft.key)) add(`${path}.key`, 'BAD_KEY');
    if (!draft.name.trim()) add(`${path}.name`, 'REQUIRED');
    // A manifest cannot choose who owns a draft or what it reads. Types say so, and this holds it at runtime.
    if ('ownerMembershipId' in answers) add(`${path}.answers.ownerMembershipId`, 'NOT_ALLOWED');
    if ('knowledgeSourceIds' in answers) add(`${path}.answers.knowledgeSourceIds`, 'NOT_ALLOWED');
    if (answers.triggerKind !== 'manual') add(`${path}.answers.triggerKind`, 'TRIGGER_NOT_OFFERED');
    if (!AUTONOMY_MODES.includes(answers.autonomy)) add(`${path}.answers.autonomy`, 'BAD_MODE');
    if (!MEMORY_WRITE_MODES.includes(answers.memoryWrite)) {
      add(`${path}.answers.memoryWrite`, 'BAD_MODE');
    }
    for (const [name, value] of [
      ['maxTurns', answers.maxTurns],
      ['maxToolCalls', answers.maxToolCalls],
      ['maxTotalTokens', answers.maxTotalTokens],
      ['timeoutSeconds', answers.timeoutSeconds],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) add(`${path}.answers.${name}`, 'BAD_LIMIT');
    }
    answers.toolIds.forEach((toolId, at) => {
      const toolPath = `${path}.answers.toolIds[${at}]`;
      if (FORBIDDEN_TOOL.test(toolId)) add(toolPath, 'FORBIDDEN_TOOL_REFUSED');
      if (BULK_TOOL.test(toolId)) add(toolPath, 'BULK_TOOL_REFUSED');
      if (!covered(['agent_tool', 'external_effect'], toolId, ref)) {
        add(toolPath, 'MISSING_CAPABILITY');
      }
      if (effects.has(toolId) && answers.autonomy !== 'act_with_approval') {
        add(toolPath, 'TOOL_NEEDS_APPROVAL_MODE');
      }
    });
    answers.dataClasses.forEach((dataClass, at) => {
      const classPath = `${path}.answers.dataClasses[${at}]`;
      if ((dataClass as string) === 'restricted') add(classPath, 'RESTRICTED_NOT_OFFERED');
      if (!covered(['data_class'], dataClass, ref)) add(classPath, 'MISSING_CAPABILITY');
    });
  });
}

function checkProcesses(
  manifest: PackManifest,
  covered: (kinds: readonly PackCapabilityKind[], subject: string, ref: string) => boolean,
  add: (path: string, code: string) => void,
) {
  const toolIds = new Set(
    manifest.capabilities
      .filter((capability) => ['agent_tool', 'external_effect'].includes(capability.kind))
      .map((capability) => capability.subject),
  );
  manifest.processes.forEach((process, index) => {
    const path = `processes[${index}]`;
    const ref = packItemRef('process_draft', process.key);
    if (!ITEM_KEY.test(process.key)) add(`${path}.key`, 'BAD_KEY');
    if (!process.name.trim()) add(`${path}.name`, 'REQUIRED');
    if (!covered(['data_class'], process.classification, ref)) {
      add(`${path}.classification`, 'MISSING_CAPABILITY');
    }
    const agentTasks = new Set<string>();
    for (const node of process.graph.nodes) {
      if (node.kind === 'agent_task') {
        agentTasks.add(node.id);
        // An agent is the tenant's own, and only a person can point a workflow at one.
        if (node.agentDefinitionId !== undefined) {
          add(`${path}.graph.${node.id}`, 'AGENT_REFERENCE_NOT_ALLOWED');
        }
      }
      if (node.kind === 'external_action' && node.toolId) {
        if (FORBIDDEN_TOOL.test(node.toolId)) add(`${path}.graph.${node.id}`, 'FORBIDDEN_TOOL_REFUSED');
        if (BULK_TOOL.test(node.toolId)) add(`${path}.graph.${node.id}`, 'BULK_TOOL_REFUSED');
        if (!covered(['external_effect'], node.toolId, ref)) {
          add(`${path}.graph.${node.id}`, 'MISSING_CAPABILITY');
        }
      }
    }
    // The hash is not used here, only the verdict. The agent a task runs is a person's choice after
    // installing, so those two codes on such a node mean "not chosen yet" and nothing else.
    const compiled = compileProcessGraph(
      process.graph,
      {
        classification: process.classification,
        agentDefinitionIds: new Set<string>(),
        toolIds,
      },
      () => '',
    );
    for (const issue of compiled.issues) {
      const waitingForAPerson =
        (issue.code === 'MISSING_SETTING' || issue.code === 'UNKNOWN_AGENT') &&
        issue.nodeId !== null &&
        agentTasks.has(issue.nodeId);
      if (!waitingForAPerson) add(`${path}.graph.${issue.nodeId ?? ''}`, `GRAPH_${issue.code}`);
    }
  });
}

/** Pure. Refuses a manifest that reaches for anything Studio would refuse. Implemented by the packs slice. */
export function validatePackManifest(manifest: PackManifest): readonly PackIssue[] {
  const issues: PackIssue[] = [];
  const add = (path: string, code: string) => issues.push({ path, code });

  if (manifest.schemaVersion !== 1) add('schemaVersion', 'BAD_SCHEMA_VERSION');
  if (!PACK_KEY.test(manifest.key)) add('key', 'BAD_KEY');
  if (!parseVersion(manifest.version)) add('version', 'BAD_VERSION');
  if (manifest.publisher !== 'ensemus') add('publisher', 'BAD_PUBLISHER');
  if (!manifest.name.trim()) add('name', 'REQUIRED');
  if (!manifest.description.trim()) add('description', 'REQUIRED');

  const refs = new Set<string>([
    ...manifest.objectTypes.map((type) => packItemRef('object_type', type.slug)),
    ...manifest.agentDrafts.map((draft) => packItemRef('agent_draft', draft.key)),
    ...manifest.processes.map((process) => packItemRef('process_draft', process.key)),
  ]);
  for (const key of duplicates(manifest.capabilities.map((capability) => capability.key))) {
    add(`capabilities.${key}`, 'DUPLICATE_KEY');
  }
  for (const key of duplicates(manifest.objectTypes.map((type) => type.slug))) {
    add(`objectTypes.${key}`, 'DUPLICATE_KEY');
  }
  for (const key of duplicates(manifest.agentDrafts.map((draft) => draft.key))) {
    add(`agentDrafts.${key}`, 'DUPLICATE_KEY');
  }
  for (const key of duplicates(manifest.processes.map((process) => process.key))) {
    add(`processes.${key}`, 'DUPLICATE_KEY');
  }
  for (const key of duplicates(manifest.scenarios.map((scenario) => scenario.key))) {
    add(`scenarios.${key}`, 'DUPLICATE_KEY');
  }

  manifest.capabilities.forEach((capability, index) => {
    const path = `capabilities[${index}]`;
    if (!CAPABILITY_KEY.test(capability.key)) add(`${path}.key`, 'BAD_KEY');
    if (!CAPABILITY_KINDS.includes(capability.kind)) add(`${path}.kind`, 'UNKNOWN_KIND');
    if (!capability.subject.trim()) add(`${path}.subject`, 'REQUIRED');
    if (capability.risk !== 'low' && capability.risk !== 'elevated') add(`${path}.risk`, 'BAD_RISK');
    // A request that keeps nothing out when declined would be a control that does nothing.
    if (capability.requiredBy.length === 0) add(`${path}.requiredBy`, 'REQUIRED');
    for (const ref of capability.requiredBy) {
      if (!refs.has(ref)) add(`${path}.requiredBy`, 'UNKNOWN_ITEM');
    }
    if (capability.kind === 'external_effect' && capability.risk !== 'elevated') {
      add(`${path}.risk`, 'EFFECT_MUST_BE_ELEVATED');
    }
    if (capability.kind === 'data_class') {
      if (capability.subject === 'restricted') add(`${path}.subject`, 'RESTRICTED_NOT_OFFERED');
      if (capability.subject === 'confidential' && capability.risk !== 'elevated') {
        add(`${path}.risk`, 'CONFIDENTIAL_MUST_BE_ELEVATED');
      }
    }
    if (capability.kind === 'agent_tool' || capability.kind === 'external_effect') {
      if (FORBIDDEN_TOOL.test(capability.subject)) add(`${path}.subject`, 'FORBIDDEN_TOOL_REFUSED');
      if (BULK_TOOL.test(capability.subject)) add(`${path}.subject`, 'BULK_TOOL_REFUSED');
    }
    // Extension review has to display data access and side effects, so a pack that cannot say is refused.
    if (!manifest.strings[capability.reasonCode]?.trim()) add(`${path}.reasonCode`, 'NO_WORDS');
    if (!manifest.strings[dataAccessStringKey(capability.key)]?.trim()) {
      add(`${path}.dataAccess`, 'NO_WORDS');
    }
    if (!manifest.strings[sideEffectsStringKey(capability.key)]?.trim()) {
      add(`${path}.sideEffects`, 'NO_WORDS');
    }
  });

  const covered = (kinds: readonly PackCapabilityKind[], subject: string, ref: string) =>
    manifest.capabilities.some(
      (capability) =>
        kinds.includes(capability.kind) &&
        capability.subject === subject &&
        capability.requiredBy.includes(ref),
    );

  const earlierTypes = new Set<string>();
  manifest.objectTypes.forEach((type, index) => {
    const path = `objectTypes[${index}]`;
    if (!CLASSIFICATIONS.includes(type.classification)) {
      add(`${path}.classification`, 'BAD_CLASSIFICATION');
    }
    if (!type.displayName.trim()) add(`${path}.displayName`, 'REQUIRED');
    if (!covered(['object_type'], type.slug, packItemRef('object_type', type.slug))) {
      add(`${path}.slug`, 'MISSING_CAPABILITY');
    }
    for (const issue of validateObjectSchema(type)) {
      add(`${path}.${issue.path}`, `OBJECT_${issue.code}`);
    }
    // A relation may point at itself or at an earlier type, so types can be made in manifest order and a
    // type left out always takes what points at it along.
    earlierTypes.add(type.slug);
    type.relations.forEach((relation, at) => {
      if (!earlierTypes.has(relation.toTypeSlug)) {
        add(`${path}.relations[${at}].toTypeSlug`, 'UNKNOWN_RELATION_TARGET');
      }
    });
  });

  checkAgentDrafts(manifest, covered, add);
  checkProcesses(manifest, covered, add);

  manifest.scenarios.forEach((scenario, index) => {
    if (!ITEM_KEY.test(scenario.key.replace(/\./g, '_'))) add(`scenarios[${index}].key`, 'BAD_KEY');
    if (scenario.turns.length === 0) add(`scenarios[${index}].turns`, 'REQUIRED');
  });

  checkClaims(manifest, add);
  return issues;
}

const typeShape = (type: PackManifest['objectTypes'][number]) => ({
  fields: type.fields,
  relations: type.relations,
});

const RANK: Readonly<Record<string, number>> = {
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
};

/** Pure. A downgrade or an unsafe change is refused, and a rollback path always exists. */
export function planPackUpgrade(from: PackManifest, to: PackManifest): UpgradePlan {
  const steps: UpgradeStep[] = [];
  let refused = from.key !== to.key;
  const order = comparePackVersions(from.version, to.version);
  // Moving sideways or backwards is what a rollback is for, and it does not write a new installation.
  if (order === null || order >= 0) refused = true;

  for (const type of from.objectTypes) {
    const next = to.objectTypes.find((candidate) => candidate.slug === type.slug);
    if (!next) {
      steps.push({ kind: 'remove_item', itemKind: 'object_type', key: type.slug, refused: true });
      refused = true;
    } else if (same(typeShape(type), typeShape(next)) && type.classification === next.classification) {
      steps.push({ kind: 'keep_item', itemKind: 'object_type', key: type.slug });
    } else {
      steps.push({ kind: 'migrate_type', key: type.slug });
      const lowered = (RANK[next.classification] ?? 0) < (RANK[type.classification] ?? 0);
      const relationGone = type.relations.some(
        (relation) =>
          !next.relations.some(
            (candidate) => candidate.key === relation.key && same(candidate, relation),
          ),
      );
      const plan = planTypeMigration(type.fields, next.fields);
      if (lowered || relationGone || !plan.safe || plan.steps.some((step) => 'refused' in step)) {
        refused = true;
      }
    }
  }
  for (const type of to.objectTypes) {
    if (!from.objectTypes.some((candidate) => candidate.slug === type.slug)) {
      steps.push({ kind: 'add_item', itemKind: 'object_type', key: type.slug });
    }
  }

  const compareItems = <T extends { key: string; name: string }>(
    itemKind: PackItemKind,
    before: readonly T[],
    after: readonly T[],
  ) => {
    for (const item of before) {
      const next = after.find((candidate) => candidate.key === item.key);
      if (!next) {
        steps.push({ kind: 'remove_item', itemKind, key: item.key, refused: true });
        refused = true;
      } else if (same(item, next)) {
        steps.push({ kind: 'keep_item', itemKind, key: item.key });
      } else {
        steps.push({ kind: 'new_draft_version', key: item.key });
      }
    }
    for (const item of after) {
      if (!before.some((candidate) => candidate.key === item.key)) {
        steps.push({ kind: 'add_item', itemKind, key: item.key });
      }
    }
  };
  compareItems('agent_draft', from.agentDrafts, to.agentDrafts);
  compareItems('process_draft', from.processes, to.processes);

  // Asking for the same key with a wider reach is a new request, so it comes back as one.
  let needsReview = false;
  for (const capability of to.capabilities) {
    const before = from.capabilities.find((candidate) => candidate.key === capability.key);
    if (!before || !sameRequest(before, capability)) {
      steps.push({ kind: 'new_capability', key: capability.key });
      needsReview = true;
    }
  }
  return { fromVersion: from.version, toVersion: to.version, steps, needsReview, refused };
}

const sameRequest = (a: PackCapability, b: PackCapability) =>
  a.kind === b.kind && a.subject === b.subject && a.risk === b.risk;

/** Each item, with the first decision that keeps it out, or null when every request it needs was accepted. */
function refusedBy(
  manifest: PackManifest,
  decisions: Readonly<Record<string, 'accepted' | 'declined'>>,
) {
  const out = new Map<string, 'declined' | 'undecided'>();
  for (const capability of manifest.capabilities) {
    const decision = Object.hasOwn(decisions, capability.key) ? decisions[capability.key] : undefined;
    if (decision === 'accepted') continue;
    for (const ref of capability.requiredBy) {
      // "Declined" is the stronger thing to tell someone, so it wins over "not decided yet".
      if (decision === 'declined' || !out.has(ref)) {
        out.set(ref, decision === 'declined' ? 'declined' : 'undecided');
      }
    }
  }
  // A type pointing at a type that is left out cannot be made as declared, and neither can what points at it.
  // Relations only ever point backwards, so one pass in manifest order is enough.
  const typesOut = new Set<string>();
  for (const type of manifest.objectTypes) {
    const ref = packItemRef('object_type', type.slug);
    if (out.has(ref)) {
      typesOut.add(type.slug);
    } else if (type.relations.some((relation) => typesOut.has(relation.toTypeSlug))) {
      typesOut.add(type.slug);
      out.set(ref, 'declined');
    }
  }
  return out;
}

/** Which items an installation may make, given what was accepted and declined. */
export function itemsAllowedBy(
  manifest: PackManifest,
  decisions: Readonly<Record<string, 'accepted' | 'declined'>>,
): {
  objectTypes: readonly string[];
  agentDrafts: readonly string[];
  processes: readonly string[];
} {
  const out = refusedBy(manifest, decisions);
  return {
    objectTypes: manifest.objectTypes
      .map((type) => type.slug)
      .filter((slug) => !out.has(packItemRef('object_type', slug))),
    agentDrafts: manifest.agentDrafts
      .map((draft) => draft.key)
      .filter((key) => !out.has(packItemRef('agent_draft', key))),
    processes: manifest.processes
      .map((process) => process.key)
      .filter((key) => !out.has(packItemRef('process_draft', key))),
  };
}

export type PackLeftOutReason =
  | 'declined'
  | 'undecided'
  /** M4's catalog answered, and this tool is not in it. */
  | 'tool_unavailable'
  /** M4's catalog could not be read at all, so nothing that names a tool is made. */
  | 'catalog_unavailable'
  | 'tool_needs_approval_mode'
  | 'tool_without_approval'
  /** The catalog says this tool is riskier than the request said, so the person was not told the truth. */
  | 'capability_understated';

export type PackItemPlan = {
  objectTypes: readonly string[];
  agentDrafts: readonly string[];
  processes: readonly string[];
  leftOut: readonly { ref: string; reason: PackLeftOutReason; subject: string | null }[];
};

function toolVerdict(
  manifest: PackManifest,
  toolId: string,
  ref: string,
  autonomy: string | null,
  tools: readonly ToolFacts[] | null,
): PackLeftOutReason | null {
  if (tools === null) return 'catalog_unavailable';
  const tool = tools.find((candidate) => candidate.id === toolId);
  if (!tool) return 'tool_unavailable';
  if (tool.class === 'external_write') {
    if (!tool.requiresApproval) return 'tool_without_approval';
    if (autonomy !== null && autonomy !== 'act_with_approval') return 'tool_needs_approval_mode';
  }
  if (tool.class === 'external_write' || tool.class === 'delegation') {
    const asked = manifest.capabilities.find(
      (capability) => capability.subject === toolId && capability.requiredBy.includes(ref),
    );
    if (asked?.risk !== 'elevated') return 'capability_understated';
  }
  return null;
}

/**
 * What activating would make, and why anything is left out. `tools` is M4's catalog, or null when it could not
 * be read. A tool nobody can offer leaves its item out, so a draft never names a tool that is not there.
 */
export function planPackItems(
  manifest: PackManifest,
  decisions: Readonly<Record<string, 'accepted' | 'declined'>>,
  tools: readonly ToolFacts[] | null,
): PackItemPlan {
  const out = refusedBy(manifest, decisions);
  const leftOut: { ref: string; reason: PackLeftOutReason; subject: string | null }[] = [];
  const keep = (ref: string, needs: readonly string[], autonomy: string | null) => {
    const decided = out.get(ref);
    if (decided) {
      leftOut.push({ ref, reason: decided, subject: null });
      return false;
    }
    for (const toolId of needs) {
      const reason = toolVerdict(manifest, toolId, ref, autonomy, tools);
      if (reason) {
        leftOut.push({ ref, reason, subject: toolId });
        return false;
      }
    }
    return true;
  };
  return {
    objectTypes: manifest.objectTypes
      .filter((type) => keep(packItemRef('object_type', type.slug), [], null))
      .map((type) => type.slug),
    agentDrafts: manifest.agentDrafts
      .filter((draft) =>
        keep(packItemRef('agent_draft', draft.key), draft.answers.toolIds, draft.answers.autonomy),
      )
      .map((draft) => draft.key),
    processes: manifest.processes
      .filter((process) =>
        keep(
          packItemRef('process_draft', process.key),
          process.graph.nodes.flatMap((node) =>
            node.kind === 'external_action' && node.toolId ? [node.toolId] : [],
          ),
          null,
        ),
      )
      .map((process) => process.key),
    leftOut,
  };
}

export type PackItemRow = { kind: string; key: string; id: string };

export type PackRollbackPlan = {
  /** Drafts only the newer version made, and nobody published. */
  archive: readonly PackItemRow[];
  /** Types the newer version added. They stay, with their records, because rollback never loses data. */
  keptTypes: readonly PackItemRow[];
  /** Something already published went through its own review, so a person decides what happens to it. */
  published: readonly PackItemRow[];
};

/** Pure. What going back from `newer` to `older` does to each thing the newer one made. */
export function planPackRollback(
  newer: readonly PackItemRow[],
  older: readonly PackItemRow[],
  draftStatus: Readonly<Record<string, string>>,
): PackRollbackPlan {
  const olderIds = new Set(older.map((item) => item.id));
  const archive: PackItemRow[] = [];
  const keptTypes: PackItemRow[] = [];
  const published: PackItemRow[] = [];
  for (const item of newer) {
    if (item.kind === 'process_spec') {
      published.push(item);
    } else if (olderIds.has(item.id)) {
      continue;
    } else if (item.kind === 'object_type') {
      keptTypes.push(item);
    } else if (draftStatus[item.id] === 'published') {
      published.push(item);
    } else if (draftStatus[item.id] !== 'archived') {
      archive.push(item);
    }
  }
  return { archive, keptTypes, published };
}

export type TypeShape = {
  fields: readonly ObjectField[];
  relations: readonly ObjectRelationDefinition[];
};

/**
 * The shape a type should move to when a pack changes it from `from` to `to`, on top of whatever it is now. A
 * person may have added fields since installing, and those stay: a pack only ever adds its own changes. The
 * result goes through the same migration rules as anyone's, so a plan with a refused step refuses the upgrade.
 */
export function mergePackTypeShape(
  current: TypeShape,
  from: TypeShape,
  to: TypeShape,
): { shape: TypeShape; plan: TypeMigrationPlan; changed: boolean } {
  const fields = current.fields.map((field) => {
    const before = from.fields.find((candidate) => candidate.key === field.key);
    const after = to.fields.find((candidate) => candidate.key === field.key);
    return before && after && same(before, field) ? after : field;
  });
  for (const field of to.fields) {
    if (!fields.some((candidate) => candidate.key === field.key)) fields.push(field);
  }
  const relations = [...current.relations];
  for (const relation of to.relations) {
    if (!relations.some((candidate) => candidate.key === relation.key)) relations.push(relation);
  }
  const shape = { fields, relations };
  return { shape, plan: planTypeMigration(current.fields, fields), changed: !same(current, shape) };
}
