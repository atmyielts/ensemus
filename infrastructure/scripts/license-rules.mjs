import { parseDocument } from 'yaml';

// What the license inventory decides (LEGAL-05, ADR-036 D7), apart from the files and processes it
// reads, so that a unit test can check each decision. See tests/unit/license-rules.test.ts.
//
// Everything here states a fact for counsel to look at. Nothing in it says a license is acceptable,
// so there is deliberately no list of "permissive" licenses: a license nobody recognised has to read
// as "no flag raised", never as "cleared".

export const REVIEW = 'draft_not_reviewed_by_counsel';
export const HAND_EVIDENCE = 'upstream_repository_not_the_image';
export const UNKNOWN = 'unknown';

// These repeat the schema's enums, because the script has no JSON Schema validator to run: ajv is a
// test dependency, and nothing here may need an install beyond what the gate already has. A unit test
// holds them equal to infrastructure/licenses/inventory.schema.json.
export const ATTENTION = [
  'no_license_declared',
  'license_text_not_found',
  'version_unknown',
  'several_licenses_named',
  'copyleft_family',
  'source_available_not_open_source',
  'attribution_family',
  'dual_or_choice_of_license',
  'declared_by_hand_not_read_from_artifact',
  'has_reviewed_exception_in_check_licenses',
];
export const KINDS = ['npm', 'container_image', 'os_package', 'runtime', 'model_weights', 'other'];
export const EVIDENCE = ['package_metadata', 'license_file', 'sbom', HAND_EVIDENCE, 'not_found'];
export const ARTIFACTS = ['web_image', 'worker_image', 'third_party_image', 'sovereign_bundle'];
export const SECTION_STATES = [
  'collected',
  'declared_by_hand',
  'not_collected',
  'none_distributed',
];

/** Which components each section answers for. A count that disagrees is refused. */
export const SECTION_KINDS = {
  npm: ['npm'],
  container_images: ['container_image'],
  os_packages: ['os_package'],
  model_weights: ['model_weights'],
  other: ['runtime', 'other'],
};

// The licenses check-licenses.mjs accepts as named exceptions. That script exports nothing and stays
// the separate gate, so a unit test reads its source and holds this list equal to it. Unknown is an
// exception there for one package only, so it is handled by name below and not listed here.
export const REVIEWED_EXCEPTIONS = [
  'Apache-2.0 AND LGPL-3.0-or-later',
  'LGPL-3.0-or-later',
  'CC-BY-4.0',
  'MPL-2.0',
  '(AFL-2.1 OR BSD-3-Clause)',
  'MIT License',
];
const REVIEWED_UNKNOWN_PACKAGE = 'unionfs';

const COPYLEFT = [
  /\b[AL]?GPL/i,
  /\bMPL/i,
  /\bEPL/i,
  /\bCDDL/i,
  /\bEUPL/i,
  /\bGFDL/i,
  /\bOSL/i,
  /\bMS-RL/i,
  /\bCECILL/i,
  /\bCC[- ]BY[- ](NC[- ])?SA\b/i,
  /\bgnu\b.*\bpublic licen[cs]e/i,
  /\bmozilla public\b/i,
  /\beclipse public\b/i,
  /\bcommon development and distribution\b/i,
  /\beuropean union public\b/i,
];
const SOURCE_AVAILABLE = [
  /\bSSPL/i,
  /\bserver side public\b/i,
  /\bBUSL/i,
  /\bBSL-1\.1\b/i,
  /\bbusiness source\b/i,
  /\belastic\b/i,
  /\bELv2\b/i,
  /\bcommons clause\b/i,
  /\bpolyform\b/i,
];
const ATTRIBUTION = [/\bCC[- ]BY\b/i, /\bcreative commons attribution\b/i];
// These say a license is somewhere else, or that none is granted, so they name no license at all.
const NAMES_NO_LICENSE = /^(see licen[cs]e\b|custom\b|unlicensed$)/i;

const SHA256 = /^[0-9a-f]{64}$/;
const anyMatch = (patterns, text) => patterns.some((pattern) => pattern.test(text));
const bySortOrder = (order) => (a, b) => order.indexOf(a) - order.indexOf(b);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (values, order) =>
  [...new Set(values)].sort(order ? bySortOrder(order) : compare);

