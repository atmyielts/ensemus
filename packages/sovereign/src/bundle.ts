// Owned by the bundle slice (COMM-04, SOV-03, OPS-03, OPS-11). See docs/06-delivery/m6-slices.md and
// ADR-030 D4. Verifying a bundle takes the bundle's folder and a trust root the operator already holds, and
// nothing else: no network, no registry, no vendor.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { compareReleaseVersions } from '@ensemus/domain/license';
import type { BundleManifest } from './documents';
import { MAX_BUNDLE_ENVELOPE_BYTES } from './envelope';
import { loadTrustRootFile, TrustRootError, type TrustRoot } from './trust-root';
import { verifyDocument, type DocumentRefusal } from './verify';

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
      /** Why a manifest was refused, so an operator can tell a wrong key from a damaged file. */
      reason?: DocumentRefusal;
    };

/** Bundle paths always use a forward slash, whatever the machine does. */
const joined = (parent: string, name: string) => (parent === '' ? name : `${parent}/${name}`);

const errorCodeOf = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** Every folder a listed file sits under. Any other folder was not signed, so it has no reason to be here. */
function foldersOf(listed: Iterable<string>): Set<string> {
  const folders = new Set<string>();
  for (const file of listed) {
    let at = file.lastIndexOf('/');
    while (at > 0) {
      const folder = file.slice(0, at);
      if (folders.has(folder)) break;
      folders.add(folder);
      at = folder.lastIndexOf('/');
    }
  }
  return folders;
}

type WalkRefusal = { code: 'LINK_REFUSED' | 'FILE_NOT_LISTED'; path: string };

/**
 * Finds what is really on disk, with lstat, so a link is seen as a link and never followed. Stops at the first
 * thing that should not be there, which also means a folder holding a million planted files costs one check.
 */
async function walkBundle(
  folder: string,
  listed: ReadonlyMap<string, unknown>,
): Promise<{ sizes: Map<string, number> } | WalkRefusal> {
  const allowedFolders = foldersOf(listed.keys());
  const sizes = new Map<string, number>();
  const pending = [''];
  for (let relative = pending.pop(); relative !== undefined; relative = pending.pop()) {
    const names = (await readdir(path.join(folder, relative))).sort();
    for (const name of names) {
      const entry = joined(relative, name);
      if (entry === BUNDLE_MANIFEST_FILE) continue;
      const stats = await lstat(path.join(folder, entry));
      if (stats.isDirectory()) {
        if (!allowedFolders.has(entry)) return { code: 'FILE_NOT_LISTED', path: entry };
        pending.push(entry);
      } else if (!stats.isFile()) {
        // A link, a socket, a device. Nothing a release ships, and each one can point somewhere else.
        return { code: 'LINK_REFUSED', path: entry };
      } else if (!listed.has(entry)) {
        return { code: 'FILE_NOT_LISTED', path: entry };
      } else {
        sizes.set(entry, stats.size);
      }
    }
  }
  return { sizes };
}

/**
 * Hashes one file through a stream, since an image archive can be far bigger than memory. O_NOFOLLOW closes
 * the gap between the walk and this open where the platform has it. Windows does not, where the constant is
 * undefined and the bitwise OR ignores it, and there the check on the open handle is what remains.
 */
async function checkListedFile(
  file: string,
  expected: { sha256: string; bytes: number },
): Promise<'ok' | 'FILE_CHANGED' | 'FILE_MISSING' | 'LINK_REFUSED'> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === 'ENOENT') return 'FILE_MISSING';
    if (code === 'ELOOP') return 'LINK_REFUSED';
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return 'LINK_REFUSED';
    if (stats.size !== expected.bytes) return 'FILE_CHANGED';
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex') === expected.sha256 ? 'ok' : 'FILE_CHANGED';
  } finally {
    await handle.close();
  }
}

/**
 * Checks the signature first, then every file against the manifest, and refuses anything in the folder the
 * manifest does not list, and any symbolic link, so nothing unsigned can sit beside what was signed
 * (QA-022, DEP-TS-02, SEC-012). Reads through streams, because an image archive is large. An unreadable file
 * throws rather than returning a verdict, which a caller treats as not verified.
 */
