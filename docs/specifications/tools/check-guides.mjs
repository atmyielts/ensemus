#!/usr/bin/env node
// DOC-01, DOC-02: checks the guides in docs/guides. Dependency-free; run from anywhere:
//   node docs/specifications/tools/check-guides.mjs            every guide is well formed and accounted for
//   node docs/specifications/tools/check-guides.mjs --release  and none is a stub or unfollowed
//   node docs/specifications/tools/check-guides.mjs --pages-only  the pages, for a writer on one slice
// Exits 1 on any failure. A pass shows the guides are well formed and make no forbidden claim. It does
// not show they are right. Only following them does, and DOC-02 needs someone else to.
import fs from 'node:fs';
import path from 'node:path';
import { loadGuides, repo } from './guide-files.mjs';
import {
  coverageProblems,
  GUIDE_STATUSES,
  HELP_MODULE_PATH,
  indexProblems,
  releaseProblems,
  renderHelpModule,
} from './guide-rules.mjs';

const release = process.argv.includes('--release');
const { index, tickets, exempt, files, pages } = loadGuides();

const problems = [
  ...indexProblems(index, files),
  ...pages.flatMap((page) => page.problems.map((problem) => `${page.path}: ${problem}`)),
  ...coverageProblems(pages, exempt, tickets),
];
if (release) problems.push(...releaseProblems(pages));

// What people read in the product has to be what the guides say. A writer on one slice does not rebuild
// this, because the module is shared by every slice, so --pages-only leaves it to the final merge.
if (problems.length === 0 && !process.argv.includes('--pages-only')) {
  const generated = path.join(repo, HELP_MODULE_PATH);
  const current = fs.existsSync(generated) ? fs.readFileSync(generated, 'utf8') : '';
  if (current.replaceAll('\r\n', '\n') !== renderHelpModule(index, pages)) {
    problems.push(`${HELP_MODULE_PATH} is out of date. Run pnpm guides:build`);
  }
}

const counts = Object.fromEntries(GUIDE_STATUSES.map((status) => [status, 0]));
for (const page of pages) if (page.fields) counts[page.fields.status] += 1;
console.log(`guides: ${pages.length} pages, ${JSON.stringify(counts)}`);
console.log(`tickets with a stated reason for no guide: ${exempt.size}`);

if (problems.length) {
  console.error(`\nFAILED with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(
  release
    ? 'OK: every guide is written, and those that must be were followed by someone else.'
    : 'OK: the guides are well formed and accounted for. This does not show they are right.',
);
