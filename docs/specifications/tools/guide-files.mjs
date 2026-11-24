// DOC-01, DOC-02: reads the guides from disk for check-guides.mjs and build-help.mjs. The rules themselves
// are in guide-rules.mjs, which never touches a file.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPage } from './guide-rules.mjs';

export const suite = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const repo = path.resolve(suite, '..');
const guides = path.join(suite, 'guides');

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...data] = rows;
  return data
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

const relative = (full) => path.relative(guides, full).split(path.sep).join('/');

/**
 * `m3-email:packages/x.ts` names a file on a branch still being written, which is how a guide is
 * written while its feature is on a branch. A plain path has to be in this tree. A release has only
 * plain paths, because slice guides-sweep rewrites them once the branches are merged.
 */
function sourceExists(entry) {
  const at = entry.indexOf(':');
  if (at < 0) return fs.existsSync(path.join(repo, entry));
  try {
    execFileSync('git', ['cat-file', '-e', entry], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function loadGuides() {
  const index = JSON.parse(fs.readFileSync(path.join(guides, 'index.json'), 'utf8'));
  const tickets = parseCsv(
    fs.readFileSync(path.join(suite, 'specifications', 'implementation-backlog.csv'), 'utf8'),
  );
  const knownTickets = new Set(tickets.map((ticket) => ticket.id));
  const exempt = new Map(
    parseCsv(fs.readFileSync(path.join(guides, 'coverage-exempt.csv'), 'utf8')).map((row) => [
      row.ticket,
      row.reason,
    ]),
  );
  const files = ['user', 'operator'].flatMap((audience) =>
    walk(path.join(guides, audience))
      .filter((full) => full.endsWith('.md'))
      .map(relative),
  );
  const exists = (target) => fs.existsSync(path.join(guides, target));
  const pages = files.map((file) => ({
    path: file,
    ...checkPage(file, fs.readFileSync(path.join(guides, file), 'utf8'), {
      exists,
      sourceExists,
      knownTickets,
    }),
  }));
  return { index, tickets, exempt, files, pages };
}