/** What a component says, word for word, or `unknown` when what it says is nothing at all. */
export function declaredLicense(raw) {
  if (typeof raw !== 'string') return UNKNOWN;
  const said = raw.trim();
  return /^(|unknown|noassertion|none)$/i.test(said) ? UNKNOWN : said;
}

/** Facts for a reviewer to look at first. Each one is a fact about the text, never a verdict on it. */
export function attentionFor({ licenseDeclared, textFound, version, declaredByHand, name }) {
  const license = declaredLicense(licenseDeclared);
  const flags = [];
  const declaresNothing = license === UNKNOWN;
  if (declaresNothing || NAMES_NO_LICENSE.test(license)) flags.push('no_license_declared');
  if (!textFound) flags.push('license_text_not_found');
  if (version === undefined || version === null || version === '' || version === UNKNOWN) {
    flags.push('version_unknown');
  }
  if (declaredByHand) flags.push('declared_by_hand_not_read_from_artifact');
  if (declaresNothing) {
    if (name === REVIEWED_UNKNOWN_PACKAGE) flags.push('has_reviewed_exception_in_check_licenses');
    return flags;
  }

  // "GPL-2.0-or-later" is one license with a choice of version, not a choice of licenses. Requiring
  // a space or a bracket around the operator keeps a license ID's own hyphenated words out of it.
  const expression = license.replace(/\bor\s+(any\s+)?(later|newer)\b/gi, '');
  if (/(^|[\s(])or([\s)]|$)/i.test(expression)) flags.push('dual_or_choice_of_license');
  if (/(^|[\s(])and([\s)]|$)|[,;/]/i.test(expression)) flags.push('several_licenses_named');
  if (anyMatch(COPYLEFT, license)) flags.push('copyleft_family');
  if (anyMatch(SOURCE_AVAILABLE, license)) flags.push('source_available_not_open_source');
  if (anyMatch(ATTRIBUTION, license)) flags.push('attribution_family');
  if (REVIEWED_EXCEPTIONS.includes(license)) flags.push('has_reviewed_exception_in_check_licenses');
  return sortedUnique(flags, ATTENTION);
}

/** A file's name only. The directory it sat in holds the name of whoever ran this. */
const baseName = (file) => String(file).split(/[\\/]/).pop();

function textOf(found) {
  if (!found?.found || !found.file || !SHA256.test(found.sha256 ?? '')) return { found: false };
  return { found: true, file: baseName(found.file), sha256: found.sha256 };
}

/**
 * Turns what `pnpm licenses list --json` prints into components, one per version. An empty listing is
 * an error: pnpm has printed that for a tree with nothing installed, and it must never become an
 * inventory that lists nothing.
 */
export function npmComponents(byLicense, { distributedIn, licenseTextOf }) {
  if (byLicense === null || typeof byLicense !== 'object' || Array.isArray(byLicense)) {
    throw new Error('pnpm did not print a listing of licenses');
  }
  const artifacts = [distributedIn].flat().filter(Boolean);
  if (artifacts.length === 0) throw new Error('npm components need the artifact that carries them');

  const components = [];
  for (const [group, packages] of Object.entries(byLicense)) {
    for (const entry of packages) {
      // Our own workspace packages are not third-party components, even if pnpm lists one.
      if (entry.name.startsWith('@ensemus/')) continue;
      const versions = entry.versions?.length ? entry.versions : [UNKNOWN];
      versions.forEach((version, index) => {
        const license = declaredLicense(entry.license ?? group);
        const directory = entry.paths?.[index];
        const found = directory ? licenseTextOf(directory) : { found: false };
        const text = textOf(found);
        const others = (found?.others ?? []).filter((other) => SHA256.test(other.sha256 ?? ''));
        const note = [];
        if (license === UNKNOWN && text.found) {
          note.push('The package metadata names no license, but the package carries this file.');
        }
        if (others.length) {
          const listed = others.map((o) => `${baseName(o.file)} (sha256 ${o.sha256})`).join(', ');
          note.push(`Also carries ${listed}.`);
        }
        const homepage = /^https?:\/\//i.test(entry.homepage ?? '') ? entry.homepage : undefined;
        components.push({
          kind: 'npm',
          name: entry.name,
          version,
          license_declared: license,
          license_evidence:
            license !== UNKNOWN ? 'package_metadata' : text.found ? 'license_file' : 'not_found',
          license_text: text,
          distributed_in: sortedUnique(artifacts, ARTIFACTS),
          ...(homepage ? { homepage } : {}),
          ...(note.length ? { note: note.join(' ') } : {}),
          attention: attentionFor({
            licenseDeclared: license,
            textFound: text.found,
            version,
            declaredByHand: false,
            name: entry.name,
          }),
        });
      });
    }
  }
  if (components.length === 0) {
    throw new Error('pnpm listed no third-party packages, which would read as nothing distributed');
  }
  return components;
}

