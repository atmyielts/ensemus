// Owned by the bundle slice (COMM-04, SOV-03, OPS-03, OPS-11). See docs/06-delivery/m6-slices.md and
// ADR-030 D4. Verifying a bundle takes the bundle's folder and a trust root the operator already holds, and
// nothing else: no network, no registry, no vendor.
import type { BundleManifest } from './documents';
import type { TrustRoot } from './trust-root';

export const BUNDLE_MANIFEST_FILE = 'bundle-manifest.dsse.json';

export const BUNDLE_REFUSALS = [
  'MANIFEST_MISSING',
  'MANIFEST_REFUSED',
  'FILE_MISSING',
  'FILE_CHANGED',
  'FILE_NOT_LISTED',
  'LINK_REFUSED',
  'IMAGE_NOT_LISTED',
] as const;
export type BundleRefusal = (typeof BUNDLE_REFUSALS)[number];

export type BundleVerdict =
  | {
      ok: true;
      manifest: BundleManifest;
      keyIds: readonly string[];
      testKey: boolean;
    }
  | {
      ok: false;
      code: BundleRefusal;
      /** A path from the manifest or the folder, which is ours to name and carries no customer data. */
      path?: string;
    };

/**
 * Checks the signature first, then every file against the manifest, and refuses anything in the folder the
 * manifest does not list, and any symbolic link, so nothing unsigned can sit beside what was signed
 * (QA-022, DEP-TS-02, SEC-012). Reads through streams, because an image archive is large.
 */
export async function verifyBundleDirectory(
  _folder: string,
  _root: TrustRoot,
): Promise<BundleVerdict> {
  throw new Error('NOT_IMPLEMENTED');
}

export type InstallPlanStep =
  | { kind: 'verify_bundle' }
  | { kind: 'confirm_outside_rights' }
  | { kind: 'require_backup' }
  | { kind: 'load_image'; name: string; file: string; digest: string }
  | { kind: 'check_image_digest'; name: string; digest: string }
  | { kind: 'stop_services' }
  | { kind: 'run_migrations' }
  | { kind: 'start_services' }
  | { kind: 'smoke_test' }
  | { kind: 'record_installation' };

export type InstallPlan =
  | { ok: true; direction: 'install' | 'upgrade' | 'rollback'; steps: readonly InstallPlanStep[] }
  | {
      ok: false;
      code:
        | 'UPGRADE_PATH_NOT_LISTED'
        | 'ROLLBACK_NOT_REQUESTED'
        | 'ROLLBACK_NOT_LISTED'
        | 'SAME_VERSION'
        | 'OUTSIDE_RIGHTS_REFUSED';
    };

/**
 * Works out what to do, as data, so every refusal is a unit test and the script only carries out the steps.
 * `installed` null is a first install. A move to an older version is a rollback: the operator has to ask
 * for one, and the version going away has to list the target in its own `rollback_to`. That is what stops an
 * old, unpatched bundle being replayed as an upgrade, however good its signature still is.
 */
export function planInstall(_input: {
  /** The bundle being installed. */
  manifest: BundleManifest;
  /** From the verified manifest of what is running now. */
  installed: { version: string; rollback_to: readonly string[] } | null;
  rollbackRequested: boolean;
  /** From `evaluateUpdateRight`, or null where no license is installed, which is no reason to stop. */
  onInstall: 'proceed' | 'warn' | 'refuse' | null;
}): InstallPlan {
  throw new Error('NOT_IMPLEMENTED');
}

/** One line of the local installation record the runbook asks for. Appended, and never rewritten. */
export type InstallationRecord = {
  recorded_at: string;
  direction: 'install' | 'upgrade' | 'rollback';
  bundle_id: string;
  version: string;
  images: readonly { name: string; digest: string }[];
  license_id: string | null;
  update_right: 'covered' | 'outside_rights_confirmed' | 'no_license';
  /** Who the operator says they are. Their words, on their own machine. */
  operator: string;
  backup_reference: string;
};
