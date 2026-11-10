// Whether data may leave (SEC-01, ADR-028 FD-8 and G7). Pure: it reads nothing and asks nobody. Everything it
// does not recognise denies, and a tenant's bundle can only add refusals. Where the docs differ the stricter
// reading wins cell by cell, so purpose is checked at every class, and a stronger class never asks for less
// than a weaker one: that is why confidential to an outside provider needs a known region as well, though
// the CSV names only a contract and a purpose for that cell.
import {
  BILLING_OWNERS,
  CLASSIFICATIONS,
  EGRESS_DESTINATIONS,
  MODEL_PURPOSES,
  RETENTION_BASES,
  type AiClassification,
  type AiReasonCode,
  type EgressDestination,
} from '@ensemus/domain/ai';
import type { EgressDecision, EgressInput, EgressProfileFacts, TenantPolicyBundle } from './types';

/**
 * docs/specifications/data-egress-matrix.csv, as text, so nothing has to read a file at runtime. A test holds
 * this equal to that file: change the CSV and this together, or the unit suite fails.
 */
export const EGRESS_MATRIX_SOURCE = `classification,ensemus_cloud_managed_model,customer_byom_public_api,customer_private_inference,embedding_reranker,default_approval
public,approved_profile_only,approved_profile_only,approved_profile_only,approved_profile_only,policy_and_purpose
internal,approved_purpose_and_region,approved_purpose_and_region,approved_profile_only,approved_purpose_and_region,policy_and_purpose
confidential,explicit_approved_contract_and_purpose,explicit_approved_contract_and_purpose,approved_local_policy,explicit_approved_contract_and_purpose,security_steward_where_required
restricted,deny_default,deny_default,approved_private_policy_only,deny_external_default,special_authorization
`;

/** What a cell of the CSV can say. A word that is not here denies, as an unreadable policy. */
const CELL_RULES = [
  'approved_profile_only',
  'approved_purpose_and_region',
  'explicit_approved_contract_and_purpose',
  'approved_local_policy',
  'approved_private_policy_only',
  'deny_default',
  'deny_external_default',
] as const;
type CellRule = (typeof CELL_RULES)[number];

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

function parseMatrix(source: string): Map<string, Map<string, string>> {
  const [header, ...rows] = source
    .trim()
    .split('\n')
    .map((line) => line.split(','));
  const columns = header ?? [];
  const table = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const cells = new Map<string, string>();
    row.forEach((cell, index) => {
      const column = columns[index];
      if (column !== undefined) cells.set(column, cell);
    });
    table.set(row[0] ?? '', cells);
  }
  return table;
}

const MATRIX = parseMatrix(EGRESS_MATRIX_SOURCE);

/** The rule for one class and destination, or nothing for anything unknown. */
export function matrixCell(
  dataClass: AiClassification,
  destination: EgressDestination,
): CellRule | undefined {
  if (!isOneOf(CLASSIFICATIONS, dataClass) || !isOneOf(EGRESS_DESTINATIONS, destination)) {
    return undefined;
  }
  const cell = MATRIX.get(dataClass)?.get(destination);
  return isOneOf(CELL_RULES, cell) ? cell : undefined;
}

/** FNV-1a, so the version moves when the table does and this file stays free of imports. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const MATRIX_VERSION = `egress-${digest(EGRESS_MATRIX_SOURCE)}`;

const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The facts are read from a database row and a caller's mapping, so the types alone do not settle them. */
function factsAreKnown(profile: EgressProfileFacts): boolean {
  if (!isObject(profile)) return false;
  if (!hasText(profile.id) || !hasText(profile.destinationHost)) return false;
  if (!Number.isInteger(profile.version) || profile.version < 1) return false;
  if (typeof profile.active !== 'boolean') return false;
  if (!isOneOf(EGRESS_DESTINATIONS, profile.destination)) return false;
  if (!isOneOf(BILLING_OWNERS, profile.billingOwner)) return false;
  if (!isOneOf(RETENTION_BASES, profile.retentionBasis)) return false;
  if (!Array.isArray(profile.allowedClasses) || !Array.isArray(profile.allowedPurposes)) {
    return false;
  }
  if (profile.region !== null && typeof profile.region !== 'string') return false;
  if (profile.contractRef !== null && typeof profile.contractRef !== 'string') return false;
  // A managed model is Ensemus's bill and an outside key is the customer's. A row that says otherwise is
  // wrong about something, and which part cannot be told from here. Private inference may be either.
  if (profile.destination === 'ensemus_cloud_managed_model') {
    return profile.billingOwner === 'ensemus';
  }
  if (profile.destination === 'customer_byom_public_api') {
    return profile.billingOwner === 'customer';
  }
  return true;
}

function inputIsKnown(input: EgressInput): boolean {
  if (!isObject(input)) return false;
  if (!isOneOf(CLASSIFICATIONS, input.dataClass)) return false;
  if (!isOneOf(MODEL_PURPOSES, input.purpose)) return false;
  if (input.requiredRegion !== null && typeof input.requiredRegion !== 'string') return false;
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) return false;
  return factsAreKnown(input.profile);
}

