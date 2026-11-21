// Owned by the grants slice (EXP-07). See docs/06-delivery/m11c-slices.md and ADR-035 D1. Every function binds
// the caller's own tenant and no other. Beginning or agreeing takes federation.manage, ending takes
// federation.end, reading takes federation.view, and the triggers in migration 0703 hold each of these again.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type {
  FederationClassification,
  FederationEndReason,
  FederationGrantStatus,
  FederationPurpose,
  GrantTerms,
} from '@ensemus/domain/federation';
import type { CrossOrgEntitlement } from './federation-ports';

export type FederationSettingsView = {
  /** Whether this deployment offers it at all. When false, nothing else here can do anything. */
  available: boolean;
  enabled: boolean;
  /** 0 until someone has changed it, because a tenant starts with no row. */
  version: number;
  changedAt: Date | null;
};

/** The other side's name is what it consented to show, and the fingerprint is what to check it with. */
export type FederationGrantView = {
  id: string;
  /** Which side this tenant is on. */
  role: 'sharing' | 'receiving';
  status: FederationGrantStatus;
  purpose: FederationPurpose;
  maxClassification: FederationClassification;
  terms: GrantTerms;
  termsHash: string;
  expiresAt: Date;
  invitationExpiresAt: Date;
  counterpartyName: string | null;
  counterpartyFingerprint: string | null;
  /** Each of these says who on this side consented, by name. Nothing about the other side's people. */
  proposedAt: Date;
  acceptedAt: Date | null;
  confirmedAt: Date | null;
  endedAt: Date | null;
  endReason: FederationEndReason | null;
  /** True when this side ended it. */
  endedByUs: boolean;
  version: number;
};

/** What a holder of an invitation sees before agreeing. Nothing else about the sharing tenant. */
export type FederationInvitationPreview = {
  termsHash: string;
  terms: GrantTerms;
  sharingDisplayName: string;
  sharingFingerprint: string;
  invitationExpiresAt: Date;
};

export function getFederationSettings(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<FederationSettingsView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Turns this tenant's own switch on or off. Only an owner. Turning it on also asks `entitlement`. Turning it
 * off ends every open grant first, in the same transaction, each with reason `disabled` and its own event.
 */
export function setFederationEnabled(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { enabled: boolean; expectedVersion: number },
  _entitlement: CrossOrgEntitlement,
): Promise<FederationSettingsView> {
  throw new Error('NOT_IMPLEMENTED');
}

export type ProposeGrantInput = {
  purpose: FederationPurpose;
  maxClassification: FederationClassification;
  expiresInDays: number;
  invitationExpiresInDays: number;
  note: string | null;
};

/**
 * An owner's first consent. The name on the terms is read from the organization's own row. Returns the token
 * once, and only its hash is stored, so this is the one time anyone can see it. The caller gives it to the
 * other company by a route of their own: this product sends nothing and can look up nobody.
 */
export function proposeGrant(
  _database: AppDatabase,
  _context: TenantContext,
  _input: ProposeGrantInput,
): Promise<{ grant: FederationGrantView; token: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Shows the proposal to an owner of this tenant, using withGrantInvitationTx. Answers
 * FEDERATION_INVITATION_INVALID the same way for a wrong token, an expired one, a used one, and this tenant's
 * own proposal, so a guess learns nothing.
 */
export function previewGrantInvitation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { token: string },
): Promise<FederationInvitationPreview> {
  throw new Error('NOT_IMPLEMENTED');
}

/** The second consent. Names the terms hash the person read. Writes this organization's real name. */
export function acceptGrantInvitation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { token: string; termsHash: string },
): Promise<FederationGrantView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The sharing owner has now seen who accepted, and says that is who they meant. Only after this does
 * anything cross, which is what stops a forwarded token from sending data to the wrong company.
 */
export function confirmGrant(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { grantId: string; termsHash: string; expectedVersion: number },
): Promise<FederationGrantView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Either side, at any time, and cannot be undone. Reads stop when this commits, because the read policy on
 * inbound items asks whether the grant is open. Emits federation.grant_ended, and a worker then purges.
 */
export function endGrant(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    grantId: string;
    reason: 'cancelled' | 'declined' | 'revoked';
    expectedVersion: number;
  },
): Promise<FederationGrantView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The same for every open grant in this tenant, in the caller's transaction, with reason `disabled`. Names
 * the person if the context has one, and nobody if a worker is winding the tenant down. Returns how many.
 */
export function endAllGrantsInTx(_tx: Tx, _context: TenantContext): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}

/** The shape of M8's `OffboardingPorts.windDowns`, for the final merge to put in that list. */
export const federationWindDown = async (tx: Tx, context: TenantContext): Promise<void> => {
  await endAllGrantsInTx(tx, context);
};

export function listGrants(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly FederationGrantView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getGrant(
  _database: AppDatabase,
  _context: TenantContext,
  _grantId: string,
): Promise<FederationGrantView> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Tenant upkeep: ends what has passed its date, with reason `expired`, naming nobody. Reads had already
 * stopped at the date. This is what starts the purge. Run with a service context, under `tenantUpkeep`.
 */
export function expireDueGrants(_database: AppDatabase, _context: TenantContext): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