export async function verifyBundleDirectory(
  folder: string,
  root: TrustRoot,
): Promise<BundleVerdict> {
  const bundle = path.resolve(folder);

  // 1. The signature, before anything in the folder is believed. lstat first, because a manifest that is a
  // link would otherwise pull in a file from anywhere, and a huge one would be read into memory.
  const manifestPath = path.join(bundle, BUNDLE_MANIFEST_FILE);
  let manifestStats;
  try {
    const folderStats = await lstat(bundle);
    if (folderStats.isSymbolicLink()) return { ok: false, code: 'LINK_REFUSED', path: '.' };
    manifestStats = await lstat(manifestPath);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, code: 'MANIFEST_MISSING' };
    throw error;
  }
  if (!manifestStats.isFile()) {
    return { ok: false, code: 'LINK_REFUSED', path: BUNDLE_MANIFEST_FILE };
  }
  if (manifestStats.size > MAX_BUNDLE_ENVELOPE_BYTES) {
    return { ok: false, code: 'MANIFEST_REFUSED', reason: 'TOO_LARGE' };
  }
  const verdict = verifyDocument('bundle', await readFile(manifestPath, 'utf8'), root);
  if (!verdict.ok) return { ok: false, code: 'MANIFEST_REFUSED', reason: verdict.code };
  const manifest = verdict.document;

  // A signed manifest that contradicts itself is still refused: which entry counts would be a guess.
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  if (listed.size !== manifest.files.length || listed.has(BUNDLE_MANIFEST_FILE)) {
    return { ok: false, code: 'MANIFEST_REFUSED', reason: 'CONTENT_INVALID' };
  }

  // 2. What is really there. Nothing below opens a path the walk did not find, so a name in a manifest can
  // never reach a device or anything else outside this folder.
  const walked = await walkBundle(bundle, listed);
  if ('code' in walked) return { ok: false, code: walked.code, path: walked.path };

  // 3. Each listed file, size first because that costs nothing.
  for (const file of manifest.files) {
    const size = walked.sizes.get(file.path);
    if (size === undefined) return { ok: false, code: 'FILE_MISSING', path: file.path };
    if (size !== file.bytes) return { ok: false, code: 'FILE_CHANGED', path: file.path };
    const result = await checkListedFile(path.join(bundle, file.path), file);
    if (result !== 'ok') return { ok: false, code: result, path: file.path };
  }

  // 4. An image loads from a file the signature covers, and from nothing else.
  for (const image of manifest.images) {
    if (listed.get(image.file)?.role !== 'image') {
      return { ok: false, code: 'IMAGE_NOT_LISTED', path: image.file };
    }
  }

  return { ok: true, manifest, keyIds: verdict.keyIds, testKey: verdict.testKey };
}

