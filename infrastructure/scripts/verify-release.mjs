#!/usr/bin/env node
// Verifies a release using only Node, with no network and no contact with Ensemus. This file ships
// alone in the release folder so a Sovereign operator can run it on an isolated machine, so it imports
// nothing but node: modules:
//   node verify-release.mjs <release-folder> <public-key.pem> [--allow-test-key]
//
// The key has to come from outside the release. Whoever can change a manifest can change a key sitting
// beside it, so a key from the folder proves nothing (ADR-037 D4).
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// Repeated from release-signing.mjs, because this file ships without it. Keep the two identical.
const THROWAWAY_MARKER = 'THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION';
const ALLOW_TEST_KEY = '--allow-test-key';
const USAGE = `Usage: node verify-release.mjs <release-folder> <public-key.pem> [${ALLOW_TEST_KEY}]`;

class Refused extends Error {}

function parseArguments(args) {
  const positional = args.filter((arg) => !arg.startsWith('--'));
  // A flag spelled wrongly must not quietly mean a stricter or looser check than the one asked for.
  const unknown = args.filter((arg) => arg.startsWith('--') && arg !== ALLOW_TEST_KEY);
  if (unknown.length) throw new Refused(`unknown option ${unknown.join(' ')}. ${USAGE}`);
  if (positional.length > 2) throw new Refused(`unexpected ${positional[2]}. ${USAGE}`);
  if (positional.length === 0) throw new Refused(USAGE);
  return {
    folder: resolve(positional[0]),
    keyPath: positional[1],
    allowTestKey: args.includes(ALLOW_TEST_KEY),
  };
}

function isInside(folder, path) {
  // Real paths, because a link, a relative path or a Windows short name can all hide where a file is.
  const fromFolder = relative(realpathSync.native(folder), realpathSync.native(path));
  return fromFolder !== '..' && !fromFolder.startsWith(`..${sep}`) && !isAbsolute(fromFolder);
}

function readWith(what, read) {
  try {
    return read();
  } catch {
    throw new Refused(`could not read ${what}.`);
  }
}

function checkMarker(signing, allowTestKey) {
  if (typeof signing !== 'string' || signing === '') return ['signing: the manifest does not say'];
  if (signing === THROWAWAY_MARKER) {
    return allowTestKey
      ? []
      : [`this is a test release, signed with a throwaway key. It is not for distribution`];
  }
  // A copy of the marker that has drifted must not read as a real release, in either direction.
  if (/throwaway|test.?key/i.test(signing)) {
    return ['this looks like a test release, but its marker is not the one this verifier knows'];
  }
  return allowTestKey
    ? [`${ALLOW_TEST_KEY} was given, but this release is not marked as a test. Run without it`]
    : [];
}

function checkSboms(folder, sboms) {
  const entries = Object.entries(sboms ?? {});
  if (entries.length === 0) return ['sbom: the manifest lists none'];
  const problems = [];
  for (const [name, entry] of entries) {
    let digest = null;
    try {
      digest = createHash('sha256')
        .update(readFileSync(join(folder, entry.file)))
        .digest('hex');
    } catch {
      // Reported below as a mismatch, since a file that is not there is not the file that was signed.
    }
    const ok = digest !== null && digest === entry.sha256;
    console.log(`SBOM ${name}: ${entry.packages} packages, digest ${ok ? 'matches' : 'MISMATCH'}`);
    if (!ok) problems.push(`sbom:${name}`);
  }
  return problems;
}

function check({ folder, keyPath, allowTestKey }) {
  if (!keyPath) {
    throw new Refused(
      `no public key named. This needs a key from outside the release, obtained separately from it. ${USAGE}`,
    );
  }
  const manifestBytes = readWith('release-manifest.json', () =>
    readFileSync(join(folder, 'release-manifest.json')),
  );
  const signature = readWith('release-manifest.sig', () =>
    Buffer.from(readFileSync(join(folder, 'release-manifest.sig'), 'utf8'), 'base64'),
  );
  const publicKey = readWith('the public key', () => createPublicKey(readFileSync(keyPath)));
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Refused('the public key is not an Ed25519 key.');
  }
  // With the flag, a test release is all this can come to, so a key beside it costs nothing. A plain OK
  // is a claim about a real release, and a key from the folder cannot back that claim.
  if (!allowTestKey && isInside(folder, keyPath)) {
    throw new Refused(
      'the public key named is inside the release. This needs a key from outside the release.',
    );
  }

  const signatureOk = verify(null, manifestBytes, publicKey, signature);
  console.log(`Signature: ${signatureOk ? 'valid' : 'INVALID'}`);
  if (!signatureOk) return { problems: ['signature'] };

  // Only trust the manifest's contents once its signature has checked out.
  const manifest = readWith('the signed manifest', () => JSON.parse(manifestBytes));
  const keyId = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  const problems = [
    ...(manifest.signing_key_id === keyId
      ? []
      : ['signing_key_id: the manifest does not name the key given']),
    ...checkMarker(manifest.signing, allowTestKey),
    ...checkSboms(folder, manifest.sboms),
  ];
  console.log(`Signed with: ${manifest.signing}`);
  console.log(`Key ID: ${keyId}`);
  return { problems, isTest: manifest.signing === THROWAWAY_MARKER };
}

function main(args) {
  let outcome;
  try {
    outcome = check(parseArguments(args));
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    outcome = { problems: [error.message] };
  }
  if (outcome.problems.length) {
    console.error(`FAILED: ${outcome.problems.join('; ')}`);
    return 1;
  }
  console.log(
    outcome.isTest
      ? 'OK (test key, not a release)'
      : 'OK: this release verified with no network access.',
  );
  return 0;
}

// exitCode and not exit(), because on Windows a write to a pipe may still be on its way.
try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  // Nothing expected reaches here. It still has to fail, and an operator needs only the reason.
  console.error(`FAILED: ${error instanceof Error ? error.message : 'unexpected error'}`);
  process.exitCode = 1;
}