/** One component per kind, name and version, with the artifacts that carry it joined. */
export function mergeComponents(lists) {
  const merged = new Map();
  for (const component of lists.flat()) {
    const key = JSON.stringify([component.kind, component.name, component.version]);
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, { ...component });
      continue;
    }
    // One published version has one license. If two readings disagree, something read wrongly, and
    // picking one would put a guess in front of counsel.
    if (seen.license_declared !== component.license_declared) {
      throw new Error(
        `${component.name} ${component.version} declares both ` +
          `"${seen.license_declared}" and "${component.license_declared}"`,
      );
    }
    seen.distributed_in = sortedUnique(
      [...seen.distributed_in, ...component.distributed_in],
      ARTIFACTS,
    );
    if (!seen.license_text.found && component.license_text.found) {
      seen.license_text = component.license_text;
      seen.license_evidence = component.license_evidence;
    }
    seen.attention = sortedUnique([...seen.attention, ...component.attention], ATTENTION).filter(
      (flag) => flag !== 'license_text_not_found' || !seen.license_text.found,
    );
    if (component.note && !seen.note) seen.note = component.note;
    if (component.homepage && !seen.homepage) seen.homepage = component.homepage;
  }
  return [...merged.values()];
}

/** Read resolved service images, including inline mappings and inherited YAML anchors. */
export function composeImages(composeYamlText) {
  const document = parseDocument(composeYamlText, { merge: true, uniqueKeys: true });
  if (document.errors.length)
    throw new Error(`invalid Compose YAML: ${document.errors[0].message}`);
  const compose = document.toJS({ maxAliasCount: 100 });
  if (compose == null) return [];
  if (typeof compose !== 'object' || Array.isArray(compose))
    throw new Error('Compose must be a mapping');
  const services = compose.services;
  if (services == null) return [];
  if (typeof services !== 'object' || Array.isArray(services))
    throw new Error('services must be a mapping');
  return Object.entries(services).flatMap(([service, definition]) => {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new Error(`service ${service} must be a mapping`);
    }
    if (definition.image === undefined) return [];
    if (typeof definition.image !== 'string' || !definition.image.trim()) {
      throw new Error(`service ${service} image must be a nonempty string`);
    }
    return [{ image: definition.image, service }];
  });
}

/** The image a Dockerfile's final stage starts from, which is the one that ships. */
export function dockerfileBaseImage(dockerfileText) {
  const stages = [];
  for (const line of dockerfileText.split(/\r?\n/)) {
    const from = line.match(/^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) stages.push({ image: from[1], alias: from[2]?.toLowerCase() });
  }
  if (stages.length === 0) throw new Error('this Dockerfile has no FROM line');
  let { image } = stages.at(-1);
  // `FROM build` continues an earlier stage, so what ships is what that stage started from.
  for (const stage of [...stages].reverse()) {
    if (stage.alias && stage.alias === image.toLowerCase()) image = stage.image;
  }
  return image;
}

/** Images in a test overlay that the shipped file does not use. They are test tools, and do not ship. */
export function testOnlyImages(testComposeText, shippedImages) {
  const shipped = new Set(shippedImages.map(({ image }) => image));
  return sortedUnique(
    composeImages(testComposeText)
      .map(({ image }) => image)
      .filter((image) => !shipped.has(image)),
  );
}

function splitImage(reference) {
  const [named, digest] = reference.split('@');
  const slash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  const name = colon > slash ? named.slice(0, colon) : named;
  const tag = colon > slash ? named.slice(colon + 1) : undefined;
  return { name, tag, digest };
}

/**
 * Third-party images as components. Each must be declared by hand for its exact digest, because a
 * project can change license between versions, so moving a digest means looking again. One with no
 * declaration still becomes a component, so the inventory shows the gap instead of a shorter list.
 */
