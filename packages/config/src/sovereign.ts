// Settings for licensing and the archive (ADR-030). Every one is optional, because a deployment with no
// trust root has an answer for that, which is a notice on one page, and is never a failure to start.
import { z } from 'zod';
import { ConfigError } from './index';

const schema = z.object({
  /** A file an operator mounts, in `ensemus.trust_root` format. Public keys only. */
  ENSEMUS_LICENSE_TRUST_ROOT_FILE: z.string().min(1).optional(),
  /** This deployment's installed `bundle-manifest.dsse.json`, so it can say which release it runs. */
  ENSEMUS_BUNDLE_MANIFEST_FILE: z.string().min(1).optional(),
  ENSEMUS_RELEASE: z.string().min(1).max(64).default('unreleased'),
  /** Hours an archive stays in the store. Not a promise to anyone, and the operator's to set. */
  ENSEMUS_EXPORT_RETENTION_HOURS: z.coerce.number().int().min(1).max(8760).default(24),
});

export type SovereignConfig = {
  trustRootFile: string | null;
  bundleManifestFile: string | null;
  release: string;
  exportRetentionHours: number;
};

export function loadSovereignConfig(env: NodeJS.ProcessEnv = process.env): SovereignConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid sovereign configuration: ${fields}`);
  }
  return {
    trustRootFile: parsed.data.ENSEMUS_LICENSE_TRUST_ROOT_FILE ?? null,
    bundleManifestFile: parsed.data.ENSEMUS_BUNDLE_MANIFEST_FILE ?? null,
    release: parsed.data.ENSEMUS_RELEASE,
    exportRetentionHours: parsed.data.ENSEMUS_EXPORT_RETENTION_HOURS,
  };
}
