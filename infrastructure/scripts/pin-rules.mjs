// What the pin check decides, apart from the files it walks, so that a unit test can show each rule
// failing. See tests/unit/pin-rules.test.ts. Each function answers a list of problems, each naming the
// file and the reference, and an empty list only ever means it looked and found nothing wrong.
//
// There is no YAML library, because these scripts run on plain Node. So the YAML rules read lines. Where
// they cannot tell, they refuse: a false alarm is a nuisance that someone fixes, and a miss is a hole.
import { isBuiltin } from 'node:module';

const PINNED = /^[^\s@$]+@sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** An image built here has no digest until it is built, so its name is all there is to check. */
const BUILT_HERE = /^ensemus\/[a-z0-9][a-z0-9._-]*:local$/;

const isPinned = (reference) => PINNED.test(reference);
const lines = (text) => text.split(/\r?\n/);

/** A YAML comment starts at a # outside quotes, at the start of a line or after a space. */
function withoutYamlComment(line) {
  let quote = null;
  for (let at = 0; at < line.length; at += 1) {
    const character = line[at];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '#' && (at === 0 || /\s/.test(line[at - 1]))) {
      return line.slice(0, at);
    }
  }
  return line;
}

const unquoted = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

// Dockerfile

/** One entry per instruction, with continued lines joined and comments gone, as Docker reads them. */
function dockerInstructions(text) {
  let escape = '\\';
  const instructions = [];
  let current = '';
  let inDirectives = true;
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (inDirectives) {
      const directive = /^#\s*escape\s*=\s*(\S)\s*$/i.exec(line);
      if (directive) {
        escape = directive[1];
        continue;
      }
      if (!/^#\s*\w+\s*=/.test(line)) inDirectives = false;
    }
    // A comment or blank line inside a continued instruction is dropped, and the instruction goes on.
    if (line === '' || line.startsWith('#')) continue;
    if (line.endsWith(escape)) {
      current += `${line.slice(0, -1)} `;
      continue;
    }
    instructions.push(current + line);
    current = '';
  }
  if (current.trim()) instructions.push(current.trim());
  return instructions;
}

/**
 * A heredoc body is read as instructions too, so a line in one that starts with FROM is checked. That
 * can only cause a false alarm, and skipping heredocs could hide a real FROM behind a parsing mistake.
 */
export function dockerfileProblems(name, text) {
  const problems = [];
  const stages = new Set();
  let stageCount = 0;
  const isEarlierStage = (reference) => {
    if (/^\d+$/.test(reference)) return Number(reference) < stageCount - 1;
    return stages.has(reference.toLowerCase());
  };
  const checkSource = (instruction, reference) => {
    if (!isPinned(reference) && !isEarlierStage(reference)) {
      problems.push(`${name}: ${instruction} ${reference} has no @sha256 digest`);
    }
  };

  for (const instruction of dockerInstructions(text)) {
    const words = instruction.split(/\s+/);
    const keyword = words[0].toUpperCase();
    if (keyword === 'FROM') {
      const [reference, as, stage] = words.slice(1).filter((word) => !word.startsWith('--'));
      if (!reference) {
        problems.push(`${name}: a FROM names no image`);
      } else if (
        reference !== 'scratch' &&
        !isPinned(reference) &&
        !stages.has(reference.toLowerCase())
      ) {
        problems.push(
          `${name}: FROM ${reference} has no @sha256 digest and names no earlier stage`,
        );
      }
      stageCount += 1;
      if (as?.toUpperCase() === 'AS' && stage) stages.add(stage.toLowerCase());
    } else if (keyword === 'COPY') {
      for (const word of words) {
        const from = /^--from=(.+)$/.exec(word);
        if (from) checkSource('COPY --from', from[1]);
      }
    } else if (keyword === 'RUN') {
      for (const word of words) {
        if (!word.startsWith('--mount=')) continue;
        const from = /[=,]from=([^,]+)/.exec(word);
        if (from) checkSource('RUN --mount from', from[1]);
      }
    }
  }
  if (stageCount === 0) problems.push(`${name}: has no FROM, so nothing was checked`);
  return problems;
}