export function imageComponents(images, declarations) {
  const problems = [];
  const declared = new Map();
  for (const declaration of declarations) {
    if (declared.has(declaration.image)) {
      problems.push(`${declaration.image} is declared twice in components.json`);
    }
    declared.set(declaration.image, declaration);
  }

  // These two interpolation points select our own built artifacts; their third-party bases are
  // inventoried from the Dockerfiles below. The release gate separately verifies selected images.
  const firstParty = (image) =>
    image.startsWith('ensemus/') ||
    image === '${ENSEMUS_WEB_IMAGE:-ensemus/web:local}' ||
    image === '${ENSEMUS_WORKER_IMAGE:-ensemus/worker:local}';
  const thirdParty = images.filter(({ image }) => !firstParty(image));
  const used = new Map();
  for (const entry of thirdParty) {
    const usage = used.get(entry.image) ?? { services: [], artifacts: [] };
    usage.services.push(entry.service);
    usage.artifacts.push(...(entry.distributedIn ?? ['third_party_image']));
    used.set(entry.image, usage);
  }

  const components = [];
  for (const [image, usage] of used) {
    const { name, tag, digest } = splitImage(image);
    const declaration = declared.get(image);
    const version = digest ? (tag ? `${tag}@${digest}` : digest) : UNKNOWN;
    const services = `Used by: ${sortedUnique(usage.services).join(', ')}.`;
    const license = declaredLicense(declaration?.license);

    if (!digest) problems.push(notPinned(name));
    if (!declaration) {
      problems.push(notDeclared(name));
    } else {
      if (declaration.evidence !== HAND_EVIDENCE) {
        problems.push(`${name}: a hand declaration must give evidence ${HAND_EVIDENCE}`);
      }
      if (!declaration.note) problems.push(`${name}: a hand declaration must have a note`);
    }

    components.push({
      kind: 'container_image',
      name,
      version,
      license_declared: license,
      license_evidence: declaration ? HAND_EVIDENCE : 'not_found',
      license_text: { found: false },
      distributed_in: sortedUnique(usage.artifacts, ARTIFACTS),
      ...(declaration?.homepage ? { homepage: declaration.homepage } : {}),
      note: [declaration?.note, digest ? '' : `Reference has no digest: ${image}.`, services]
        .filter(Boolean)
        .join(' '),
      attention: attentionFor({
        licenseDeclared: license,
        textFound: false,
        version,
        declaredByHand: Boolean(declaration),
        name,
      }),
    });
  }

  for (const image of declared.keys()) {
    if (!used.has(image)) {
      problems.push(`components.json declares ${image}, which nothing distributed uses`);
    }
  }
  return { components, problems };
}

const notDeclared = (name) =>
  `container image ${name} has no declaration in infrastructure/licenses/components.json for this digest`;
const notPinned = (name) => `container image ${name} is not pinned by digest`;

/**
 * A section typed into components.json, for what has no file to read yet: model weights and anything
 * else. Components can be added once the owner decides them, and they are always marked as typed.
 */
export function declaredSection(declaration, kind, source) {
  if (!declaration) throw new Error(`components.json has no entry for the ${kind} section`);
  const entries = declaration.components ?? [];
  const components = entries.map((entry) => {
    const license = declaredLicense(entry.license);
    const version = entry.version ?? UNKNOWN;
    return {
      kind,
      name: entry.name,
      version,
      license_declared: license,
      license_evidence: HAND_EVIDENCE,
      license_text: { found: false },
      distributed_in: sortedUnique(entry.distributed_in ?? [], ARTIFACTS),
      ...(entry.note ? { note: entry.note } : {}),
      attention: attentionFor({
        licenseDeclared: license,
        textFound: false,
        version,
        declaredByHand: true,
        name: entry.name,
      }),
    };
  });
  return {
    section: {
      state: declaration.state,
      source,
      ...(declaration.reason ? { reason: declaration.reason } : {}),
    },
    components,
  };
}

/** Attaches a typed fact to the npm packages it is about, such as an image build deleting them. */
export function withNotes(components, notes) {
  return components.map((component) => {
    const matching = notes.filter(({ prefix }) => component.name.startsWith(prefix));
    if (matching.length === 0) return component;
    const note = [component.note, ...matching.map((entry) => entry.note)].filter(Boolean);
    return { ...component, note: note.join(' ') };
  });
}

