#!/usr/bin/env node
// Validates the backlog and traceability matrix. Dependency-free; run from anywhere:
//   node specifications/tools/check-backlog.mjs
// Exits 1 on any failure. This proves planned coverage only, not that anything is built or tested.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suite = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(suite, f), 'utf8');

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...data] = rows;
  return data.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const errors = [];
const list = (s) => s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
const MILESTONES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11'];

const tickets = parseCsv(read('specifications/implementation-backlog.csv'));
const retired = parseCsv(read('specifications/backlog-retired-tickets.csv'));
const trace = parseCsv(read('specifications/traceability.csv'));
const byId = new Map();

for (const t of tickets) {
  if (byId.has(t.id)) errors.push(`duplicate ticket ${t.id}`);
  byId.set(t.id, t);
  if (!MILESTONES.includes(t.milestone)) errors.push(`${t.id}: invalid milestone "${t.milestone}"`);
  if (!t.acceptance_criteria.trim()) errors.push(`${t.id}: no acceptance criteria`);
}

const retiredOnly = retired.filter((r) => r.outcome === 'retired');
const retiredIds = new Set(retiredOnly.map((r) => r.id));
for (const r of retired.filter((x) => x.outcome === 'narrowed')) {
  if (!byId.has(r.id)) errors.push(`${r.id}: narrowed but missing from the backlog`);
}
for (const r of retiredOnly) {
  if (byId.has(r.id)) errors.push(`${r.id}: retired but still in the backlog`);
  for (const s of list(r.merged_into)) if (!byId.has(s)) errors.push(`${r.id}: merged into unknown ticket ${s}`);
}

// Dependencies: must exist, must not be retired, and must not sit in a later milestone.
const deps = new Map(tickets.map((t) => [t.id, list(t.depends_on)]));
for (const [id, ds] of deps) {
  for (const d of ds) {
    if (retiredIds.has(d)) errors.push(`${id}: depends on retired ticket ${d}`);
    else if (!byId.has(d)) errors.push(`${id}: depends on unknown ticket ${d}`);
    else if (MILESTONES.indexOf(byId.get(d).milestone) > MILESTONES.indexOf(byId.get(id).milestone)) {
      errors.push(`${id} (${byId.get(id).milestone}) depends on ${d} (${byId.get(d).milestone}), which comes later`);
    }
  }
}

// No dependency cycles.
const state = new Map();
function visit(id, trail) {
  if (state.get(id) === 'done') return;
  if (state.get(id) === 'open') { errors.push(`dependency cycle: ${[...trail, id].join(' -> ')}`); return; }
  state.set(id, 'open');
  for (const d of deps.get(id) ?? []) if (byId.has(d)) visit(d, [...trail, id]);
  state.set(id, 'done');
}
for (const id of deps.keys()) visit(id, []);

// Every source item must appear in the matrix, mapped only to live tickets.
const source = [];
for (const line of read('01-product/01-product-requirements.md').split('\n')) {
  const m = line.match(/^\| ([A-Z]+-\d+) \|/);
  if (m) source.push(['requirement', m[1]]);
}
for (const q of parseCsv(read('specifications/qa-scenarios.csv'))) source.push(['qa', q.id]);
for (const r of parseCsv(read('specifications/threat-register.csv'))) source.push(['threat', r.risk_id]);
for (const m of read('06-delivery/03-acceptance-and-dod.md').matchAll(/^## Gate ([A-F])\b/gm)) source.push(['gate', `GATE-${m[1]}`]);
for (const m of read('01-product/02-personas-and-journeys.md').matchAll(/^## Journey ([A-F])\b/gm)) source.push(['journey', `JOURNEY-${m[1]}`]);
const faults = read('06-delivery/04-release-checklists.md').split('## Required fault scenarios')[1] ?? '';
for (const m of faults.matchAll(/^(\d+)\. /gm)) source.push(['fault', `FAULT-${m[1].padStart(2, '0')}`]);

const key = (type, id) => `${type}:${id}`;
const traced = new Map();
for (const t of trace) {
  const k = key(t.item_type, t.item_id);
  if (traced.has(k)) errors.push(`matrix lists ${k} twice`);
  traced.set(k, t);
  const ids = list(t.ticket_ids);
  if (!ids.length) errors.push(`${k}: no tickets`);
  for (const id of ids) {
    if (retiredIds.has(id)) errors.push(`${k}: uses retired ticket ${id}`);
    else if (!byId.has(id)) errors.push(`${k}: uses unknown ticket ${id}`);
  }
}
const sourceKeys = new Set(source.map(([type, id]) => key(type, id)));
for (const k of sourceKeys) if (!traced.has(k)) errors.push(`no matrix entry for ${k}`);
for (const k of traced.keys()) if (!sourceKeys.has(k)) errors.push(`matrix entry ${k} has no source item`);

const counts = {};
for (const [type] of source) counts[type] = (counts[type] ?? 0) + 1;
const perMilestone = Object.fromEntries(MILESTONES.map((m) => [m, tickets.filter((t) => t.milestone === m).length]));
console.log(`tickets: ${tickets.length} live, ${retiredOnly.length} retired, ${retired.length - retiredOnly.length} narrowed`);
console.log(`per milestone: ${JSON.stringify(perMilestone)}`);
console.log(`traced items: ${JSON.stringify(counts)}`);

if (errors.length) {
  console.error(`\nFAILED with ${errors.length} problem(s):`);
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}
console.log('OK: backlog and matrix are consistent. This shows planned coverage, not working software.');
