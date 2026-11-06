// Owned by the packs slice (AGENT-14). See docs/06-delivery/m7-slices.md and ADR-031 D10.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { PackCapability, UpgradePlan } from '@ensemus/domain/pack';
import type { SessionProof } from './privileged';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type PackCatalogEntry = {
  key: string;
  version: string;
  name: string;
  description: string;
  installation: { id: string; version: string; status: string } | null;
  upgrade: UpgradePlan | null;
};

export type PackInstallationView = {
  id: string;
  packKey: string;
  packVersion: string;
  manifestSha256: string;
  status: 'reviewing' | 'active' | 'superseded' | 'rolled_back' | 'cancelled';
  capabilities: readonly (PackCapability & {
    decision: 'pending' | 'accepted' | 'declined';
    decidedByMembershipId: string | null;
  })[];
  items: readonly { kind: string; key: string; id: string }[];
  version: number;
};

/** Needs `pack.manage`. */
export async function listPackCatalog(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly PackCatalogEntry[]> {
  throw NOT_BUILT();
}

/** Needs `pack.manage`. Only writes a `reviewing` row and one pending review per capability. Grants nothing. */
export async function requestPackInstall(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { packKey: string; version: string },
): Promise<PackInstallationView> {
  throw NOT_BUILT();
}

export async function getPackInstallation(
  _database: AppDatabase,
  _context: TenantContext,
  _installationId: string,
): Promise<PackInstallationView> {
  throw NOT_BUILT();
}

/** Needs `pack.manage`. Each capability on its own, with no accept-all path. */
export async function decidePackCapability(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    installationId: string;
    capabilityKey: string;
    decision: 'accepted' | 'declined';
  },
): Promise<PackInstallationView> {
  throw NOT_BUILT();
}

/**
 * Needs `pack.manage` and recent MFA. In one transaction: makes the object types, agent drafts and process
 * drafts the decisions allow, and moves the installation to `active`. Nothing it makes can act: every draft
 * still needs a simulation and a review, and a type holds no records. The old installation is `superseded`.
 */
export async function activatePack(
  _database: AppDatabase,
  _context: TenantContext,
  _proof: SessionProof | null,
  _input: { installationId: string; expectedVersion: number },
): Promise<PackInstallationView> {
  throw NOT_BUILT();
}

/**
 * Needs `pack.manage` and recent MFA. Reactivates the superseded installation. Drafts the newer version made
 * are archived unless published, and types it added stay, with their records, because rollback never loses
 * data. An agent or process someone already published stays, and the page lists it for them to decide on.
 */
export async function rollbackPack(
  _database: AppDatabase,
  _context: TenantContext,
  _proof: SessionProof | null,
  _input: { installationId: string; expectedVersion: number },
): Promise<PackInstallationView> {
  throw NOT_BUILT();
}