const OS_PURL = /^pkg:(deb|apk|rpm|alpm)\//;
const purlOf = (entry) =>
  (entry.externalRefs ?? []).find((ref) => ref.referenceType === 'purl')?.referenceLocator ?? '';

function sbomPackages(spdxJson) {
  if (!Array.isArray(spdxJson?.packages)) throw new Error('this SBOM has no packages list');
  return spdxJson.packages;
}

/**
 * OS packages from an SPDX SBOM. It reads licenseDeclared and never licenseConcluded, because a
 * conclusion is the scanner's opinion, and this file holds what a component says about itself. An SBOM
 * carries no license text, so each one says so.
 */
export function sbomComponents(spdxJson, distributedIn) {
  return sbomPackages(spdxJson)
    .filter((entry) => OS_PURL.test(purlOf(entry)))
    .map((entry) => {
      const license = declaredLicense(entry.licenseDeclared);
      const version = entry.versionInfo || UNKNOWN;
      const homepage = /^https?:\/\//i.test(entry.homepage ?? '') ? entry.homepage : undefined;
      return {
        kind: 'os_package',
        name: entry.name,
        version,
        license_declared: license,
        license_evidence: license === UNKNOWN ? 'not_found' : 'sbom',
        license_text: { found: false },
        distributed_in: sortedUnique([distributedIn].flat(), ARTIFACTS),
        ...(homepage ? { homepage } : {}),
        attention: attentionFor({
          licenseDeclared: license,
          textFound: false,
          version,
          declaredByHand: false,
          name: entry.name,
        }),
      };
    });
}

