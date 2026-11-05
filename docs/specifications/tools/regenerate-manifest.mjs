#!/usr/bin/env node
// Rewrites the file list in MANIFEST.json from what is on disk, keeping its other fields.
//   node specifications/tools/regenerate-manifest.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suite = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(suite, 'MANIFEST.json');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(suite)
  .map((full) => path.relative(suite, full).split(path.sep).join('/'))
  .filter((rel) => rel !== 'MANIFEST.json')
  .sort()
  .map((rel) => {
    const bytes = fs.readFileSync(path.join(suite, rel));
    return { path: rel, size_bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.files = files;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`MANIFEST.json lists ${files.length} files`);