// Compose

const composeImageLine = /^(\s*)(?:-\s+)?image\s*:\s*(.*)$/;
const composeFlowImage = /[{,]\s*image\s*:\s*([^,}]*)/;

/** Whether the mapping holding the line at `at`, with this indent, also has a build key. */
function hasBuildBeside(all, at, indent) {
  for (const step of [-1, 1]) {
    for (let index = at + step; index >= 0 && index < all.length; index += step) {
      const line = all[index];
      if (line.trim() === '') continue;
      const own = /^\s*/.exec(line)[0].length;
      if (own < indent) break;
      if (own === indent && /^\s*build\s*:/.test(line)) return true;
    }
  }
  return false;
}

export function composeProblems(name, text) {
  const problems = [];
  const all = lines(text).map(withoutYamlComment);
  all.forEach((line, at) => {
    const block = composeImageLine.exec(line);
    const flow = block ? null : composeFlowImage.exec(line);
    if (!block && !flow) return;
    const image = unquoted(block ? block[2] : flow[1]);
    if (isPinned(image)) return;
    // Named only, with no build beside it, Compose would pull this name from a registry instead.
    const built = block ? hasBuildBeside(all, at, block[1].length) : /\bbuild\s*:/.test(line);
    if (BUILT_HERE.test(image) && built) return;
    problems.push(`${name}: image ${image || '(empty)'} has no @sha256 digest`);
  });
  return problems;
}

// Workflows

const workflowUses = /^\s*(?:-\s+)?uses\s*:\s*(.*)$/;
const workflowFlowUses = /[{,]\s*uses\s*:\s*([^,}]*)/;

function usesProblem(name, reference) {
  // An action in this repository is at the commit being run.
  if (reference.startsWith('./')) return null;
  if (reference.startsWith('docker://')) {
    return isPinned(reference.slice('docker://'.length))
      ? null
      : `${name}: uses ${reference} has no @sha256 digest`;
  }
  const at = reference.lastIndexOf('@');
  if (at > 0 && COMMIT.test(reference.slice(at + 1))) return null;
  return `${name}: uses ${reference} is not pinned to a 40-character commit`;
}

const FLAGS_WITH_A_VALUE = new Set(['--filter', '-F', '--dir', '-C']);

/** Whether these words are a pnpm install, wherever pnpm's own flags put the word "install". */
function isPnpmInstall(words) {
  const start = words.indexOf('pnpm');
  if (start < 0) return false;
  for (let at = start + 1; at < words.length; at += 1) {
    const word = words[at];
    if (FLAGS_WITH_A_VALUE.has(word)) at += 1;
    else if (!word.startsWith('-')) return word === 'install' || word === 'i';
  }
  return false;
}

