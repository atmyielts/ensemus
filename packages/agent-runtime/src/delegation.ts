// Owned by the delegation slice (AGENT-05). Pure rules for what a child may have (ADR-028 FD-16). A union
// instead of an intersection is an escalation, and recursion spends real money, so all of it is here where
// a test with no database reaches every branch. `@ensemus/application/ai-delegation` asks this file what to
// do, and migration 0101's trigger refuses a wider child even if this is wrong. The only import is a file
// that imports nothing, so this stays pure wherever it is loaded from.
import { strongestClassification, type AiClassification } from '@ensemus/domain/ai';

/** An intersection, never a union. Anything asked for and not held is reported as refused. */
export function intersectScopes(
  parent: readonly string[],
  asked: readonly string[],
): { granted: readonly string[]; refused: readonly string[] } {
  const held = new Set(parent);
  const wanted = [...new Set(asked)];
  return {
    granted: wanted.filter((scope) => held.has(scope)),
    refused: wanted.filter((scope) => !held.has(scope)),
  };
}

/** A limit from a bundle or a row. Anything that is not a plain count means no permission at all. */
const count = (value: number) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

/** The lower of the manifest's depth and the organization's policy. */
export function allowedDepth(manifestDepth: number, orgDepth: number): number {
  return Math.min(count(manifestDepth), count(orgDepth));
}

/**
 * How many children may be alive at once. The manifest has no field for this, so its limit is the one that
 * already bounds every delegation: a child takes a tool call, and a run cannot make more than its manifest
 * gives it. The organization's limit comes from its policy bundle.
 */
export function allowedFanOut(manifestToolCalls: number, orgFanOut: number): number {
  return Math.min(count(manifestToolCalls), count(orgFanOut));
}

export type OrgDelegationLimits = { maxDepth: number; maxFanOut: number };

/** What no active policy bundle means (ADR-028 question 10). There is no default number in code. */
export const NO_DELEGATION: OrgDelegationLimits = Object.freeze({ maxDepth: 0, maxFanOut: 0 });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const countField = (fields: Record<string, unknown>, name: string) => {
  const value = fields[name];
  return typeof value === 'number' ? count(value) : 0;
};

/**
 * The delegation limits in a bundle's document, under `organization_policy.agent_limits`, where
 * company-security-policy.yaml puts them. A person writes these, so a bundle this cannot read, or a limit it
 * does not set, is no delegation and never a guess. That file has no fan-out of its own, so an organization
 * that has not set one is held by the limit it does have on how many runs may be alive at once.
 */
export function readOrgDelegationLimits(document: unknown): OrgDelegationLimits {
  if (!isRecord(document) || !isRecord(document.organization_policy)) return NO_DELEGATION;
  const limits = document.organization_policy.agent_limits;
  if (!isRecord(limits)) return NO_DELEGATION;
  return {
    maxDepth: countField(limits, 'max_delegation_depth'),
    maxFanOut:
      limits.max_delegation_fan_out === undefined
        ? countField(limits, 'max_concurrent_runs_per_org')
        : countField(limits, 'max_delegation_fan_out'),
  };
}

/**
 * Takes what was asked from what is left, or nothing. It is never trimmed to fit: a child gets a budget
 * someone asked for or none, and a model that overreached is told so. A child with no money is refused too,
 * because it can do nothing but delegate, and that is how recursion would go on for free.
 */
export function carveChildBudget(
  parentRemainingMicros: number,
  askedMicros: number,
): { ok: true; micros: number } | { ok: false } {
  if (!Number.isSafeInteger(parentRemainingMicros) || !Number.isSafeInteger(askedMicros)) {
    return { ok: false };
  }
  if (askedMicros <= 0 || askedMicros > parentRemainingMicros) return { ok: false };
  return { ok: true, micros: askedMicros };
}

/**
 * What is left of a run's limit once it has paid for itself and its children have taken theirs. Never below
 * zero, because a settled call may overspend. A number it cannot trust leaves nothing.
 */
export function remainingForChildren(input: {
  maxCostMicros: number;
  costMicros: number;
  childHolds: readonly number[];
}): number {
  const amounts = [input.maxCostMicros, input.costMicros, ...input.childHolds];
  if (!amounts.every((amount) => Number.isSafeInteger(amount) && amount >= 0)) return 0;
  const taken = input.childHolds.reduce((sum, hold) => sum + hold, input.costMicros);
  return Math.max(0, input.maxCostMicros - taken);
}

/**
 * What a child that has not been settled still takes from its parent: everything it was given, because it
 * could still spend all of it, or what it has actually spent if a settled call took it past that. Budgets
 * over-count rather than under-count (ADR-028 FD-12).
 */
