// What a department pack is, and the rules every one has to pass (EXP-01, ADR-033 D1). AGENT-14 in M7 owns
// installing a pack: this is the content those installs read, in the shape the capability catalog lists.
// Pure data and pure rules, so a pack is reviewable as a diff and can be checked with nothing running.

export const PACK_DEPARTMENTS = ['sales', 'marketing', 'hr', 'finance', 'learning'] as const;
export type PackDepartment = (typeof PACK_DEPARTMENTS)[number];

export type PackClassification = 'public' | 'internal' | 'confidential' | 'restricted';

/**
 * A capability the pack needs. `grantedOnInstall` is the literal false: an install makes a request that an
 * administrator reviews, one by one, and the type has no way to say otherwise (catalog, "Pack format").
 */
export type PackCapabilityRequest = {
  capability: string;
  /** Why, for the reviewer. A key into the localization strings. */
  reasonKey: string;
  grantedOnInstall: false;
};

export type PackDataAccessRequest = {
  classification: PackClassification;
  /** What it reads, such as `employment_records`. */
  dataset: string;
  reasonKey: string;
  grantedOnInstall: false;
  /** Restricted data is limited to named people, and an organization admin gets no way in by it. */
  isolation?: 'named_people_only';
};

export type PackFieldType = 'text' | 'number' | 'boolean' | 'date' | 'reference';

export type PackObjectSchema = {
  /** Lower case, and unique in the pack. Custom objects install under the pack's own namespace. */
  name: string;
  labelKey: string;
  classification: PackClassification;
  fields: readonly {
    name: string;
    labelKey: string;
    type: PackFieldType;
    required: boolean;
    /** Indexed on purpose or not at all (catalog, "Universality constraints"). */
    indexed: boolean;
  }[];
};

export type PackViewSchema = {
  name: string;
  labelKey: string;
  object: string;
  columns: readonly string[];
};

/**
 * One agent, in the shape docs/specifications/schemas/agent-definition.schema.json takes, so it can be
 * published through Agent Studio once installed. Nothing here is a grant: its tools have to be in the
 * pack's own requests, and each is still checked by the tool gateway when it runs.
 */
export type PackAgent = {
  api_version: 'ensemus.ai/v1';
  id: string;
  version: number;
  objective: string;
  model: {
    required_capabilities: readonly string[];
    quality_tier: 'economy' | 'balanced' | 'high';
    /** No automatic unapproved fallback, so `disabled` or approved profiles and nothing else. */
    fallback: 'approved_profiles_only' | 'disabled';
  };
  context: {
    allowed_scopes: readonly string[];
    /** A pack's agent can propose a memory and no more. A model guess never becomes a fact. */
    memory_write_policy: 'none' | 'propose_only';
    max_input_tokens?: number;
  };
  skills: readonly string[];
  tools: { allow: readonly string[]; deny: readonly string[] };
  execution: {
    max_model_turns: number;
    max_tool_calls: number;
    /** A limit, set by whoever installs it through configuration. It is not a price. */
    max_cost_usd: number;
    timeout_seconds: number;
    max_delegation_depth: number;
  };
  output: { schema_ref: string; verification: readonly string[] };
  evaluation: { suite_ref: string; min_pass_rate: number };
};

export type PackSkill = {
  id: string;
  version: string;
  titleKey: string;
  /** The procedure, as a localization key. Portable text, with no code in it. */
  instructionsKey: string;
};

export type PackWorkflowStep =
  | { kind: 'human_task'; id: string; titleKey: string }
  | { kind: 'agent_task'; id: string; agent: string; titleKey: string }
  /** A person approves exactly what the next side effect will do. */
  | { kind: 'approval'; id: string; titleKey: string; approverRole: string }
  /** Goes through the verified external action path, with its receipt (ADR-027). */
  | { kind: 'side_effect'; id: string; tool: string; titleKey: string };

export type PackWorkflowBlueprint = {
  name: string;
  titleKey: string;
  steps: readonly PackWorkflowStep[];
  /** No unbounded loops. A blueprint says how many times it can come round. */
  maxIterations: number;
};

export type PackEvaluationScenario = {
  id: string;
  /** `denied` proves a guardrail holds, and every pack needs at least one. */
  kind: 'success' | 'denied';
  target: { agent: string } | { workflow: string };
  /** The guardrail or outcome this scenario proves, as a localization key. */
  expectationKey: string;
};

/** How to get from the previous version to this one, and back. Version 1 installs from nothing. */
export type PackMigration = {
  fromVersion: number;
  up: readonly PackMigrationStep[];
  rollback: readonly PackMigrationStep[];
};

