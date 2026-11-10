import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupUpgradeScratch } from '../../infrastructure/scripts/upgrade-cleanup.mjs';

const roots: string[] = [];
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ensemus-cleanup-test-')));
  roots.push(root);
  const scratch = join(root, 'ensemus-upgrade-test');
  const tree = join(scratch, 'base');
  mkdirSync(tree, { recursive: true });
  for (const label of ['base', 'current'])
    writeFileSync(join(scratch, `images-${label}.yaml`), 'generated');
  return { root, scratchParent: root, scratch, tree };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    // These exact absolute directories were created by this test, never a user-supplied path.
    if (realpathSync.native(root) !== root || !root.includes('ensemus-cleanup-test-'))
      throw new Error('TEST_CLEANUP_SCOPE');
    rmSync(root, { recursive: true });
  }
});

describe('upgrade scratch cleanup on the real filesystem', () => {
  it('removes only the two generated files after Git confirms its exact empty tree was removed', () => {
    const value = fixture();
    const removeWorktree = vi.fn((tree: string) => {
      expect(tree).toBe(value.tree);
      rmdirSync(tree);
      return true;
    });
    cleanupUpgradeScratch({ ...value, removeWorktree });
    expect(removeWorktree).toHaveBeenCalledOnce();
    expect(existsSync(value.scratch)).toBe(false);
    expect(existsSync(value.root)).toBe(true);
  });
  it('preserves unknown files and does not ask Git to remove anything', () => {
    const value = fixture();
    writeFileSync(join(value.scratch, 'keep.txt'), 'work to preserve');
    const removeWorktree = vi.fn();
    expect(() => cleanupUpgradeScratch({ ...value, removeWorktree })).toThrow('SCOPE_REFUSED');
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(readFileSync(join(value.scratch, 'keep.txt'), 'utf8')).toBe('work to preserve');
    expect(existsSync(value.tree)).toBe(true);
  });
  it('preserves a worktree Git refuses instead of recursively deleting it', () => {
    const value = fixture();
    writeFileSync(join(value.tree, 'edited.txt'), 'uncommitted');
    expect(() => cleanupUpgradeScratch({ ...value, removeWorktree: () => false })).toThrow(
      'WORKTREE_CLEANUP_REFUSED',
    );
    expect(readFileSync(join(value.tree, 'edited.txt'), 'utf8')).toBe('uncommitted');
    expect(existsSync(join(value.scratch, 'images-base.yaml'))).toBe(true);
  });
  it('refuses a substituted tree junction before touching its destination', () => {
    const value = fixture();
    rmdirSync(value.tree);
    const outside = join(value.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'untouched');
    symlinkSync(outside, value.tree, process.platform === 'win32' ? 'junction' : 'dir');
    const removeWorktree = vi.fn();
    expect(() => cleanupUpgradeScratch({ ...value, removeWorktree })).toThrow('SCOPE_REFUSED');
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('untouched');
  });
});
