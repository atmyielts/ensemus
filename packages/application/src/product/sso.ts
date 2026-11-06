// Owned by the sso slice (ID-04). See docs/06-delivery/m7-slices.md and ADR-031 D9.
import { withTenantTx, type AppDatabase, type TenantContext } from '@ensemus/database';
import { securityPolicies, sessionAssurances, ssoConnections } from '@ensemus/database/product';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../errors';
import type { SessionProof } from './privileged';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type SsoConnectionView = {
  id: string;
  providerId: string;
  displayName: string;
  domain: string;
  domainState: 'unverified' | 'verified';
  state: 'draft' | 'active' | 'disabled';
  autoJoin: boolean;
  version: number;
};

/**
 * Whether this session came in the way the tenant asks (ADR-031 D9). Runs on every request to a tenant, so it
 * is one indexed read when nothing is required, which is nearly always. An owner, and any tenant with no active
 * connection, stay out of this, so a broken or removed provider cannot lock a tenant out of itself.
 */
export async function assertTenantSignIn(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof,
): Promise<void> {
  if (context.actorType !== 'user' || context.role === 'owner') return;
  await withTenantTx(database, context, async (tx) => {
    const [policy] = await tx
      .select({ ssoEnforcement: securityPolicies.ssoEnforcement })
      .from(securityPolicies)
      .where(eq(securityPolicies.organizationId, context.organizationId));
    if (policy?.ssoEnforcement !== 'required') return;
    const active = await tx
      .select({ providerId: ssoConnections.providerId })
      .from(ssoConnections)
      .where(
        and(
          eq(ssoConnections.organizationId, context.organizationId),
          eq(ssoConnections.state, 'active'),
        ),
      );
    if (active.length === 0) return;
    const [assurance] = await tx
      .select({ providerId: sessionAssurances.ssoProviderId })
      .from(sessionAssurances)
      .where(
        and(
          eq(sessionAssurances.sessionId, proof.sessionId),
          eq(sessionAssurances.userId, context.userId),
          eq(sessionAssurances.kind, 'sso_saml'),
        ),
      );
    if (!assurance || !active.some((row) => row.providerId === assurance.providerId)) {
      throw new AppError('SSO_REQUIRED');
    }
  });
}

/** Needs `sso.manage`. */
export async function listSsoConnections(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly SsoConnectionView[]> {
  throw NOT_BUILT();
}

/**
 * Needs `sso.manage` and recent MFA. Writes the tenant's row as a draft and gives the provider's ID for the
 * caller to store the metadata under, through `@ensemus/auth`'s `sso.storeProvider`. The domain starts
 * unverified, and only the operator's command can change that.
 */
export async function createSsoConnection(
  _database: AppDatabase,
  _context: TenantContext,
  _proof: SessionProof | null,
  _input: { displayName: string; domain: string },
): Promise<SsoConnectionView> {
  throw NOT_BUILT();
}

/** Needs `sso.manage` and recent MFA. `active` is refused until the operator has verified the domain. */
export async function updateSsoConnection(
  _database: AppDatabase,
  _context: TenantContext,
  _proof: SessionProof | null,
  _input: {
    connectionId: string;
    expectedVersion: number;
    displayName?: string;
    state?: 'active' | 'disabled';
    autoJoin?: boolean;
  },
): Promise<SsoConnectionView> {
  throw NOT_BUILT();
}

/** Needs `sso.manage` and recent MFA. The token is returned once, and only its hash is kept. */
export async function issueScimToken(
  _database: AppDatabase,
  _context: TenantContext,
  _proof: SessionProof | null,
  _input: { connectionId: string },
): Promise<{ tokenId: string; token: string }> {
  throw NOT_BUILT();
}

export async function revokeScimToken(
  _database: AppDatabase,
  _context: TenantContext,
  _proof: SessionProof | null,
  _input: { tokenId: string },
): Promise<void> {
  throw NOT_BUILT();
}

export type SsoSignInResult =
  /** They are in this organization. */
  | { outcome: 'member'; organizationId: string }
  /** Verified, and with no place here. Nothing was created. */
  | { outcome: 'no_membership' }
  /** The email is outside the verified domain, or the connection is not active. */
  | { outcome: 'refused' };

/**
 * After Better Auth accepted an assertion. Through `withSsoProviderTx`: links the membership and, only when
 * the connection's `autoJoin` is on, adds a `member`. Never a higher role. A deprovisioned link stays out,
 * and a disabled membership is not revived by signing in again.
 */
export async function completeSsoSignIn(
  _database: AppDatabase,
  _input: { providerId: string; userId: string; email: string; externalSubject: string },
): Promise<SsoSignInResult> {
  throw NOT_BUILT();
}

/** A SCIM user, in the RFC 7643 fields a provider needs for deprovisioning. Nothing else. */
export type ScimUser = {
  id: string;
  userName: string;
  externalId: string;
  active: boolean;
};

/** Through `withScimTokenTx`. Only people linked to this connection. Null is a 401 at the route. */
export async function scimListUsers(
  _database: AppDatabase,
  _tokenHash: string,
  _input: { filterUserName?: string; startIndex: number; count: number },
): Promise<{ total: number; users: readonly ScimUser[] } | null> {
  throw NOT_BUILT();
}

/** Disables the membership, marks the link, audits, and emits MEMBER_DEPROVISIONED. Idempotent. */
export async function scimDeprovisionUser(
  _database: AppDatabase,
  _tokenHash: string,
  _input: { membershipId: string },
): Promise<'done' | 'not_found' | 'last_owner' | 'unauthorized'> {
  throw NOT_BUILT();
}

/** Reactivates only a link SCIM itself deprovisioned. A membership an admin disabled stays disabled. */
export async function scimReactivateUser(
  _database: AppDatabase,
  _tokenHash: string,
  _input: { membershipId: string },
): Promise<'done' | 'not_found' | 'refused' | 'unauthorized'> {
  throw NOT_BUILT();
}
