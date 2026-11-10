import { describe, expect, it, vi } from 'vitest';
import {
  assertDiskHeadroom,
  MINIMUM_BUILD_FREE_BYTES,
} from '../../infrastructure/scripts/disk-headroom.mjs';

describe('host disk headroom before heavy rehearsals', () => {
  it('refuses either a full source drive or a full temporary drive without mutating anything', () => {
    for (const lowAt of [0, 1]) {
      let at = 0;
      const statfs = vi.fn(() => ({
        bavail: at++ === lowAt ? MINIMUM_BUILD_FREE_BYTES - 1n : MINIMUM_BUILD_FREE_BYTES,
        bsize: 1n,
      }));
      expect(() => assertDiskHeadroom(['source-drive', 'temporary-drive'], { statfs })).toThrow(
        'No cleanup was performed',
      );
      expect(statfs).toHaveBeenCalledTimes(lowAt + 1);
    }
  });

  it('accepts exact headroom and checks a shared location once using available, not total, blocks', () => {
    const statfs = vi.fn(() => ({
      bavail: MINIMUM_BUILD_FREE_BYTES / 4096n,
      bfree: 0n,
      blocks: 0n,
      bsize: 4096n,
    }));
    expect(() =>
      assertDiskHeadroom(['same-location', './same-location'], { statfs }),
    ).not.toThrow();
    expect(statfs).toHaveBeenCalledTimes(1);
  });

  it('fails closed if host filesystem statistics cannot be read', () => {
    const statfs = vi.fn(() => {
      throw new Error('statistics unavailable');
    });
    expect(() => assertDiskHeadroom(['source-drive'], { statfs })).toThrow(
      'statistics unavailable',
    );
  });
});