function unfrozenInstalls(name, text) {
  const problems = [];
  const commands = lines(text)
    .filter((line) => !/^\s*(?:-\s+)?name\s*:/.test(line))
    .map(withoutYamlComment)
    .join('\n')
    .replace(/\\\n\s*/g, ' ');
  for (const line of commands.split('\n')) {
    // One command at a time, so that a flag on the next command cannot vouch for this one.
    for (const command of line.split(/&&|\|\||;|\|/)) {
      const words = command
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/^['"(]+|['")]+$/g, ''));
      if (isPnpmInstall(words) && !words.includes('--frozen-lockfile')) {
        problems.push(`${name}: "${command.trim()}" is not --frozen-lockfile`);
      }
    }
  }
  return problems;
}

export function workflowProblems(name, text) {
  const problems = [];
  for (const line of lines(text).map(withoutYamlComment)) {
    const found = workflowUses.exec(line) ?? workflowFlowUses.exec(line);
    if (!found) continue;
    const problem = usesProblem(name, unquoted(found[1]));
    if (problem) problems.push(problem);
  }
  return [...problems, ...unfrozenInstalls(name, text)];
}

// Manifests

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

export function manifestProblems(name, json) {
  if (json === null || typeof json !== 'object') return [`${name}: is not a JSON object`];
  const sections = [
    ...DEPENDENCY_SECTIONS.map((section) => [section, json[section]]),
    // An override replaces what the sections above say, so a range here is a range everywhere.
    ['overrides', json.overrides],
    ['pnpm.overrides', json.pnpm?.overrides],
    ['resolutions', json.resolutions],
  ];
  return sections.flatMap(([section, entries]) =>
    Object.entries(entries ?? {}).flatMap(([dependency, version]) =>
      version === 'workspace:*' || (typeof version === 'string' && EXACT_VERSION.test(version))
        ? []
        : [`${name}: ${section} ${dependency} is ${JSON.stringify(version)}, not an exact version`],
    ),
  );
}

// Scripts

/** Docker flags that take their value as the next word. Anything else is read as the image, and refused. */
const DOCKER_FLAGS_WITH_A_VALUE = new Set(
  (
    '--add-host --cap-add --cap-drop --cpus --dns --entrypoint --env --env-file --hostname --ipc ' +
    '--label --memory --mount --name --network --pid --platform --publish --pull --security-opt ' +
    '--tmpfs --user --volume --workdir -e -h -l -m -p -u -v -w'
  ).split(' '),
);
const DOCKER_RUNS_AN_IMAGE = new Set(['run', 'create', 'pull']);
const IMAGE_SHAPE =
  /^(?<name>[a-z0-9][a-z0-9._-]*(?::\d+\/[a-z0-9._-]+)?(?:\/[a-z0-9._-]+)*)(?::(?<tag>\w[\w.-]*))?(?<digest>@sha\d*:\S*)?$/;
/** Words that mean a floating tag, for a bare name whose tag has no digit in it. */
const FLOATING_TAGS = new Set(['latest', 'lts', 'stable', 'edge', 'current', 'slim', 'alpine']);

/**
 * Whether a string found anywhere in a script is an image reference. A bare `name:word` is more often
 * something else: a pnpm script, a host and port, an extra_hosts pin, a node: import. Where docker runs
 * it, position decides instead, in dockerCommandImages.
 */
function looksLikeImage(value) {
  if (!value.includes(':') && !value.includes('@')) return false;
  const shape = IMAGE_SHAPE.exec(value);
  if (!shape) return false;
  const { name, tag, digest } = shape.groups;
  if (digest) return true;
  if (!tag) return false;
  if (name === 'node' && isBuiltin(`node:${tag}`)) return false;
  if (name.includes('/')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tag)) return false;
  if (/^\d{4,5}$/.test(tag)) return false;
  return /\d/.test(tag) || FLOATING_TAGS.has(tag);
}