export function childHoldMicros(child: { maxCostMicros: number; costMicros: number }): number {
  return Math.max(child.maxCostMicros, child.costMicros);
}

export type DelegationLimits = {
  maxModelTurns: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxCostMicros: number;
  timeoutSeconds: number;
  maxDelegationDepth: number;
};

export type DelegationCode =
  'DELEGATION_WIDENED' | 'DELEGATION_DEPTH' | 'DELEGATION_FANOUT' | 'BUDGET_EXHAUSTED';

export type DelegationInput = {
  parent: {
    /** Levels above this run: 0 for a run a person started. */
    depth: number;
    /** What this run may use, from its stored scopes. */
    tools: readonly string[];
    classification: AiClassification;
    /** Its limits row. `maxDelegationDepth` is how many levels it may still go down. */
    limits: DelegationLimits;
    /** Its own spending, and what its settled children spent. */
    costMicros: number;
    /** A child inherits the parent's pinned profile, so there must be one. */
    boundToProfile: boolean;
  };
  workClassification: AiClassification;
  liveChildren: number;
  /** Every child not settled yet, live or waiting on live children of its own. */
  childHolds: readonly { maxCostMicros: number; costMicros: number }[];
  org: OrgDelegationLimits;
  /** What the model asked for, already parsed. */
  asked: { tools: readonly string[]; maxCostMicros: number };
  /** The child version's published manifest, which can only take away. */
  childManifest: { allow: readonly string[]; deny: readonly string[]; limits: DelegationLimits };
};

export type DelegationDecision =
  | {
      kind: 'allowed';
      tools: readonly string[];
      maxCostMicros: number;
      classification: AiClassification;
      limits: Omit<DelegationLimits, 'maxCostMicros'>;
    }
  | {
      kind: 'denied';
      code: DelegationCode;
      /** The code for the audit row. It may say more than the code the model's run is told. */
      reason: string;
    };

const denied = (code: DelegationCode, reason: string = code): DelegationDecision => ({
  kind: 'denied',
  code,
  reason,
});

/**
 * The whole decision, given what was read. Depth first, because then nothing else matters, then scopes, so a
 * request for more than the parent holds is on the record as exactly that whatever else is wrong with it.
 */
export function decideDelegation(input: DelegationInput): DelegationDecision {
  const { parent, childManifest, org, asked } = input;

  // The organization's limit counts from the top of the tree, and the run's own from where it stands.
  const orgLevelsLeft = org.maxDepth - parent.depth;
  if (allowedDepth(parent.limits.maxDelegationDepth, orgLevelsLeft) < 1) {
    return denied('DELEGATION_DEPTH');
  }

  const { granted, refused } = intersectScopes(parent.tools, asked.tools);
  if (refused.length > 0) return denied('DELEGATION_WIDENED');

  // With nothing to inherit, the child would route for itself and might reach a provider this run could not.
  if (!parent.boundToProfile) return denied('DELEGATION_WIDENED', 'PROFILE_NOT_BOUND');

  if (input.liveChildren >= allowedFanOut(parent.limits.maxToolCalls, org.maxFanOut)) {
    return denied('DELEGATION_FANOUT');
  }

  const carved = carveChildBudget(
    remainingForChildren({
      maxCostMicros: parent.limits.maxCostMicros,
      costMicros: parent.costMicros,
      childHolds: input.childHolds.map(childHoldMicros),
    }),
    asked.maxCostMicros,
  );
  if (!carved.ok) return denied('BUDGET_EXHAUSTED');
  const maxCostMicros = Math.min(carved.micros, childManifest.limits.maxCostMicros);
  if (maxCostMicros <= 0) return denied('BUDGET_EXHAUSTED');

  const allowedByManifest = new Set(childManifest.allow);
  const deniedByManifest = new Set(childManifest.deny);
  return {
    kind: 'allowed',
    tools: granted.filter((tool) => allowedByManifest.has(tool) && !deniedByManifest.has(tool)),
    maxCostMicros,
    classification: strongestClassification(parent.classification, input.workClassification),
    limits: {
      maxModelTurns: Math.min(parent.limits.maxModelTurns, childManifest.limits.maxModelTurns),
      maxToolCalls: Math.min(parent.limits.maxToolCalls, childManifest.limits.maxToolCalls),
      maxTotalTokens: Math.min(parent.limits.maxTotalTokens, childManifest.limits.maxTotalTokens),
      timeoutSeconds: Math.min(parent.limits.timeoutSeconds, childManifest.limits.timeoutSeconds),
      maxDelegationDepth: allowedDepth(
        Math.min(parent.limits.maxDelegationDepth - 1, childManifest.limits.maxDelegationDepth),
        orgLevelsLeft - 1,
      ),
    },
  };
}
