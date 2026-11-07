// SOV-03: checks a bundle against a trust root the operator already holds, on a machine with no network and
// nothing else installed but Node. `build-sovereign-tools.mjs` bundles this into one file.
//   node verify-bundle.mjs <folder> --trust-root <file>
// Exit 0 means accepted, 1 refused, 2 a bad argument. The copy of this tool inside a bundle proves nothing about
// that bundle: use the one you already trust (ADR-030 D4).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadOperatorTrustRoot, verifyBundleDirectory } from '@ensemus/sovereign/bundle';

const USAGE = 'Usage: verify-bundle <folder> --trust-root <file>';

export type VerifyIo = { out(line: string): void; err(line: string): void };

export async function runVerifyBundle(argv: readonly string[], io: VerifyIo): Promise<number> {
  let folder: string | undefined;
  let trustRootFile: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { 'trust-root': { type: 'string' } },
    });
    folder = positionals.length === 1 ? positionals[0] : undefined;
    trustRootFile = values['trust-root'];
  } catch {
    folder = undefined;
  }
  if (!folder || !trustRootFile) {
    io.err(USAGE);
    return 2;
  }

  const trust = await loadOperatorTrustRoot(trustRootFile, folder);
  if (!trust.ok) {
    io.err(`refused code=${trust.code}`);
    return 1;
  }

  const verdict = await verifyBundleDirectory(folder, trust.root);
  if (!verdict.ok) {
    const details = [
      `code=${verdict.code}`,
      ...(verdict.reason ? [`reason=${verdict.reason}`] : []),
      ...(verdict.path ? [`path=${verdict.path}`] : []),
    ];
    io.err(`refused ${details.join(' ')}`);
    return 1;
  }

  const { manifest } = verdict;
  io.out(`accepted bundle=${manifest.bundle_id} version=${manifest.release.version}`);
  io.out(`signed by: ${verdict.keyIds.join(', ')}`);
  io.out(
    `files checked: ${String(manifest.files.length)}, images: ${String(manifest.images.length)}`,
  );
  if (verdict.testKey) {
    io.out('Signed with a generated test key. This bundle is for rehearsal, and nothing else.');
  }
  return 0;
}

const invokedDirectly = () => {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(realpathSync(entry)).href === import.meta.url;
};

if (invokedDirectly()) {
  process.exitCode = await runVerifyBundle(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).catch((error: unknown) => {
    // Fixed text and a code, since a message from a file system can carry a path nobody asked to log.
    process.stderr.write(`failed code=${(error as NodeJS.ErrnoException).code ?? 'UNEXPECTED'}\n`);
    return 1;
  });
}
