#!/usr/bin/env node
// LEGAL-05: lists every distributed component and its license, for counsel to review (ADR-036 D7).
//   node infrastructure/scripts/license-inventory.mjs [--check] [--sbom-dir <dir>] [--out <dir>]
//
// Writes license-inventory.json, license-inventory.csv and THIRD-PARTY-NOTICES.draft.md, by default
// to .local/release/licenses/. With --check it is the gate: it exits 1 if the list cannot be trusted.
// It needs no Docker. A flag for counsel to look at is not a failure, and a gap in the list is.
//
// This is not check-licenses.mjs, which asks whether someone has looked at a license type, and it
// never says anything was reviewed. Counsel's review is recorded outside this tool.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  absolutePathsIn,
  buildInventory,
  checkProblems,
  composeImages,
  declaredSection,
  dockerfileBaseImage,
  filesNeedingAnEntry,
  imageComponents,
  mentionsDirectory,
  mergeComponents,
  npmComponents,
  renderCsv,
  renderNotices,
  sbomComponents,
  sbomLeftOut,
  testOnlyImages,
  withNotes,
} from './license-rules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUTS = {
  json: 'license-inventory.json',
  csv: 'license-inventory.csv',
  notices: 'THIRD-PARTY-NOTICES.draft.md',
};
// What each package filter's production dependencies go into. See infrastructure/containers/.
const NPM_SOURCES = { '@ensemus/web': 'web_image', '@ensemus/worker': 'worker_image' };
const BASE_IMAGES = { 'Dockerfile.web': 'web_image', 'Dockerfile.worker': 'worker_image' };
// The names infrastructure/scripts/build-release.mjs gives its SBOMs.
const SBOMS = { 'sbom-web.spdx.json': 'web_image', 'sbom-worker.spdx.json': 'worker_image' };

const read = (...path) => readFileSync(join(root, ...path), 'utf8');
const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

function listLicenses(filter) {
  let printed;
  try {
    printed = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod', '--filter', filter], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`pnpm licenses list failed for ${filter}: ${error.stderr || error.message}`);
  }
  try {
    return JSON.parse(printed);
  } catch {
    throw new Error(`pnpm licenses list for ${filter} did not print JSON`);
  }
}

// Every text that was read, by its hash, so one copy of a license serves all who share it.
const licenseTexts = {};

