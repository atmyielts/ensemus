// Owned by the diagnostics slice (SOV-06). See docs/06-delivery/m6-slices.md and ADR-030 D12. The operator's
// command: `node dist/diagnostics-export.js collect --out <dir>`, then `seal --report <file> --recipient <key>
// --approved-by <name>`. It writes files on this machine, and sends nothing anywhere.
// A new `diagnostics-command.ts` is the command.
process.stderr.write('Not built yet\n');
process.exit(1);
