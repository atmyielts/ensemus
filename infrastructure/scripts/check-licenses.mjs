#!/usr/bin/env node
// FOUND-07: fails when a production dependency has a license nobody has reviewed. Because Sovereign
// redistributes software under a perpetual license, new license types need a deliberate decision.
// This is an engineering gate, not legal advice. Counsel reviews the release in LEGAL-05.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  '(MIT OR CC0-1.0)',
  'MIT OR Apache-2.0',
  'Apache-2.0 OR MIT',
  '(MIT OR Apache-2.0)',
  '(Apache-2.0 OR MIT)',
  'Apache-2.0 AND MIT',
]);

// Each exception names why it is acceptable, and must be re-checked by counsel before release.
const REVIEWED_EXCEPTIONS = {
  'Apache-2.0 AND LGPL-3.0-or-later':
    'Native image library pulled in by Next.js (@img/sharp-*). Images are unoptimized, so sharp is unused at runtime. Remove from images or confirm with counsel in LEGAL-05.',
  'LGPL-3.0-or-later':
    'Optional native image library pulled in by Next.js (@img/sharp-libvips). Images are unoptimized, so sharp is unused at runtime. Remove from images or confirm with counsel in LEGAL-05.',
  'CC-BY-4.0':
    'caniuse-lite browser data, a build-time dependency of Next.js. Needs attribution in the release notices.',
  Unknown:
    'unionfs, used by the Temporal workflow bundler at build time. Its LICENSE file is the Unlicense, but its package.json does not say so.',
  'MIT License':
    'xml-escape, pulled in by samlify for SAML sign-in (ADR-031 D9). Its package.json spells MIT this way, and its LICENSE file is MIT.',
  'MPL-2.0':
    'File-level copyleft, used unmodified. Obligations apply only to changes in those files.',
};

const licenses = (...args) =>
  JSON.parse(
    execFileSync('pnpm', ['licenses', 'list', '--json', ...args], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
const byLicense = licenses('--prod', '-r');

// Playwright and axe are dev dependencies of tests/browser. They are never redistributed, but their
// licenses are still reviewed here, and neither may ever reach what ships.
const BROWSER_TOOLS =
  /^(@playwright\/test|playwright|playwright-core|@axe-core\/playwright|axe-core)$/;
const shipped = Object.values(byLicense)
  .flat()
  .filter((p) => BROWSER_TOOLS.test(p.name))
  .map((p) => p.name);
if (shipped.length) {
  console.error(`FAILED: browser test tools reached production: ${shipped.join(', ')}`);
  process.exit(1);
}
const devByLicense = licenses('--dev', '--filter', '@ensemus/browser-tests');
const tools = Object.entries(devByLicense).flatMap(([license, packages]) =>
  packages.filter((p) => BROWSER_TOOLS.test(p.name)).map((p) => [license, p.name]),
);
for (const [license, name] of tools) {
  if (!ALLOWED.has(license) && !REVIEWED_EXCEPTIONS[license]) {
    console.error(`FAILED: ${name} is under ${license}, which has not been reviewed.`);
    process.exit(1);
  }
}
console.log(
  `Browser test tools, dev only: ${tools.map(([license, name]) => `${name} (${license})`).join(', ')}.`,
);

const blocked = [];
const exceptions = [];
let total = 0;
for (const [license, packages] of Object.entries(byLicense)) {
  total += packages.length;
  if (ALLOWED.has(license)) continue;
  const names = packages.map((p) => p.name).join(', ');
  // A missing license must be checked package by package, never accepted as a category.
  if (license === 'Unknown' && names !== 'unionfs') blocked.push(`${license}: ${names}`);
  else if (REVIEWED_EXCEPTIONS[license]) exceptions.push(`${license}: ${names}`);
  else blocked.push(`${license}: ${names}`);
}

console.log(
  `Checked ${total} production packages across ${Object.keys(byLicense).length} licenses.`,
);
for (const line of exceptions) console.log(`Reviewed exception, needs counsel check: ${line}`);
if (blocked.length) {
  console.error('\nFAILED: these licenses have not been reviewed:');
  for (const line of blocked) console.error(`- ${line}`);
  process.exit(1);
}
console.log('OK: no unreviewed licenses.');
