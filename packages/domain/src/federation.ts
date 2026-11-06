// Cross-organization collaboration (ADR-035 D1 to D4). Pure rules, so a unit test can reach them. The state
// machines and the purpose table are repeated in reviewed SQL, migration 0703, because both tenants reach a
// grant through one role. tests/unit/federation-rules.test.ts holds the copies the same.
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from './approval';

export const FEDERATION_GRANT_STATUSES = ['proposed', 'accepted', 'active', 'ended'] as const;
export type FederationGrantStatus = (typeof FEDERATION_GRANT_STATUSES)[number];

/**
 * Proposed by an owner of the sharing side, accepted by an owner of the receiving side, and confirmed by an
 * owner of the sharing side once it can see who accepted. Ended cannot be undone: sharing again takes a new
 * grant and both consents, so nothing someone revoked can come back by itself.
 */
export const FEDERATION_GRANT_TRANSITIONS: Readonly<
  Record<FederationGrantStatus, readonly FederationGrantStatus[]>
> = {
  proposed: ['accepted', 'ended'],
  accepted: ['active', 'ended'],
  active: ['ended'],
  ended: [],
};

export const canTransitionGrant = (from: FederationGrantStatus, to: FederationGrantStatus) =>
  FEDERATION_GRANT_TRANSITIONS[from].includes(to);

export const FEDERATION_END_REASONS = [
  'cancelled',
  'declined',
  'revoked',
  'expired',
  'disabled',
] as const;
export type FederationEndReason = (typeof FEDERATION_END_REASONS)[number];

export const FEDERATION_PURPOSES = ['delegated_work', 'document_review'] as const;
export type FederationPurpose = (typeof FEDERATION_PURPOSES)[number];

export const FEDERATION_ITEM_KINDS = ['work_summary', 'artifact', 'status_update'] as const;
export type FederationItemKind = (typeof FEDERATION_ITEM_KINDS)[number];

/** `forward` is from the sharing organization to the one that receives. `return` is back. */
export type FederationDirection = 'forward' | 'return';

/** The limited objects (multitenancy doc, section 7). A setting cannot widen this: a migration can. */
export const FEDERATION_PURPOSE_KINDS: Readonly<
  Record<FederationPurpose, Readonly<Record<FederationDirection, readonly FederationItemKind[]>>>
> = {
  delegated_work: { forward: ['work_summary', 'artifact'], return: ['status_update', 'artifact'] },
  document_review: { forward: ['artifact'], return: ['status_update'] },
};

/** Restricted never crosses. The tables' checks leave it out, so this holds if a service forgets. */
export const FEDERATION_CLASSIFICATIONS = ['public', 'internal', 'confidential'] as const;
export type FederationClassification = (typeof FEDERATION_CLASSIFICATIONS)[number];

export const FEDERATION_ITEM_STATES = ['queued', 'delivered', 'refused', 'withdrawn'] as const;
export type FederationItemState = (typeof FEDERATION_ITEM_STATES)[number];

export const FEDERATION_ITEM_TRANSITIONS: Readonly<
  Record<FederationItemState, readonly FederationItemState[]>
> = {
  queued: ['delivered', 'refused', 'withdrawn'],
  delivered: ['withdrawn'],
  refused: [],
  withdrawn: [],
};

export const FEDERATION_DISPOSITIONS = ['pending', 'accepted', 'rejected'] as const;
export type FederationDisposition = (typeof FEDERATION_DISPOSITIONS)[number];

export const FEDERATION_CROSSING_OUTCOMES = ['delivered', 'refused', 'purged'] as const;
export type FederationCrossingOutcome = (typeof FEDERATION_CROSSING_OUTCOMES)[number];

/** Why the bridge would not carry something. Stored and shown, so it is a code and never a message. */
export const FEDERATION_REFUSE_CODES = [
  'FILE_MISSING',
  'FILE_HASH_MISMATCH',
  'FILE_TOO_LARGE',
] as const;
export type FederationRefuseCode = (typeof FEDERATION_REFUSE_CODES)[number];

/**
 * Hard ceilings, which an operator can only lower. A file is held to the same 25 MB as any artifact. An
 * invitation is short-lived because it is a bearer token, and a grant always ends by itself.
 */
export const FEDERATION_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const FEDERATION_MAX_BODY_BYTES = 65_536;
export const FEDERATION_TOKEN_BYTES = 32;
export const FEDERATION_MAX_INVITATION_DAYS = 14;
export const FEDERATION_MAX_GRANT_DAYS = 365;