/** The strings in a line of script, and what a shell script assigns with no quotes. */
function stringsIn(line, isShell) {
  const found = [...line.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
  if (!isShell) return found;
  const words = [...line.matchAll(/(?:^|\s)[A-Za-z_]\w*=([^\s'"]+)/g)].map((match) => match[1]);
  return [...found, ...words];
}

/** The word in the image's place, walking past docker's own flags. */
function imageAfterFlags(words) {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at];
    if (word.startsWith('...')) continue;
    const bare = word.replace(/^['"`]|['"`]$/g, '');
    if (DOCKER_FLAGS_WITH_A_VALUE.has(bare)) at += 1;
    else if (!bare.startsWith('-')) return word;
  }
  return null;
}

/** The items of the array literal opening at `open`, split on the commas at its own depth. */
function arrayItems(text, open) {
  const items = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let at = open; at < text.length; at += 1) {
    const character = text[at];
    if (quote) {
      if (character === quote) quote = null;
      current += character;
    } else if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
    } else if ('[({'.includes(character)) {
      depth += 1;
      if (depth > 1) current += character;
    } else if ('])}'.includes(character)) {
      depth -= 1;
      if (depth === 0) break;
      current += character;
    } else if (character === ',' && depth === 1) {
      items.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

const isPlainString = (word) => /^(['"]).*\1$|^`[^$]*`$/.test(word);
const stringValue = (word) => word.slice(1, -1);

/** Every image named where docker would run it, written as a shell command or as an argument array. */
function dockerCommandImages(text) {
  const images = [];
  for (const line of lines(text)) {
    for (const match of line.matchAll(/\bdocker\s+(?:container\s+)?(?:run|create|pull)\s+([^\n`'"]*)/g)) {
      const word = imageAfterFlags(match[1].trim().split(/\s+/));
      if (word && !word.startsWith('$') && word !== '\\') images.push(word);
    }
  }
  const constants = new Map(
    [...text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\n]*)\2/g)].map((match) => [
      match[1],
      match[3],
    ]),
  );
  for (const call of text.matchAll(/['"]docker['"]\s*,\s*\[/g)) {
    const items = arrayItems(text, call.index + call[0].length - 1);
    const [first, second] = items;
    const start = first === "'container'" || first === '"container"' ? 1 : 0;
    const command = start === 1 ? second : first;
    if (!command || !isPlainString(command) || !DOCKER_RUNS_AN_IMAGE.has(stringValue(command))) {
      continue;
    }
    const word = imageAfterFlags(items.slice(start + 1));
    if (!word) continue;
    if (isPlainString(word)) images.push(stringValue(word));
    else if (constants.has(word)) images.push(constants.get(word));
    // Anything else is decided at run time: a member of tool-images.mjs, or what Compose resolved.
  }
  return images;
}

const isComment = (line) => /^\s*(?:\/\/|#|\*|\/\*)/.test(line);

export function scriptImageProblems(name, text) {
  const isShell = name.endsWith('.sh');
  const code = lines(text)
    .filter((line) => !isComment(line))
    .join('\n');
  const found = new Set(dockerCommandImages(code));
  for (const line of lines(code)) {
    for (const value of stringsIn(line, isShell)) {
      if (looksLikeImage(value)) found.add(value);
    }
  }
  return [...found]
    .filter((image) => !isPinned(image) && !BUILT_HERE.test(image))
    .map(
      (image) =>
        `${name}: image ${image} has no @sha256 digest, is not a built ensemus/*:local, and does not come from tool-images.mjs`,
    );
}

// Tool images

export function toolImageProblems(images) {
  const entries = Object.entries(images ?? {});
  if (entries.length === 0) return ['tool-images.mjs: lists no images, so nothing was checked'];
  return entries.flatMap(([tool, entry]) => {
    const image = entry?.image;
    if (typeof image !== 'string') return [`tool-images.mjs: ${tool} names no image`];
    return isPinned(image) ? [] : [`tool-images.mjs: ${tool} ${image} has no @sha256 digest`];
  });
}

// Version files

/** Corepack checks the download against this hash, so its length is the algorithm's and nothing less. */
const PACKAGE_MANAGER =
  /^[a-z][a-z0-9-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+(?:sha512\.[0-9a-f]{128}|sha256\.[0-9a-f]{64})$/;

export function versionFileProblems({ nvmrc, packageManager }) {
  const problems = [];
  if (typeof nvmrc !== 'string' || !/^\d+\.\d+\.\d+$/.test(nvmrc.trim())) {
    problems.push(`.nvmrc: ${JSON.stringify(nvmrc?.trim())} is not an exact x.y.z version`);
  }
  if (typeof packageManager !== 'string' || !PACKAGE_MANAGER.test(packageManager)) {
    problems.push(
      `package.json: packageManager ${JSON.stringify(packageManager)} carries no +sha512. or +sha256. hash`,
    );
  }
  return problems;
}
