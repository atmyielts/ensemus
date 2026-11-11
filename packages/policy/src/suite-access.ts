// Whether a tool may use the connection its arguments name (ADR-038 D5, D6). Pure, so every refusal is
// tested without a database, and the gateway, the connector worker's recheck and M3's intent path all ask
// this same function. Unknown denies, and the first reason found is the one reported.
import type { AiClassification, AiReasonCode } from '@ensemus/domain/ai';
import type {
  ConnectionRule,
  ToolBinding,
  ToolClass,
  ToolConnectorType,
  ToolManifest,
} from '@ensemus/domain/ai-tools';

export type SourceAccess = 'read' | 'write' | 'owner';

export type ConnectionFacts = {
  state: string;
  connectorType: string;
  /** Null for the organization's connection, set for one member's own. */
  ownerMembershipId: string | null;
  grantedScopes: readonly string[];
};

/** The one resource a tool names, as the last completed sync recorded it. Null when it never synced. */
export type ResourceFacts = {
  /** Present, not deleted, and its source ACL mapped. Anything less grants nobody anything. */
  synced: boolean;
  /** What the source's ACL grants the initiator here, directly or through a team. */
  access: readonly SourceAccess[];
};

export type ConnectionUseInput = {
  rule: ConnectionRule;
  toolClass: ToolClass;
  initiatorMembershipId: string;
  /** The stronger of the run's class and its work's. */
  dataClass: AiClassification;
  /** Null when no such connection is visible in this tenant. */
  connection: ConnectionFacts | null;
  /** Only read for an organization's connection and a rule that names its resource. */
  resource: ResourceFacts | null;
};

export type ConnectionUseDecision =
  | {
      ok: true;
      ownerKind: 'organization' | 'member';
      binding: ToolBinding;
      /**
       * True when the tool returns many resources from the organization's content (a search), so every
       * result must be checked against the initiator's source ACL before anything is kept.
       */
      checkEachResult: boolean;
    }
  | {
      ok: false;
      code: AiReasonCode;
      /** Says more than the reason code can, for the audit row only. */
      auditAs: string;
    };

const refuse = (code: AiReasonCode, auditAs: string = code): ConnectionUseDecision => ({
  ok: false,
  code,
  auditAs,
});

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const grants = (access: readonly SourceAccess[], needed: 'read' | 'write') =>
  access.includes('owner') ||
  access.includes('write') ||
  (needed === 'read' && access.includes('read'));

export function decideConnectionUse(input: ConnectionUseInput): ConnectionUseDecision {
  const { rule, connection } = input;
  if (!connection) return refuse('RESOURCE_NOT_PERMITTED', 'CONNECTION_NOT_FOUND');
  if (connection.state !== 'active')
    return refuse('RESOURCE_NOT_PERMITTED', 'CONNECTION_NOT_ACTIVE');

  // Another member's own account is never reachable, whatever else is true, so this comes first.
  const owner = connection.ownerMembershipId;
  if (owner !== null && !sameId(owner, input.initiatorMembershipId)) {
    return refuse('CONNECTION_NOT_YOURS');
  }

  const binding = rule.bindings[connection.connectorType as ToolConnectorType];
  if (!(rule.connectorTypes as readonly string[]).includes(connection.connectorType) || !binding) {
    return refuse('CONNECTION_TYPE_MISMATCH');
  }

  const ownerKind = owner === null ? 'organization' : 'member';
  if (
    (rule.owner === 'member' && ownerKind !== 'member') ||
    (rule.owner === 'organization' && ownerKind !== 'organization')
  ) {
    return refuse('CONNECTION_NOT_YOURS', `CONNECTION_OWNER_${ownerKind.toUpperCase()}`);
  }

  if (!binding.scopes.every((scope) => connection.grantedScopes.includes(scope))) {
    return refuse('SCOPE_NOT_GRANTED');
  }

  // Restricted data does not leave (the egress matrix's outside-provider rule). A draft in a person's own
  // mailbox still leaves Ensemus, so it is held to the same rule as a send.
  const writes = input.toolClass === 'external_write' || input.toolClass === 'draft_only';
  if (writes && input.dataClass === 'restricted') return refuse('CLASS_DENIED');

  // A member's own connection is their own account. The organization's reaches everyone's content, so
  // there the initiator gets only what the source itself grants them, as the last sync recorded it.
  let checkEachResult = false;
  if (ownerKind === 'organization' && rule.resourceAccess !== null) {
    if (rule.resourceArg === null) {
      checkEachResult = true;
    } else {
      const resource = input.resource;
      if (!resource?.synced) return refuse('RESOURCE_NOT_PERMITTED', 'RESOURCE_NOT_SYNCED');
      if (!grants(resource.access, rule.resourceAccess)) {
        return refuse('RESOURCE_NOT_PERMITTED', 'SOURCE_ACL_DENIED');
      }
    }
  }
  return { ok: true, ownerKind, binding, checkEachResult };
}

/**
 * Whether a change needs a person. Every external write does, whatever a spec or a caller says, so sending
 * outside the organization always asks. A draft reaches nobody, and is the one change that does not.
 */
export function changeNeedsApproval(manifest: Pick<ToolManifest, 'class' | 'requiresApproval'>) {
  return manifest.class === 'external_write' || manifest.requiresApproval;
}

/** The value an argument names, for the one resource a rule checks. Null when there is none. */
export function resourceIdOf(rule: ConnectionRule, args: unknown): string | null {
  if (rule.resourceArg === null || typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[rule.resourceArg];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
