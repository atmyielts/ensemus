import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Remove only this rehearsal's exact scratch files after Git has safely removed its worktree. */
export function cleanupUpgradeScratch({ scratchParent, scratch, tree, removeWorktree }) {
  const parent = realpathSync.native(scratchParent);
  const target = realpathSync.native(scratch);
  const same = (left, right) =>
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  const refused = () => {
    throw new Error('UPGRADE_CLEANUP_SCOPE_REFUSED');
  };
  if (
    !same(dirname(target), parent) ||
    !same(target, resolve(scratch)) ||
    !basename(target).startsWith('ensemus-upgrade-') ||
    !same(resolve(tree), join(target, 'base')) ||
    lstatSync(scratch).isSymbolicLink()
  )
    refused();

  const files = ['images-base.yaml', 'images-current.yaml'];
  // An unexpected file may be someone's work. Refuse before removing anything, even the Git tree.
  for (const entry of readdirSync(target)) {
    if (entry !== 'base' && !files.includes(entry)) refused();
    const stat = lstatSync(join(target, entry));
    if (stat.isSymbolicLink() || (entry === 'base' ? !stat.isDirectory() : !stat.isFile()))
      refused();
  }
  if (existsSync(tree)) {
    if (!same(realpathSync.native(tree), join(target, 'base'))) refused();
    if (!removeWorktree(tree) || existsSync(tree)) {
      throw new Error('UPGRADE_WORKTREE_CLEANUP_REFUSED: temporary work was preserved');
    }
  }
  for (const file of files) {
    const path = join(target, file);
    if (existsSync(path)) unlinkSync(path);
  }
  // Never use recursive deletion as a fallback if Git refused or another file appeared meanwhile.
  rmdirSync(target);
}