export function directionOf(
  grant: { sharingOrganizationId: string; receivingOrganizationId: string | null },
  senderOrganizationId: string,
): FederationDirection | null {
  if (senderOrganizationId === grant.sharingOrganizationId) return 'forward';
  if (senderOrganizationId === grant.receivingOrganizationId) return 'return';
  return null;
}

export function kindAllowed(
  purpose: FederationPurpose,
  direction: FederationDirection,
  kind: FederationItemKind,
): boolean {
  return FEDERATION_PURPOSE_KINDS[purpose][direction].includes(kind);
}

const RANK: Readonly<Record<string, number>> = { public: 1, internal: 2, confidential: 3 };

/** Anything not on the list, restricted included, is too sensitive for every grant. */
export function classificationAllowed(
  max: FederationClassification,
  classification: string,
): boolean {
  const rank = Object.hasOwn(RANK, classification) ? RANK[classification] : undefined;
  return rank !== undefined && rank <= (RANK[max] as number);
}

export type GrantFacts = { status: FederationGrantStatus; expiresAt: Date };

/** The same test as `federation.grant_is_open`, without the deployment's own switch. */
export const isGrantOpen = (grant: GrantFacts, now: Date) =>
  grant.status === 'active' && grant.expiresAt.getTime() > now.getTime();

/**
 * Exactly what both owners agree to. Built by the server from checked input and frozen on the grant. It is
 * the technical scope and nothing else: who is bound by what, in law, belongs in a contract between the two
 * organizations, and no legal wording goes here (ADR-035, owner decisions).
 */
export type GrantTerms = {
  terms_version: 1;
  purpose: FederationPurpose;
  max_classification: FederationClassification;
  /** What may go each way, spelled out so that a later migration cannot change an old agreement. */
  forward_kinds: readonly FederationItemKind[];
  return_kinds: readonly FederationItemKind[];
  /** The sharing organization's ID, so a hash can never be replayed for another organization's offer. */
  sharing_organization_id: string;
  sharing_display_name: string;
  expires_at: string;
  /** Whatever the proposer wrote about why. It is shown to the other side, and is not checked. */
  note: string | null;
};

export function buildGrantTerms(input: {
  purpose: FederationPurpose;
  maxClassification: FederationClassification;
  sharingOrganizationId: string;
  sharingDisplayName: string;
  expiresAt: Date;
  note: string | null;
}): GrantTerms {
  const kinds = FEDERATION_PURPOSE_KINDS[input.purpose];
  return {
    terms_version: 1,
    purpose: input.purpose,
    max_classification: input.maxClassification,
    forward_kinds: kinds.forward,
    return_kinds: kinds.return,
    sharing_organization_id: input.sharingOrganizationId,
    sharing_display_name: input.sharingDisplayName,
    expires_at: input.expiresAt.toISOString(),
    note: input.note,
  };
}

/** What each owner's consent names, using the one way this product hashes what someone agreed to. */
export const grantTermsHash = (terms: GrantTerms) =>
  createHash('sha256').update(canonicalJson(terms)).digest('hex');

/** A new invitation token. Base64url, with enough randomness that it cannot be guessed. */
export const newFederationToken = () => randomBytes(FEDERATION_TOKEN_BYTES).toString('base64url');

export const hashFederationToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/**
 * What each person compares by another route, to be sure the other side is who they think. A display name
 * cannot do this: two organizations can have the same one, and nobody verifies them. Sixteen hex digits, to
 * read aloud or paste, from the ID and nothing a request can choose.
 */
export const organizationFingerprint = (organizationId: string) =>
  createHash('sha256')
    .update(`ensemus-org:${organizationId.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);

/** The same strings the tables' checks insist on, so no row can point a worker at other bytes. */
export const outboundObjectKey = (organizationId: string, itemId: string) =>
  `federation/outbound/${organizationId.toLowerCase()}/${itemId.toLowerCase()}`;
export const inboundObjectKey = (organizationId: string, itemId: string) =>
  `federation/inbound/${organizationId.toLowerCase()}/${itemId.toLowerCase()}`;

/** What `content_sha256` covers on both copies, so the receiver can check nothing changed on the way. */
export const itemContentHash = (item: {
  kind: FederationItemKind;
  classification: string;
  title: string;
  body: unknown;
  fileSha256: string | null;
}) =>
  createHash('sha256')
    .update(
      canonicalJson({
        kind: item.kind,
        classification: item.classification,
        title: item.title,
        body: item.body,
        file_sha256: item.fileSha256,
      }),
    )
    .digest('hex');
