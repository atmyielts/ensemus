import 'server-only';
import { readFileSync } from 'node:fs';
import { loadSovereignConfig, type SovereignConfig } from '@ensemus/config/sovereign';
import {
  organizationImports,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import type { ReleaseFacts } from '@ensemus/domain/license';
import { can } from '@ensemus/domain/policy';
import { loadTrustRootFile, type TrustRoot } from '@ensemus/sovereign/trust-root';
import { verifyDocument } from '@ensemus/sovereign/verify';
import { createLogger, errorCode } from '@ensemus/telemetry';

// What this deployment knows about its own license setup (ADR-030 D2, D3). Everything here is a fact to
// show someone. None of it decides whether anything runs, so a missing file, a bad file or a bad setting
// gives an answer of null and a logged code, and never stops the process or a request.

/** What a page tells an administrator about the trust root. */
export type TrustRootState = 'loaded' | 'not_configured' | 'unreadable';

export type SovereignRuntime = {
  trustRoot: TrustRoot | null;
  trustRootState: TrustRootState;
  /** From this deployment's own signed bundle manifest. Null where that is absent or does not verify. */
  runningRelease: ReleaseFacts | null;
  /** The release an archive records as its source. */
  sourceRelease: string;
};

type RuntimeLog = { info: LogCall; warn: LogCall };
type LogCall = (event: string, fields: { errorCode: string }) => void;

const NO_SETTINGS: SovereignConfig = {
  trustRootFile: null,
  bundleManifestFile: null,
  release: 'unreleased',
  exportRetentionHours: 24,
};

function readSettings(env: NodeJS.ProcessEnv, log: RuntimeLog): SovereignConfig {
  try {
    return loadSovereignConfig(env);
  } catch {
    log.warn('license.settings_invalid', { errorCode: 'SOVEREIGN_CONFIG_INVALID' });
    return NO_SETTINGS;
  }
}

function readTrustRoot(
  file: string | null,
  log: RuntimeLog,
): Pick<SovereignRuntime, 'trustRoot' | 'trustRootState'> {
  if (!file) {
    log.info('license.trust_root_absent', { errorCode: 'TRUST_ROOT_NOT_CONFIGURED' });
    return { trustRoot: null, trustRootState: 'not_configured' };
  }
  try {
    return { trustRoot: loadTrustRootFile(file), trustRootState: 'loaded' };
  } catch {
    // The file is the operator's, so a code goes in the log, and nothing it held.
    log.warn('license.trust_root_unreadable', { errorCode: 'TRUST_ROOT_UNREADABLE' });
    return { trustRoot: null, trustRootState: 'unreadable' };
  }
}

function readRunningRelease(
  file: string | null,
  trustRoot: TrustRoot | null,
  log: RuntimeLog,
): ReleaseFacts | null {
  // With nothing to check a manifest against, what it says about itself is not known to be true.
  if (!file || !trustRoot) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    log.warn('license.bundle_manifest_unreadable', { errorCode: 'BUNDLE_MANIFEST_UNREADABLE' });
    return null;
  }
  const verdict = verifyDocument('bundle', text, trustRoot);
  if (!verdict.ok) {
    log.warn('license.bundle_manifest_refused', { errorCode: verdict.code });
    return null;
  }
  const { version, line, kind, security, published_on } = verdict.document.release;
  return { version, line, kind, security, published_on };
}

/** Works it all out once. Takes its inputs, so a test can hand it a broken setup and watch it answer. */
export function buildSovereignRuntime(
  env: NodeJS.ProcessEnv = process.env,
  log: RuntimeLog = createLogger('web-license'),
): SovereignRuntime {
  const settings = readSettings(env, log);
  const { trustRoot, trustRootState } = readTrustRoot(settings.trustRootFile, log);
  const runningRelease = readRunningRelease(settings.bundleManifestFile, trustRoot, log);
  return {
    trustRoot,
    trustRootState,
    runningRelease,
    sourceRelease: runningRelease?.version ?? settings.release,
  };
}

let runtime: SovereignRuntime | undefined;

/** Read once per process, so a trust root an operator adds later takes a restart. */
export function getSovereignRuntime(): SovereignRuntime {
  runtime ??= buildSovereignRuntime();
  return runtime;
}

/**
 * Which import this organization holds, for its data page. The import service reads one by its ID and has
 * no list, and a person coming back to the page has no ID to give it. So this finds the latest through
 * row-level security, gives back nothing but the ID, and leaves reading it to the service, which checks
 * permission again. An organization takes one archive, plus any attempts that failed, so there are few rows.
 */
export async function findOrganizationImportId(
  database: AppDatabase,
  context: TenantContext,
): Promise<string | null> {
  if (!can(context.role, 'organization.import')) return null;
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({ id: organizationImports.id, requestedAt: organizationImports.requestedAt })
      .from(organizationImports),
  );
  const latest = rows.reduce<(typeof rows)[number] | null>(
    (found, row) => (!found || row.requestedAt > found.requestedAt ? row : found),
    null,
  );
  return latest?.id ?? null;
}
