// Owned by the restore slice (OPS-02). See docs/06-delivery/m6-slices.md and ADR-030 D11. The operator's command,
// run after a restore and before anyone is let back in: `node dist/restore-reconcile.js [--apply]`.
// A new `restore-reconcile-command.ts` is the command.
process.stderr.write('Not built yet\n');
process.exit(1);
