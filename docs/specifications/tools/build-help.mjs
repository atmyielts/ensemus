#!/usr/bin/env node
// DOC-01: writes what the product's Help pages show, from docs/guides/user. docs/ does not reach the
// image, and Sovereign has to read its help with no network, so the content is compiled in, the same way
// the API contract's generated types are. check-guides.mjs fails if this file is out of date.
//   node docs/specifications/tools/build-help.mjs
import fs from 'node:fs';
import path from 'node:path';
import { loadGuides, repo } from './guide-files.mjs';
import { HELP_MODULE_PATH, renderHelpModule, VISIBLE_STATUSES } from './guide-rules.mjs';

const { index, pages } = loadGuides();
const broken = pages.filter((page) => page.problems.length > 0);
if (broken.length) {
  console.error('Fix these first (node docs/specifications/tools/check-guides.mjs lists why):');
  for (const page of broken) console.error(`- ${page.path}`);
  process.exit(1);
}
const target = path.join(repo, HELP_MODULE_PATH);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, renderHelpModule(index, pages));
const shown = pages.filter(
  (page) => page.path.startsWith('user/') && VISIBLE_STATUSES.includes(page.fields.status),
);
console.log(`${HELP_MODULE_PATH} holds ${shown.length} pages`);