export type PackMigrationStep =
  | { kind: 'add_object'; object: string }
  | { kind: 'drop_object'; object: string; preserve: 'archive' }
  | { kind: 'add_field'; object: string; field: string }
  | { kind: 'drop_field'; object: string; field: string; preserve: 'archive' }
  | { kind: 'replace_agent'; agent: string; toVersion: number }
  | { kind: 'replace_workflow'; workflow: string }
  | { kind: 'request_review'; capability: string };

export type DepartmentPack = {
  /** Lower case, such as `marketing_operations`. Unique in the catalog. */
  id: string;
  version: number;
  department: PackDepartment;
  titleKey: string;
  summaryKey: string;
  /** The catalog's guardrail for this department, which evaluation scenarios must prove. */
  guardrailKey: string;
  objects: readonly PackObjectSchema[];
  views: readonly PackViewSchema[];
  agents: readonly PackAgent[];
  skills: readonly PackSkill[];
  workflows: readonly PackWorkflowBlueprint[];
  requests: {
    capabilities: readonly PackCapabilityRequest[];
    dataAccess: readonly PackDataAccessRequest[];
    /** Every tool an agent or a workflow step names. A tool not listed here cannot be used. */
    tools: readonly string[];
    /** Connector types it can use. It works with none of them connected, with those steps unavailable. */
    connectors: readonly string[];
  };
  /** `en` is required and complete. Other locales may fall back to it. */
  strings: Readonly<Record<string, Readonly<Record<string, string>>>>;
  evaluation: readonly PackEvaluationScenario[];
  /** Empty for version 1, and required for every later one. */
  migrations: readonly PackMigration[];
};

export type PackFinding = {
  /** A fixed code, so a test can name exactly which rule a pack broke. */
  rule: string;
  /** The offending key, tool or name. Never a translated string. */
  subject: string;
};

const NAME = /^[a-z][a-z0-9_]{1,63}$/;
const AGENT_ID = /^[a-z][a-z0-9-]{2,80}$/;

/** Tools that move money, in any spelling. No pack may ask for one, in any department, by default. */
const MONEY_MOVEMENT = /(^|[._-])(transfer|payment|payout|pay|wire|refund|disburse|remit)([._-]|$)/;
/** Tools that reach many people at once. Bulk outreach needs a sanctioned path that does not exist. */
const BULK_OUTREACH = /(^|[._-])(bulk|blast|mass|broadcast)([._-]|$)/;
/** Never in any allowlist, whatever else is true. */
const NEVER_ALLOWED = /(^|[._-])secrets?([._-]|$)/;
/** A pack cannot say it provides compliance (catalog, "Universality constraints"). */
const COMPLIANCE_CLAIM = /\b(compliant|compliance with|certified|guarantee[sd]?)\b/i;

/** Whether a name reads as an effect outside Ensemus rather than a read or a draft inside it. */
const READ_ONLY_VERB = /[._-](read|search|list|get|draft)([._-]|$)/;
const isEffect = (tool: string) => !READ_ONLY_VERB.test(tool);

function checkStrings(pack: DepartmentPack, keys: ReadonlySet<string>, add: Add) {
  const english = pack.strings.en;
  if (!english) {
    add('STRINGS_NO_ENGLISH', pack.id);
    return;
  }
  for (const key of keys) if (!english[key]) add('STRINGS_MISSING_KEY', key);
  for (const [locale, table] of Object.entries(pack.strings)) {
    for (const [key, value] of Object.entries(table)) {
      if (COMPLIANCE_CLAIM.test(value)) add('STRINGS_COMPLIANCE_CLAIM', `${locale}:${key}`);
      if (!english[key]) add('STRINGS_UNKNOWN_KEY', `${locale}:${key}`);
    }
  }
}

type Add = (rule: string, subject: string) => void;

function checkAgents(pack: DepartmentPack, add: Add) {
  const tools = new Set(pack.requests.tools);
  const seen = new Set<string>();
  for (const agent of pack.agents) {
    if (!AGENT_ID.test(agent.id)) add('AGENT_ID_FORMAT', agent.id);
    if (seen.has(agent.id)) add('AGENT_ID_REPEATED', agent.id);
    seen.add(agent.id);
    if ((agent.context.memory_write_policy as string) === 'verified_by_policy') {
      add('AGENT_MEMORY_NOT_PROPOSAL', agent.id);
    }
    if (agent.tools.deny.length === 0) add('AGENT_NO_DENY_LIST', agent.id);
    if (agent.execution.max_delegation_depth !== 0) add('AGENT_DELEGATES', agent.id);
    for (const tool of agent.tools.allow) {
      if (!tools.has(tool)) add('AGENT_TOOL_NOT_REQUESTED', tool);
      if (agent.tools.deny.includes(tool)) add('AGENT_TOOL_BOTH_ALLOWED_AND_DENIED', tool);
      // An agent proposes. The side effect is a workflow step behind a person's approval.
      if (isEffect(tool)) add('AGENT_TOOL_HAS_EFFECT', tool);
    }
  }
}