/** What an SBOM holds besides OS packages, counted so the section can say what it did not list. */
export function sbomLeftOut(spdxJson) {
  const counts = {};
  for (const entry of sbomPackages(spdxJson)) {
    const purl = purlOf(entry);
    if (OS_PURL.test(purl)) continue;
    const type = purl.match(/^pkg:([^/]+)\//)?.[1] ?? 'no_package_url';
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Tracked files that look like a font, a model or vendored code. A section saying nothing of that
 * kind is distributed has to answer to these, so that it cannot go stale silently.
 */
export function filesNeedingAnEntry(trackedFiles) {
  return trackedFiles.filter(
    (file) =>
      !file.startsWith('tests/') &&
      (/\.(woff2?|ttf|otf|eot|onnx|safetensors|gguf|pt|ckpt)$/i.test(file) ||
        /(^|\/)(vendor|third_party)\//i.test(file)),
  );
}

/** The inventory, in its fixed shape. `review` is the constant, whatever anyone passes in. */
export function buildInventory({ release, sections, components }) {
  const ordered = components
    .map((component) => ({
      ...component,
      distributed_in: sortedUnique(component.distributed_in, ARTIFACTS),
      attention: sortedUnique(component.attention, ATTENTION),
    }))
    .sort(
      (a, b) =>
        compare(KINDS.indexOf(a.kind), KINDS.indexOf(b.kind)) ||
        compare(a.name, b.name) ||
        compare(a.version, b.version),
    );
  const countOf = (name) =>
    ordered.filter((component) => SECTION_KINDS[name].includes(component.kind)).length;
  return {
    schema: 1,
    review: REVIEW,
    release: {
      commit: release.commit,
      dirty: release.dirty,
      ...(release.release ? { release: release.release } : {}),
    },
    sections: Object.fromEntries(
      Object.keys(SECTION_KINDS).map((name) => [name, { ...sections[name], count: countOf(name) }]),
    ),
    components: ordered,
  };
}

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

const URLS = /\b(?:git\+)?(?:https?|ssh|git):\/\/\S+/gi;
const ABSOLUTE_PATHS = [
  /(^|[\s"'(=,:])[A-Za-z]:[\\/]/,
  /\\\\[^\\\s]+\\/,
  /(^|[\s"'(=,:])\/[\w.@~-]+\//,
  /\bfile:\/\//i,
];

/** Strings in a value that hold an absolute path. A web address is not a path, and is not reported. */
export function absolutePathsIn(value) {
  return strings(value).filter((text) => {
    const withoutUrls = text.replace(URLS, ' ');
    return ABSOLUTE_PATHS.some((pattern) => pattern.test(withoutUrls));
  });
}

const slashed = (text) => text.replace(/\\+/g, '/').toLowerCase();

/** Whether a rendered output mentions a directory on this machine, in either kind of slash. */
export function mentionsDirectory(text, directory) {
  const needle = slashed(directory).replace(/\/+$/, '');
  // A home directory of `/` names nothing, and would match every file.
  return needle !== '' && slashed(text).includes(needle);
}

/** What --check refuses. The schema has a validator in the tests only, so the rules that matter are here too. */
export function checkProblems(inventory) {
  const problems = [];
  if (inventory?.schema !== 1) problems.push('schema must be 1');
  if (inventory?.review !== REVIEW) problems.push(`review must be the constant ${REVIEW}`);
  if (!/^[0-9a-f]{40}$/.test(inventory?.release?.commit ?? '')) {
    problems.push('release.commit is not a full commit hash');
  }
  if (typeof inventory?.release?.dirty !== 'boolean') problems.push('release.dirty is not stated');

  const components = Array.isArray(inventory?.components) ? inventory.components : [];
  if (!Array.isArray(inventory?.components)) problems.push('components is not a list');

  for (const [name, kinds] of Object.entries(SECTION_KINDS)) {
    const section = inventory?.sections?.[name];
    if (!section) {
      problems.push(`section ${name} is missing`);
      continue;
    }
    if (!SECTION_STATES.includes(section.state)) {
      problems.push(`section ${name} has an unknown state: ${section.state}`);
    }
    if (!section.source) problems.push(`section ${name} does not say where it came from`);
    const real = components.filter((component) => kinds.includes(component.kind)).length;
    if (section.count !== real) {
      problems.push(`section ${name} says ${section.count} components, and lists ${real}`);
    }
    const absent = section.state === 'not_collected' || section.state === 'none_distributed';
    if (absent && !section.reason)
      problems.push(`section ${name} is ${section.state} with no reason`);
    if (absent && (section.count !== 0 || real !== 0)) {
      problems.push(`section ${name} is ${section.state}, with a non-zero count`);
    }
    if (!absent && real === 0) {
      problems.push(`section ${name} is ${section.state}, and lists nothing`);
    }
  }
  // Everything shipped depends on npm packages, so an empty section means the collection failed.
  if (inventory?.sections?.npm && inventory.sections.npm.state !== 'collected') {
    problems.push('section npm must be collected');
  }

  const seen = new Set();
  for (const component of components) {
    const label = `${component.kind} ${component.name} ${component.version}`;
    const key = JSON.stringify([component.kind, component.name, component.version]);
    if (seen.has(key)) problems.push(`${label} is listed twice`);
    seen.add(key);
    problems.push(...componentProblems(component, label));
  }

  for (const text of absolutePathsIn(inventory)) {
    problems.push(`an absolute path reached the inventory: ${text}`);
  }
  return problems;
}

function componentProblems(component, label) {
  const problems = [];
  if (!KINDS.includes(component.kind)) problems.push(`${label}: unknown kind`);
  if (!EVIDENCE.includes(component.license_evidence)) problems.push(`${label}: unknown evidence`);
  if (!component.name || !component.version || !component.license_declared) {
    problems.push(`${label}: name, version and license_declared are all required`);
  }
  const artifacts = component.distributed_in ?? [];
  if (artifacts.length === 0 || artifacts.some((artifact) => !ARTIFACTS.includes(artifact))) {
    problems.push(`${label}: distributed_in must name real artifacts`);
  }
  const attention = component.attention ?? [];
  const strange = attention.filter((flag) => !ATTENTION.includes(flag));
  if (strange.length) problems.push(`${label}: unknown attention ${strange.join(', ')}`);

  // Flags are recomputed, because a component without the flag it should have reads as clean.
  const textFound = Boolean(component.license_text?.found);
  const missing = attentionFor({
    licenseDeclared: component.license_declared,
    textFound,
    version: component.version,
    declaredByHand: component.license_evidence === HAND_EVIDENCE,
    name: component.name,
  }).filter((flag) => !attention.includes(flag));
  if (missing.length) problems.push(`${label}: attention is missing ${missing.join(', ')}`);

  if (textFound && !SHA256.test(component.license_text.sha256 ?? '')) {
    problems.push(`${label}: a found license text needs its sha256`);
  }
  if (textFound && !component.license_text.file) problems.push(`${label}: license file not named`);
  if (/(^|[\\/])\.\.([\\/]|$)/.test(component.license_text?.file ?? '')) {
    problems.push(`${label}: license file is outside the package`);
  }

  if (component.kind === 'container_image') {
    if (component.license_evidence === 'not_found') problems.push(notDeclared(component.name));
    if (!/(^|@)sha256:[0-9a-f]{64}$/.test(component.version)) {
      problems.push(notPinned(component.name));
    }
    if (component.name.startsWith('ensemus/')) {
      problems.push(`${component.name} is our own image, and is not a third-party component`);
    }
  }
  if (component.kind === 'npm' && String(component.name).startsWith('@ensemus/')) {
    problems.push(`${component.name} is our own package, and is not a third-party component`);
  }
  return problems;
}

// A cell a spreadsheet would run as a formula. These values come from third-party packages, and
// counsel will open this file in a spreadsheet, so a leading quote keeps each one as text. That is the
// one place a value is not word for word: license-inventory.json stays the record.
const asCell = (value) => {
  const text = value === undefined || value === null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const CSV_COLUMNS = [
  'review',
  'kind',
  'name',
  'version',
  'license_declared',
  'license_evidence',
  'license_text_found',
  'license_text_file',
  'license_text_sha256',
  'distributed_in',
  'attention',
  'homepage',
  'note',
];

/**
 * The inventory as a table. Sections come first as rows of their own, and each row carries the review
 * state: a filtered or copied table must still say what was not collected, and that it is a draft.
 */
export function renderCsv(inventory) {
  const row = (cells) => cells.map(asCell).join(',');
  const sections = Object.entries(inventory.sections).map(([name, section]) =>
    row([
      inventory.review,
      'section',
      name,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      `${section.state}: ${section.count} from ${section.source}.${section.reason ? ` ${section.reason}` : ''}`,
    ]),
  );
  const components = inventory.components.map((component) =>
    row([
      inventory.review,
      component.kind,
      component.name,
      component.version,
      component.license_declared,
      component.license_evidence,
      component.license_text.found,
      component.license_text.file,
      component.license_text.sha256,
      component.distributed_in.join(' '),
      component.attention.join(' '),
      component.homepage,
      component.note,
    ]),
  );
  return `${[CSV_COLUMNS.join(','), ...sections, ...components].join('\r\n')}\r\n`;
}

/** A code fence longer than any run of backticks in the text, so a license cannot close it early. */
function fenced(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text.replace(/\s+$/, '')}\n${fence}`;
}

/** Draft notices. The first line says what this is, because a notices file is made to be passed on. */
export function renderNotices(inventory, licenseTexts) {
  const lines = [
    `DRAFT (${REVIEW}): counsel has not reviewed this file, and it must not ship in a release as it stands.`,
    '',
    '# Third-party notices (draft)',
    '',
    `Written from commit ${inventory.release.commit}${inventory.release.dirty ? ', with uncommitted changes' : ''}. It lists what each component declares. It holds no legal conclusion.`,
    '',
    '## What this list covers',
    '',
  ];
  for (const [name, section] of Object.entries(inventory.sections)) {
    const why = section.reason ? ` ${section.reason}` : '';
    lines.push(`- **${name}**: ${section.state}, ${section.count}, from ${section.source}.${why}`);
  }
  lines.push('', '## Components', '');
  for (const component of inventory.components) {
    lines.push(`### ${component.name} ${component.version}`, '');
    lines.push(`- Kind: ${component.kind}`);
    lines.push(`- License declared: ${component.license_declared}`);
    lines.push(`- Evidence: ${component.license_evidence}`);
    lines.push(`- Distributed in: ${component.distributed_in.join(', ')}`);
    if (component.homepage) lines.push(`- Homepage: ${component.homepage}`);
    if (component.note) lines.push(`- Note: ${component.note}`);
    if (component.attention.length) lines.push(`- Attention: ${component.attention.join(', ')}`);
    lines.push(
      component.license_text.found
        ? `- License text: ${component.license_text.file}, sha256 ${component.license_text.sha256}`
        : '- License text: not found',
      '',
    );
  }

  const texts = Object.entries(licenseTexts).sort(([a], [b]) => compare(a, b));
  lines.push('## License texts', '');
  if (texts.length === 0) lines.push('No license text was read.', '');
  for (const [sha256, text] of texts) {
    lines.push(`### sha256 ${sha256}`, '', fenced(text), '');
  }
  return lines.join('\n');
}