/** A tightening we cannot read may be a tightening we skip, so a malformed bundle stops everything. */
function bundleIsReadable(bundle: TenantPolicyBundle | null): boolean {
  if (bundle === null) return true;
  if (!isObject(bundle) || typeof bundle.version !== 'string') return false;
  if (bundle.allowedRegions !== undefined && !Array.isArray(bundle.allowedRegions)) return false;
  if (bundle.denyClasses === undefined) return true;
  if (!isObject(bundle.denyClasses)) return false;
  return Object.values(bundle.denyClasses).every((list) => Array.isArray(list));
}

/** Denying a class denies every stronger one, so that a stronger class is never the easier one. */
function bundleDeniesClass(bundle: TenantPolicyBundle, input: EgressInput): boolean {
  const denied = bundle.denyClasses?.[input.profile.destination] ?? [];
  const rank = CLASSIFICATIONS.indexOf(input.dataClass);
  return denied.some((each) => {
    const deniedRank = CLASSIFICATIONS.indexOf(each);
    return deniedRank === -1 ? true : deniedRank <= rank;
  });
}

function regionRefusal(input: EgressInput): AiReasonCode | null {
  const { region } = input.profile;
  if (input.requiredRegion !== null && input.requiredRegion !== region) return 'WRONG_REGION';
  const allowed = input.bundle?.allowedRegions;
  if (allowed !== undefined && (region === null || !allowed.includes(region))) {
    return 'WRONG_REGION';
  }
  return null;
}

/** What this cell asks of the profile, beyond the class and purpose every cell asks for. */
function cellRefusal(rule: CellRule, profile: EgressProfileFacts): AiReasonCode | null {
  switch (rule) {
    case 'approved_profile_only':
      return null;
    case 'approved_purpose_and_region':
      return profile.region === null ? 'REGION_REQUIRED' : null;
    case 'explicit_approved_contract_and_purpose':
      if (!hasText(profile.contractRef) || profile.retentionBasis !== 'contract_recorded') {
        return 'CONTRACT_MISSING';
      }
      return profile.region === null ? 'REGION_REQUIRED' : null;
    case 'approved_local_policy':
      return profile.retentionBasis === 'unreviewed' ? 'CONTRACT_MISSING' : null;
    case 'approved_private_policy_only':
      // "Only specially authorized secure profile": a person listed restricted on a model the customer runs.
      return profile.retentionBasis === 'self_hosted' ? null : 'CLASS_DENIED';
    case 'deny_default':
    case 'deny_external_default':
      return 'CLASS_DENIED';
  }
}

/** The first reason this may not leave, or null. Refusals are checked in the order a person reads them. */
function refusal(input: EgressInput): AiReasonCode | null {
  if (!inputIsKnown(input)) return 'UNKNOWN_INPUT';
  if (!bundleIsReadable(input.bundle)) return 'POLICY_UNREADABLE';
  const { profile } = input;
  if (!profile.active) return 'PROFILE_NOT_ACTIVE';

  const rule = matrixCell(input.dataClass, profile.destination);
  if (rule === undefined) return 'POLICY_UNREADABLE';
  // A flat denial comes before anything on the profile, so listing the class there cannot look like a way in.
  if (rule === 'deny_default' || rule === 'deny_external_default') return 'CLASS_DENIED';
  if (input.bundle && bundleDeniesClass(input.bundle, input)) return 'CLASS_DENIED';

  if (!profile.allowedClasses.includes(input.dataClass)) return 'CLASS_NOT_ON_PROFILE';
  if (!profile.allowedPurposes.includes(input.purpose)) return 'PURPOSE_NOT_ON_PROFILE';

  return regionRefusal(input) ?? cellRefusal(rule, profile);
}

function policyVersionOf(bundle: unknown): string {
  if (isObject(bundle) && typeof bundle.version === 'string') {
    return `${MATRIX_VERSION}+bundle-${bundle.version}`;
  }
  return MATRIX_VERSION;
}

function deny(reasonCode: AiReasonCode, policyVersion: string): EgressDecision {
  return { decision: 'deny', reasonCode, policyVersion, expiresAt: null, obligations: [] };
}

export function decideEgress(input: EgressInput): EgressDecision {
  const bundle = isObject(input) ? input.bundle : null;
  try {
    const reasonCode = refusal(input);
    if (reasonCode !== null) return deny(reasonCode, policyVersionOf(bundle));
  } catch {
    // Something in the input could not even be read, and that is no reason to let anything through.
    return deny('POLICY_UNREADABLE', policyVersionOf(bundle));
  }
  return {
    decision: 'allow',
    reasonCode: 'ALLOWED',
    policyVersion: policyVersionOf(bundle),
    // A decision covers one turn, and the next turn decides again (FD-13), so it has nothing to expire.
    expiresAt: null,
    obligations: ['scan_before_send'],
  };
}