function keep(directory, file) {
  const bytes = readFileSync(join(directory, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  licenseTexts[sha256] = bytes.toString('utf8');
  return { file, sha256 };
}

function licenseTextOf(directory) {
  let names;
  try {
    names = readdirSync(directory).sort();
  } catch {
    return { found: false };
  }
  const isFile = (name) => statSync(join(directory, name)).isFile();
  const licenses = names.filter(
    (name) => /^(licen[cs]e|copying|unlicense|copyright)([._-].*)?$/i.test(name) && isFile(name),
  );
  // A NOTICE is not a license, so it never counts as finding one. Apache-2.0 asks for it to be
  // carried, so counsel sees it as well.
  const notices = names.filter((name) => /^notice([._-].*)?$/i.test(name) && isFile(name));
  const others = [...licenses.slice(1), ...notices].map((name) => keep(directory, name));
  if (licenses.length === 0) return { found: false, others };
  return { found: true, ...keep(directory, licenses[0]), others };
}

function collectNpm() {
  const lists = Object.entries(NPM_SOURCES).map(([filter, distributedIn]) =>
    npmComponents(listLicenses(filter), { distributedIn, licenseTextOf }),
  );
  return mergeComponents(lists);
}

function collectImages(declarations) {
  const compose = composeImages(read('infrastructure', 'compose', 'compose.yaml'));
  if (compose.length === 0) throw new Error('compose.yaml names no image');
  const bases = Object.entries(BASE_IMAGES).map(([file, artifact]) => ({
    image: dockerfileBaseImage(read('infrastructure', 'containers', file)),
    service: `the final stage of ${file}`,
    distributedIn: [artifact],
  }));
  const leftOut = testOnlyImages(read('infrastructure', 'compose', 'compose.test.yaml'), compose);
  const { components, problems } = imageComponents([...compose, ...bases], declarations);
  return {
    components,
    problems,
    section: {
      state: 'declared_by_hand',
      source:
        'infrastructure/compose/compose.yaml, the Dockerfiles in infrastructure/containers, and infrastructure/licenses/components.json',
      reason:
        `Licenses are read from each upstream project, not from inside the image. Left out as test tools that do not ship, because only compose.test.yaml uses them: ${leftOut.join(', ') || 'none'}. ` +
        'What each image contains, such as its OS packages, is not listed here.',
    },
  };
}

function collectOsPackages(sbomDir) {
  if (!sbomDir) {
    return {
      components: [],
      section: {
        state: 'not_collected',
        source: 'SBOMs from infrastructure/scripts/build-release.mjs',
        reason:
          'No --sbom-dir was given. The SBOMs need Docker to build, so no OS package inside any image is listed.',
      },
    };
  }
  // A folder missing one SBOM must stop the run, because half a section would read as all of it.
  const lists = [];
  const leftOut = {};
  for (const [file, artifact] of Object.entries(SBOMS)) {
    const spdx = JSON.parse(readFileSync(join(resolve(sbomDir), file), 'utf8'));
    lists.push(sbomComponents(spdx, artifact));
    for (const [type, count] of Object.entries(sbomLeftOut(spdx))) {
      leftOut[type] = (leftOut[type] ?? 0) + count;
    }
  }
  const others = Object.entries(leftOut)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
  return {
    components: mergeComponents(lists),
    section: {
      state: 'collected',
      source: Object.keys(SBOMS).join(' and '),
      reason:
        'Only the web and worker images have SBOMs, so the third-party images are not read here. ' +
        `Other entries in these SBOMs are not OS packages and are not listed in this section: ${others || 'none'}.`,
    },
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      'sbom-dir': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const out = values.out
    ? resolve(values.out)
    : join(root, '.local', 'release', 'licenses');

  // Clear the last run first. A failed run must not leave an older inventory looking current.
  for (const file of Object.values(OUTPUTS)) rmSync(join(out, file), { force: true });

  const declared = JSON.parse(read('infrastructure', 'licenses', 'components.json'));
  const release = {
    commit: git('rev-parse', 'HEAD').trim(),
    dirty: git('status', '--porcelain').trim() !== '',
    ...(process.env.ENSEMUS_RELEASE ? { release: process.env.ENSEMUS_RELEASE } : {}),
  };

  const npm = withNotes(collectNpm(), declared.npm_notes ?? []);
  const images = collectImages(declared.images ?? []);
  const os = collectOsPackages(values['sbom-dir']);
  const source = 'infrastructure/licenses/components.json';
  const weights = declaredSection(declared.model_weights, 'model_weights', source);
  const other = declaredSection(declared.other, 'other', source);

  const inventory = buildInventory({
    release,
    sections: {
      npm: {
        state: 'collected',
        source: `pnpm licenses list --json --prod, for ${Object.keys(NPM_SOURCES).join(' and ')}`,
        reason:
          'This is what the package manager resolves for production, so it can name more than an image keeps after its build. ' +
          `Packages built for one platform are as installed where this ran (${process.platform} ${process.arch}), so the list for a release has to be made on the platform its images use.`,
      },
      container_images: images.section,
      os_packages: os.section,
      model_weights: weights.section,
      other: other.section,
    },
    components: [...npm, ...images.components, ...os.components, ...weights.components, ...other.components],
  });

  const tracked = git('ls-files').split(/\r?\n/).filter(Boolean);
  const saysNone = inventory.sections.other.state === 'none_distributed';
  const unaccounted = (saysNone ? filesNeedingAnEntry(tracked) : []).map(
    (file) => `${file} looks distributed, but the other section says nothing is`,
  );
  const problems = [
    ...new Set([...images.problems, ...checkProblems(inventory), ...unaccounted]),
  ];

  const rendered = {
    json: `${JSON.stringify(inventory, null, 2)}\n`,
    csv: renderCsv(inventory),
    notices: renderNotices(inventory, licenseTexts),
  };
  // Nothing is written with a path in it, with or without --check: these files get passed around.
  const leaks = [
    ...absolutePathsIn(inventory),
    ...Object.entries(rendered).flatMap(([name, text]) =>
      [root, homedir()].filter((path) => mentionsDirectory(text, path)).map(() => OUTPUTS[name]),
    ),
  ];
  if (leaks.length) {
    throw new Error(`refusing to write, a path on this machine reached: ${leaks.join(', ')}`);
  }

  mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(rendered)) writeFileSync(join(out, OUTPUTS[name]), text);

  console.log(`${inventory.components.length} components, review: ${inventory.review}.`);
  for (const [name, section] of Object.entries(inventory.sections)) {
    console.log(`- ${name}: ${section.state}, ${section.count}`);
  }
  console.log(`Wrote ${Object.values(OUTPUTS).join(', ')}. This is a draft for counsel, not a review.`);

  if (problems.length) {
    const says = values.check ? 'FAILED: the inventory cannot be trusted:' : 'Problems --check refuses:';
    console.error(`\n${says}`);
    for (const problem of problems) console.error(`- ${problem}`);
    if (values.check) process.exitCode = 1;
  } else {
    console.log('OK: every distributed component is accounted for. That says nothing about review.');
  }
}

try {
  main();
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
}
