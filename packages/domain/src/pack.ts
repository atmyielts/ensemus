// Pack format (AGENT-14, docs/01-product/04-capability-catalog.md). A pack is data: it proposes things and
// grants nothing. Installing makes drafts and types, and each draft still goes through Studio's simulation
// and review before anything can act (ADR-031 D10). Owned by the packs slice.
import type { AgentDraftAnswers } from './agent-draft';
import type { ObjectField, ObjectRelationDefinition } from './custom-object';
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

/** Pure. Refuses a manifest that reaches for anything Studio would refuse. Implemented by the packs slice. */
export function validatePackManifest(_manifest: PackManifest): readonly PackIssue[] {
  throw new Error('NOT_IMPLEMENTED');
}

/** Pure. A downgrade or an unsafe change is refused, and a rollback path always exists. */
export function planPackUpgrade(_from: PackManifest, _to: PackManifest): UpgradePlan {
  throw new Error('NOT_IMPLEMENTED');
}

/** Which items an installation may make, given what was accepted and declined. */
export function itemsAllowedBy(
  _manifest: PackManifest,
  _decisions: Readonly<Record<string, 'accepted' | 'declined'>>,
): {
  objectTypes: readonly string[];
  agentDrafts: readonly string[];
  processes: readonly string[];
} {
  throw new Error('NOT_IMPLEMENTED');
}