function checkWorkflows(pack: DepartmentPack, add: Add) {
  const tools = new Set(pack.requests.tools);
  const agents = new Set(pack.agents.map((agent) => agent.id));
  for (const workflow of pack.workflows) {
    if (!NAME.test(workflow.name)) add('WORKFLOW_NAME_FORMAT', workflow.name);
    if (!Number.isInteger(workflow.maxIterations) || workflow.maxIterations < 1) {
      add('WORKFLOW_UNBOUNDED', workflow.name);
    }
    let approved = false;
    for (const step of workflow.steps) {
      if (step.kind === 'agent_task' && !agents.has(step.agent)) {
        add('WORKFLOW_UNKNOWN_AGENT', step.agent);
      }
      if (step.kind === 'approval') approved = true;
      if (step.kind === 'side_effect') {
        if (!tools.has(step.tool)) add('WORKFLOW_TOOL_NOT_REQUESTED', step.tool);
        // Each effect is approved on its own, so an approval is used up by the effect after it.
        if (!approved) add('WORKFLOW_EFFECT_WITHOUT_APPROVAL', step.id);
        approved = false;
      }
    }
  }
}

function checkRequests(pack: DepartmentPack, add: Add) {
  for (const request of pack.requests.capabilities) {
    if ((request.grantedOnInstall as boolean) !== false) {
      add('REQUEST_GRANTS_ON_INSTALL', request.capability);
    }
  }
  for (const request of pack.requests.dataAccess) {
    if ((request.grantedOnInstall as boolean) !== false) {
      add('REQUEST_GRANTS_ON_INSTALL', request.dataset);
    }
    if (request.classification === 'restricted' && request.isolation !== 'named_people_only') {
      add('RESTRICTED_WITHOUT_ISOLATION', request.dataset);
    }
  }
  for (const tool of pack.requests.tools) {
    if (MONEY_MOVEMENT.test(tool)) add('TOOL_MOVES_MONEY', tool);
    if (BULK_OUTREACH.test(tool)) add('TOOL_BULK_OUTREACH', tool);
    if (NEVER_ALLOWED.test(tool)) add('TOOL_NEVER_ALLOWED', tool);
  }
}

function checkObjects(pack: DepartmentPack, add: Add) {
  const objects = new Map(pack.objects.map((object) => [object.name, object]));
  if (objects.size !== pack.objects.length) add('OBJECT_NAME_REPEATED', pack.id);
  for (const object of pack.objects) {
    if (!NAME.test(object.name)) add('OBJECT_NAME_FORMAT', object.name);
    if (object.fields.length === 0) add('OBJECT_NO_FIELDS', object.name);
    for (const field of object.fields) {
      if (!NAME.test(field.name)) add('FIELD_NAME_FORMAT', `${object.name}.${field.name}`);
    }
  }
  for (const view of pack.views) {
    const object = objects.get(view.object);
    if (!object) {
      add('VIEW_UNKNOWN_OBJECT', view.name);
      continue;
    }
    for (const column of view.columns) {
      if (!object.fields.some((field) => field.name === column)) {
        add('VIEW_UNKNOWN_COLUMN', `${view.name}.${column}`);
      }
    }
  }
}

function checkEvaluation(pack: DepartmentPack, add: Add) {
  if (!pack.evaluation.some((scenario) => scenario.kind === 'denied')) {
    add('EVALUATION_NO_DENIED_SCENARIO', pack.id);
  }
  const agents = new Set(pack.agents.map((agent) => agent.id));
  const workflows = new Set(pack.workflows.map((workflow) => workflow.name));
  for (const agent of agents) {
    const covered = pack.evaluation.some(
      (scenario) => 'agent' in scenario.target && scenario.target.agent === agent,
    );
    if (!covered) add('EVALUATION_AGENT_NOT_COVERED', agent);
  }
  for (const scenario of pack.evaluation) {
    const known =
      'agent' in scenario.target
        ? agents.has(scenario.target.agent)
        : workflows.has(scenario.target.workflow);
    if (!known) add('EVALUATION_UNKNOWN_TARGET', scenario.id);
  }
}

function checkMigrations(pack: DepartmentPack, add: Add) {
  if (pack.version === 1 && pack.migrations.length > 0) add('MIGRATION_ON_FIRST_VERSION', pack.id);
  for (let version = 2; version <= pack.version; version += 1) {
    const migration = pack.migrations.find((step) => step.fromVersion === version - 1);
    if (!migration) {
      add('MIGRATION_MISSING', `${version - 1}->${version}`);
    } else if (migration.up.length === 0 || migration.rollback.length === 0) {
      add('MIGRATION_NOT_REVERSIBLE', `${version - 1}->${version}`);
    }
  }
}

