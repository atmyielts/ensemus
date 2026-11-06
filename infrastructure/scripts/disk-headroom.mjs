// Refuse a resource-heavy rehearsal before it consumes the last host disk space. This only reads
// filesystem statistics: it never chooses files to delete, changes Docker, or reclaims user data.
import { statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MINIMUM_BUILD_FREE_BYTES = 16n * 1024n ** 3n;

export function assertDiskHeadroom(paths, { statfs = statfsSync } = {}) {
  for (const path of new Set(paths.map((value) => resolve(value)))) {
    const stats = statfs(path, { bigint: true });
    const available = stats.bavail * stats.bsize;
    if (available < MINIMUM_BUILD_FREE_BYTES) {
      throw new Error(
        `Build paused: ${path} has ${(Number(available) / 1024 ** 3).toFixed(1)} GiB free; ` +
          'at least 16 GiB is required before this rehearsal. No cleanup was performed.',
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assertDiskHeadroom([process.cwd(), tmpdir()]);
}
