#!/usr/bin/env node
// Verifies a release using only Node, with no network and no contact with Ensemus. This file ships
// in the release folder so a Sovereign operator can run it on an isolated machine:
//   node verify-release.mjs <release-folder> <public-key.pem>
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const folder = resolve(process.argv[2] ?? '.');
const publicKeyPath = process.argv[3] ?? join(folder, 'release-signing-public.pem');
const problems = [];

const manifestBytes = readFileSync(join(folder, 'release-manifest.json'));
const signature = Buffer.from(readFileSync(join(folder, 'release-manifest.sig'), 'utf8'), 'base64');
const publicKey = createPublicKey(readFileSync(publicKeyPath));

const signatureOk = verify(null, manifestBytes, publicKey, signature);
console.log(`Signature: ${signatureOk ? 'valid' : 'INVALID'}`);
if (!signatureOk) problems.push('signature');

// Only trust the manifest's contents once its signature has checked out.
if (signatureOk) {
  const manifest = JSON.parse(manifestBytes);
  for (const [name, entry] of Object.entries(manifest.sboms)) {
    const digest = createHash('sha256')
      .update(readFileSync(join(folder, entry.file)))
      .digest('hex');
    const ok = digest === entry.sha256;
    console.log(`SBOM ${name}: ${entry.packages} packages, digest ${ok ? 'matches' : 'MISMATCH'}`);
    if (!ok) problems.push(`sbom:${name}`);
  }
  console.log(`Signed with: ${manifest.signing}`);
}

if (problems.length) {
  console.error(`FAILED: ${problems.join(', ')}`);
  process.exit(1);
}
console.log('OK: this release verified with no network access.');