/** Every string key the pack says it has, so a missing translation is a finding and not a blank label. */
function keysUsedBy(pack: DepartmentPack): ReadonlySet<string> {
  const keys = new Set([pack.titleKey, pack.summaryKey, pack.guardrailKey]);
  for (const object of pack.objects) {
    keys.add(object.labelKey);
    for (const field of object.fields) keys.add(field.labelKey);
  }
  for (const view of pack.views) keys.add(view.labelKey);
  for (const skill of pack.skills) {
    keys.add(skill.titleKey);
    keys.add(skill.instructionsKey);
  }
  for (const workflow of pack.workflows) {
    keys.add(workflow.titleKey);
    for (const step of workflow.steps) keys.add(step.titleKey);
  }
  for (const request of pack.requests.capabilities) keys.add(request.reasonKey);
  for (const request of pack.requests.dataAccess) keys.add(request.reasonKey);
  for (const scenario of pack.evaluation) keys.add(scenario.expectationKey);
  return keys;
}

/**
 * The review rules, as far as they can be checked without a person: an empty list means the pack is fit to
 * be reviewed, not that it was. Anything a person has to decide stays in the requests, for them to decide.
 */
export function checkDepartmentPack(pack: DepartmentPack): readonly PackFinding[] {
  const findings: PackFinding[] = [];
  const add: Add = (rule, subject) => findings.push({ rule, subject });
  if (!NAME.test(pack.id)) add('PACK_ID_FORMAT', pack.id);
  if (!Number.isInteger(pack.version) || pack.version < 1) add('PACK_VERSION', pack.id);
  checkObjects(pack, add);
  checkAgents(pack, add);
  checkWorkflows(pack, add);
  checkRequests(pack, add);
  checkEvaluation(pack, add);
  checkMigrations(pack, add);
  checkStrings(pack, keysUsedBy(pack), add);
  return findings;
}

/**
 * The rollback rules for one upgrade. An object or field that goes has to be archived on the way up and
 * put back on the way down, and anything new it asks for has to go back to a person. Asking for more can
 * never come through an upgrade quietly.
 */
export function checkPackUpgrade(
  from: DepartmentPack,
  to: DepartmentPack,
): readonly PackFinding[] {
  const findings: PackFinding[] = [];
  const add: Add = (rule, subject) => findings.push({ rule, subject });
  if (to.id !== from.id) add('UPGRADE_OTHER_PACK', to.id);
  if (to.version !== from.version + 1) add('UPGRADE_NOT_NEXT_VERSION', `${to.version}`);
  const migration = to.migrations.find((step) => step.fromVersion === from.version);
  if (!migration) {
    add('MIGRATION_MISSING', `${from.version}->${to.version}`);
    return findings;
  }
  const hasStep = (steps: readonly PackMigrationStep[], match: (s: PackMigrationStep) => boolean) =>
    steps.some(match);

  for (const object of from.objects) {
    const next = to.objects.find((candidate) => candidate.name === object.name);
    if (!next) {
      if (
        !hasStep(migration.up, (s) => s.kind === 'drop_object' && s.object === object.name) ||
        !hasStep(migration.rollback, (s) => s.kind === 'add_object' && s.object === object.name)
      ) {
        add('UPGRADE_DROP_NOT_REVERSIBLE', object.name);
      }
      continue;
    }
    for (const field of object.fields) {
      if (next.fields.some((candidate) => candidate.name === field.name)) continue;
      if (
        !hasStep(
          migration.up,
          (s) => s.kind === 'drop_field' && s.object === object.name && s.field === field.name,
        ) ||
        !hasStep(
          migration.rollback,
          (s) => s.kind === 'add_field' && s.object === object.name && s.field === field.name,
        )
      ) {
        add('UPGRADE_DROP_NOT_REVERSIBLE', `${object.name}.${field.name}`);
      }
    }
  }

  const before = new Set(from.requests.capabilities.map((request) => request.capability));
  for (const { capability } of to.requests.capabilities) {
    if (before.has(capability)) continue;
    if (!hasStep(migration.up, (s) => s.kind === 'request_review' && s.capability === capability)) {
      add('UPGRADE_NEW_CAPABILITY_WITHOUT_REVIEW', capability);
    }
  }
  const oldTools = new Set(from.requests.tools);
  for (const tool of to.requests.tools) {
    if (oldTools.has(tool)) continue;
    if (!hasStep(migration.up, (s) => s.kind === 'request_review' && s.capability === tool)) {
      add('UPGRADE_NEW_TOOL_WITHOUT_REVIEW', tool);
    }
  }
  return findings;
}