/** The real path of something that may not exist yet: the nearest part that does, plus the rest. */
async function realPathOfWhatExists(target: string): Promise<string> {
  let existing = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...missing);
    } catch (error) {
      const parent = path.dirname(existing);
      if (errorCodeOf(error) !== 'ENOENT' || parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Whether a path is inside a folder once links are resolved. A trust root found inside the bundle would be the
 * bundle vouching for itself (ADR-030 D4), and a state folder inside one would make it refuse its next check.
 */
export async function isInsideFolder(candidate: string, folder: string): Promise<boolean> {
  const relative = path.relative(
    await realPathOfWhatExists(folder),
    await realPathOfWhatExists(candidate),
  );
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Takes a trust root only from where the operator says, and refuses one inside the folder being checked. Every
 * tool that verifies a bundle comes through here, and reads no environment and no default location.
 */
export async function loadOperatorTrustRoot(
  trustRootFile: string,
  folder: string,
): Promise<
  | { ok: true; root: TrustRoot }
  | { ok: false; code: 'TRUST_ROOT_INSIDE_BUNDLE' | 'TRUST_ROOT_UNREADABLE' }
> {
  if (await isInsideFolder(trustRootFile, folder)) {
    return { ok: false, code: 'TRUST_ROOT_INSIDE_BUNDLE' };
  }
  try {
    return { ok: true, root: loadTrustRootFile(trustRootFile) };
  } catch (error) {
    if (error instanceof TrustRootError) return { ok: false, code: 'TRUST_ROOT_UNREADABLE' };
    throw error;
  }
}

/**
 * What a `rollback_constraints` code means. A manifest may carry a code this version does not know, because a
 * later release can add one, so a tool shows an unknown code rather than refusing it. The operator's guide
 * explains each: docs/05-operations/sovereign/upgrade-and-rollback.md, and a test holds the two together.
 */
export const KNOWN_ROLLBACK_CONSTRAINTS = {
  MIGRATIONS_NOT_REVERSIBLE:
    'This release changes the database in a way no rollback undoes. Going back means restoring the backup taken before upgrading.',
  RESTORE_LOSES_LATER_WORK:
    'Restoring that backup loses everything written after it was taken.',
  WORKFLOW_HISTORY_NOT_COMPATIBLE:
    'Workflows started on this release may not replay on the older one. Let them finish, or stop them, before going back.',
  PLAN_RUNS_MUST_DRAIN:
    'Every plan run has to finish or be stopped first. Check that no work is running or awaiting approval under a plan.',
  EXTERNAL_EFFECTS_NOT_UNDONE:
    'What this release sent or did in other systems stays done. A restore does not reach them.',
} as const;

export type InstallPlanStep =
  | { kind: 'verify_bundle' }
  | { kind: 'confirm_outside_rights' }
  | { kind: 'require_backup' }
  | { kind: 'load_image'; name: string; file: string; digest: string }
  | { kind: 'check_image_digest'; name: string; digest: string }
  | { kind: 'stop_services' }
  /** Only on a rollback. No migration undoes itself, so going back means this backup, restored by a person. */
  | { kind: 'restore_backup' }
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
 *
 * Images are loaded and checked before anything stops, so a bundle that fails there leaves the running version
 * running. Nothing here looks at the running version's right to run: rights only ever decide a new install.
 */
export function planInstall(input: {
  /** The bundle being installed. */
  manifest: BundleManifest;
  /** From the verified manifest of what is running now. */
  installed: { version: string; rollback_to: readonly string[] } | null;
  rollbackRequested: boolean;
  /** From `evaluateUpdateRight`, or null where no license is installed, which is no reason to stop. */
  onInstall: 'proceed' | 'warn' | 'refuse' | null;
}): InstallPlan {
  const { manifest, installed, rollbackRequested, onInstall } = input;
  const version = manifest.release.version;

  let direction: 'install' | 'upgrade' | 'rollback' = 'install';
  if (installed) {
    const order = compareReleaseVersions(version, installed.version);
    if (order === 0) return { ok: false, code: 'SAME_VERSION' };
    if (order > 0) {
      if (!manifest.compatibility.upgrade_from.includes(installed.version)) {
        return { ok: false, code: 'UPGRADE_PATH_NOT_LISTED' };
      }
      direction = 'upgrade';
    } else {
      if (!rollbackRequested) return { ok: false, code: 'ROLLBACK_NOT_REQUESTED' };
      // Asked of the version going away, not the bundle: an old bundle cannot vouch for its own return.
      if (!installed.rollback_to.includes(version)) {
        return { ok: false, code: 'ROLLBACK_NOT_LISTED' };
      }
      direction = 'rollback';
    }
  }
  if (onInstall === 'refuse') return { ok: false, code: 'OUTSIDE_RIGHTS_REFUSED' };

  const steps: InstallPlanStep[] = [{ kind: 'verify_bundle' }];
  if (onInstall === 'warn') steps.push({ kind: 'confirm_outside_rights' });
  steps.push({ kind: 'require_backup' });
  for (const { name, file, digest } of manifest.images) {
    steps.push({ kind: 'load_image', name, file, digest });
    steps.push({ kind: 'check_image_digest', name, digest });
  }
  steps.push({ kind: 'stop_services' });
  if (direction === 'rollback') steps.push({ kind: 'restore_backup' });
  steps.push(
    { kind: 'run_migrations' },
    { kind: 'start_services' },
    { kind: 'smoke_test' },
    { kind: 'record_installation' },
  );
  return { ok: true, direction, steps };
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
