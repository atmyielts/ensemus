import { describe, expect, it } from 'vitest';
import {
  isValidSyncPage,
  syncCursorLimit,
  MAX_SYNC_CURSOR_LENGTH,
  MAX_COMPOSITE_SYNC_CURSOR_LENGTH,
  type SyncPage,
} from '@ensemus/domain/connector';

describe('registered multi-drive cursor bounds', () => {
  const page = (cursor: string): SyncPage => ({
    resources: [],
    deletedExternalIds: [],
    nextCursor: cursor,
    hasMore: true,
  });
  it('keeps the ordinary SDK bound when a caller supplies no registered capability', () => {
    expect(isValidSyncPage('drive_items', page('x'.repeat(MAX_SYNC_CURSOR_LENGTH)))).toBe(true);
    expect(isValidSyncPage('drive_items', page('x'.repeat(MAX_SYNC_CURSOR_LENGTH + 1)))).toBe(
      false,
    );
    expect(syncCursorLimit('email_smtp', 'drive_items')).toBe(MAX_SYNC_CURSOR_LENGTH);
    expect(syncCursorLimit('microsoft_365', 'other_stream')).toBe(MAX_SYNC_CURSOR_LENGTH);
  });
  it.each([
    ['google_workspace', 'drive_files'],
    ['microsoft_365', 'drive_items'],
  ])(
    'allows the registered %s continuation without making its bound unlimited',
    (connector, stream) => {
      const limit = syncCursorLimit(connector, stream);
      expect(limit).toBe(MAX_COMPOSITE_SYNC_CURSOR_LENGTH);
      expect(isValidSyncPage(stream, page('x'.repeat(20_000)), limit)).toBe(true);
      expect(isValidSyncPage(stream, page('x'.repeat(limit + 1)), limit)).toBe(false);
      expect(isValidSyncPage(stream, page('x'), Number.MAX_SAFE_INTEGER)).toBe(false);
    },
  );
});
