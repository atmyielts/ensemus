// LEGAL-05: what the license inventory decides. All three outputs go to counsel, so what matters here
// is that a short list cannot read as a complete one, that nothing reads as reviewed, and that a path
// on the machine that ran it reaches none of them. ADR-036 D7.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  absolutePathsIn,
  ARTIFACTS,
  ATTENTION,
  attentionFor,
  buildInventory,
  checkProblems,
  composeImages,
  declaredLicense,
  declaredSection,
  dockerfileBaseImage,
  EVIDENCE,
  filesNeedingAnEntry,
  HAND_EVIDENCE,
  imageComponents,
  KINDS,
  mentionsDirectory,
  mergeComponents,
  npmComponents,
  renderCsv,
  renderNotices,
  REVIEW,
  REVIEWED_EXCEPTIONS,
  sbomComponents,
  sbomLeftOut,
  SECTION_STATES,
  testOnlyImages,
  withNotes,
} from '../../infrastructure/scripts/license-rules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtures = join(root, 'tests', 'unit', 'fixtures', 'licenses');
const fixtureText = (name: string) => readFileSync(join(fixtures, name), 'utf8');
const fixtureJson = (name: string) => JSON.parse(fixtureText(name));
const repoText = (...path: string[]) => readFileSync(join(root, ...path), 'utf8');

const USER_NAME = 'Fixture.Person';
const schema = JSON.parse(repoText('infrastructure', 'licenses', 'inventory.schema.json'));
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const DIGEST = `sha256:${'1'.repeat(64)}`;
const TOOLS_DIGEST = `sha256:${'2'.repeat(64)}`;

const flagsOf = (licenseDeclared: unknown) =>
  attentionFor({ licenseDeclared, textFound: true, version: '1.0.0', declaredByHand: false });

// Every package has a text unless the fixture path says otherwise, so a flag is the case under test.
const textFor = (directory: string) =>
  directory.includes('shared-lib')
    ? { found: true, file: join(directory, 'LICENSE'), sha256: SHA }
    : { found: false };
const webComponents = () =>
  npmComponents(fixtureJson('pnpm-web.json'), {
    distributedIn: 'web_image',
    licenseTextOf: textFor,
  });
const workerComponents = () =>
  npmComponents(fixtureJson('pnpm-worker.json'), {
    distributedIn: 'worker_image',
    licenseTextOf: textFor,
  });
const named = (components: Array<{ name: string; version: string }>, name: string) =>
  components.filter((component) => component.name === name);

const DECLARATIONS = [
  {
    image: `fixture/proxy:2-alpine@${DIGEST}`,
    license: 'Apache-2.0',
    evidence: HAND_EVIDENCE,
    homepage: 'https://example.invalid/proxy',
    note: 'Read from a generated upstream.',
  },
  {
    image: `fixture/tools@${TOOLS_DIGEST}`,
    license: 'unknown',
    evidence: HAND_EVIDENCE,
    note: 'The upstream publishes no license we could read.',
  },
];

const SECTIONS = {
  npm: { state: 'collected', source: 'a generated listing' },
  container_images: { state: 'declared_by_hand', source: 'a generated declaration' },
  os_packages: { state: 'not_collected', source: 'SBOMs', reason: 'No SBOM was given.' },
  model_weights: { state: 'none_distributed', source: 'a declaration', reason: 'Owner decision.' },
  other: { state: 'none_distributed', source: 'a declaration', reason: 'Nothing else ships.' },
};

function goodInventory() {
  const { components } = imageComponents(composeImages(fixtureText('compose.yaml')), DECLARATIONS);
  return buildInventory({
    release: { commit: COMMIT, dirty: false },
    sections: SECTIONS,
    components: [...mergeComponents([webComponents(), workerComponents()]), ...components],
  });
}

describe('attentionFor', () => {
  it.each([
    ['Unknown'],
    ['unknown'],
    [''],
    ['   '],
    ['NOASSERTION'],
    ['NONE'],
    [undefined],
    [null],
  ])('reads %j as declaring nothing', (license) => {
    expect(flagsOf(license)).toContain('no_license_declared');
    expect(declaredLicense(license)).toBe('unknown');
  });

  it.each([['UNLICENSED'], ['SEE LICENSE IN LICENSE.md'], ['Custom: https://example.invalid']])(
    'keeps %j word for word, and flags that it names no license',
    (license) => {
      expect(declaredLicense(license)).toBe(license);
      expect(flagsOf(license)).toContain('no_license_declared');
    },
  );

  it('never reads the Unlicense as declaring nothing', () => {
    expect(flagsOf('Unlicense')).toEqual([]);
  });

  it('never replaces unknown with a guess, even when a license file exists', () => {
    const [component] = named(
      npmComponents(
        { Unknown: [{ name: 'quiet', versions: ['1.0.0'], paths: ['quiet'], license: 'Unknown' }] },
        {
          distributedIn: 'web_image',
          licenseTextOf: () => ({ found: true, file: 'LICENSE', sha256: SHA }),
        },
      ),
      'quiet',
    ) as Array<{ license_declared: string; license_evidence: string; attention: string[] }>;
    expect(component?.license_declared).toBe('unknown');
    expect(component?.license_evidence).toBe('license_file');
    expect(component?.attention).toContain('no_license_declared');
  });

  it('flags a missing text and a missing version', () => {
    const flags = attentionFor({
      licenseDeclared: 'MIT',
      textFound: false,
      version: 'unknown',
      declaredByHand: false,
    });
    expect(flags).toEqual(['license_text_not_found', 'version_unknown']);
  });

  it('flags what was typed by hand', () => {
    expect(
      attentionFor({ licenseDeclared: 'MIT', textFound: true, version: '1', declaredByHand: true }),
    ).toEqual(['declared_by_hand_not_read_from_artifact']);
  });

  it.each([
    ['LGPL-3.0-or-later'],
    ['LGPL-2.1'],
    ['GPL-2.0-only'],
    ['GPL-3.0+'],
    ['AGPL-3.0'],
    ['MPL-2.0'],
    ['EPL-2.0'],
    ['CDDL-1.0'],
    ['EUPL-1.2'],
    ['GNU General Public License v3'],
    ['Mozilla Public License 2.0'],
  ])('gives %s copyleft_family', (license) => {
    expect(flagsOf(license)).toContain('copyleft_family');
  });

  it.each([['SSPL-1.0'], ['BUSL-1.1'], ['Elastic-2.0'], ['Business Source License 1.1']])(
    'gives %s source_available_not_open_source',
    (license) => {
      expect(flagsOf(license)).toContain('source_available_not_open_source');
    },
  );

  it('does not take the Boost license for Business Source', () => {
    expect(flagsOf('BSL-1.0')).not.toContain('source_available_not_open_source');
  });

  it.each([['CC-BY-4.0'], ['CC-BY-3.0'], ['Creative Commons Attribution 4.0']])(
    'gives %s attribution_family',
    (license) => {
      expect(flagsOf(license)).toContain('attribution_family');
    },
  );

  it('gives a share-alike license both families', () => {
    expect(flagsOf('CC-BY-SA-4.0')).toEqual(
      expect.arrayContaining(['attribution_family', 'copyleft_family']),
    );
  });

  it.each([['MIT OR Apache-2.0'], ['(MIT OR CC0-1.0)'], ['MIT or Apache-2.0']])(
    'gives %s dual_or_choice_of_license',
    (license) => {
      expect(flagsOf(license)).toContain('dual_or_choice_of_license');
    },
  );

  it('does not read "or later" as a choice of licenses', () => {
    expect(flagsOf('GPL-2.0-or-later')).not.toContain('dual_or_choice_of_license');
    expect(flagsOf('GPL-2.0 or later')).not.toContain('dual_or_choice_of_license');
  });

  it('does not read (MIT AND LGPL-3.0) as permissive', () => {
    const flags = flagsOf('(MIT AND LGPL-3.0)');
    expect(flags).toContain('copyleft_family');
    expect(flags).toContain('several_licenses_named');
  });

  it('does not read a copyleft choice as permissive either', () => {
    expect(flagsOf('MIT OR GPL-3.0')).toEqual(
      expect.arrayContaining(['dual_or_choice_of_license', 'copyleft_family']),
    );
  });

  it('flags the licenses check-licenses treats as exceptions', () => {
    for (const license of REVIEWED_EXCEPTIONS) {
      expect(flagsOf(license)).toContain('has_reviewed_exception_in_check_licenses');
    }
    expect(flagsOf('MIT')).not.toContain('has_reviewed_exception_in_check_licenses');
  });

  it('gives Unknown that exception only for the one package check-licenses names', () => {
    const flags = (name: string) =>
      attentionFor({
        licenseDeclared: 'Unknown',
        textFound: true,
        version: '1',
        declaredByHand: false,
        name,
      });
    expect(flags('unionfs')).toContain('has_reviewed_exception_in_check_licenses');
    expect(flags('some-other-package')).not.toContain('has_reviewed_exception_in_check_licenses');
  });
});

describe('check-licenses.mjs stays the source of its exceptions', () => {
  const source = repoText('infrastructure', 'scripts', 'check-licenses.mjs');
  const block = source.slice(
    source.indexOf('const REVIEWED_EXCEPTIONS'),
    source.indexOf('};', source.indexOf('const REVIEWED_EXCEPTIONS')),
  );

  it('has every license this tool says it excepts', () => {
    for (const license of REVIEWED_EXCEPTIONS) {
      expect(block).toContain(license);
    }
  });

  it('excepts nothing this tool does not know about', () => {
    const keys = [...block.matchAll(/^\s*(?:'([^']+)'|(\w+)):/gm)].map((m) => m[1] ?? m[2]);
    expect(keys.filter((key) => key !== 'Unknown').sort()).toEqual([...REVIEWED_EXCEPTIONS].sort());
    // Named by its package, because it is an exception for that package alone.
    expect(keys).toContain('Unknown');
    expect(block).toContain('unionfs');
    expect(source).toContain("names !== 'unionfs'");
  });
});

describe('npmComponents', () => {
  it('makes one component per version', () => {
    expect(named(webComponents(), 'shared-lib').map((component) => component.version)).toEqual([
      '1.0.0',
      '2.0.0',
    ]);
  });

  it('flags a missing text', () => {
    const [component] = named(webComponents(), '@img/fixture-native') as Array<{
      attention: string[];
      license_text: { found: boolean };
    }>;
    expect(component?.license_text).toEqual({ found: false });
    expect(component?.attention).toContain('license_text_not_found');
  });

  it('keeps our own packages out', () => {
    expect(named(webComponents(), '@ensemus/fixture-first-party')).toEqual([]);
  });

  it('refuses an empty listing rather than making an empty inventory', () => {
    const options = { distributedIn: 'web_image', licenseTextOf: textFor };
    expect(() => npmComponents({}, options)).toThrow(/no third-party packages/);
    expect(() =>
      npmComponents(
        { Internal: [{ name: '@ensemus/only', versions: ['0.0.0'], paths: [] }] },
        options,
      ),
    ).toThrow(/no third-party packages/);
  });

  it.each([[null], [[]], ['No licenses found']])('refuses a listing of %j', (listing) => {
    expect(() =>
      npmComponents(listing, { distributedIn: 'web_image', licenseTextOf: textFor }),
    ).toThrow(/did not print/);
  });

  it('keeps only a file name, whatever the text finder returns', () => {
    const [component] = named(webComponents(), 'shared-lib') as Array<{
      license_text: { file: string };
    }>;
    expect(component?.license_text.file).toBe('LICENSE');
  });

  it('drops a homepage that is not a web address', () => {
    const [component] = named(webComponents(), 'no-metadata');
    expect(component).not.toHaveProperty('homepage');
  });

  it('does not count a text with no valid hash as found', () => {
    const [component] = npmComponents(
      { MIT: [{ name: 'odd', versions: ['1'], paths: ['odd'], license: 'MIT' }] },
      {
        distributedIn: 'web_image',
        licenseTextOf: () => ({ found: true, file: 'LICENSE', sha256: 'not-a-hash' }),
      },
    ) as Array<{ license_text: { found: boolean }; attention: string[] }>;
    expect(component?.license_text.found).toBe(false);
    expect(component?.attention).toContain('license_text_not_found');
  });
});

describe('mergeComponents', () => {
  it('joins the artifacts of one name and version', () => {
    const merged = mergeComponents([webComponents(), workerComponents()]) as Array<{
      name: string;
      version: string;
      distributed_in: string[];
    }>;
    const distributedIn = (version: string) =>
      merged.find((c) => c.name === 'shared-lib' && c.version === version)?.distributed_in;
    expect(distributedIn('1.0.0')).toEqual(['web_image']);
    expect(distributedIn('2.0.0')).toEqual(['web_image', 'worker_image']);
  });

  it('does not join the same name across kinds', () => {
    const one = (kind: string) => ({
      kind,
      name: 'tar',
      version: '1',
      license_declared: 'MIT',
      license_evidence: 'sbom',
      license_text: { found: false },
      distributed_in: ['web_image'],
      attention: ['license_text_not_found'],
    });
    expect(mergeComponents([[one('npm')], [one('os_package')]])).toHaveLength(2);
  });

  it('prefers the reading that found a text, and drops the flag it no longer deserves', () => {
    const one = (found: boolean) => ({
      kind: 'npm',
      name: 'a',
      version: '1',
      license_declared: 'MIT',
      license_evidence: 'package_metadata',
      license_text: found ? { found, file: 'LICENSE', sha256: SHA } : { found },
      distributed_in: [found ? 'web_image' : 'worker_image'],
      attention: found ? [] : ['license_text_not_found'],
    });
    const [merged] = mergeComponents([[one(false)], [one(true)]]) as Array<{
      license_text: { found: boolean };
      attention: string[];
    }>;
    expect(merged?.license_text.found).toBe(true);
    expect(merged?.attention).toEqual([]);
  });

  it('refuses two readings of one version that disagree on its license', () => {
    const one = (license: string) => ({
      kind: 'npm',
      name: 'a',
      version: '1',
      license_declared: license,
      license_evidence: 'package_metadata',
      license_text: { found: false },
      distributed_in: ['web_image'],
      attention: [],
    });
    expect(() => mergeComponents([[one('MIT')], [one('GPL-3.0')]])).toThrow(/declares both/);
  });
});

describe('composeImages', () => {
  it('reads each service image, and nothing that only looks like one', () => {
    expect(composeImages(fixtureText('compose.yaml'))).toEqual([
      { image: `fixture/proxy:2-alpine@${DIGEST}`, service: 'proxy' },
      { image: 'ensemus/web:local', service: 'web' },
      { image: `fixture/tools@${TOOLS_DIGEST}`, service: 'tools-a' },
      { image: `fixture/tools@${TOOLS_DIGEST}`, service: 'tools-b' },
    ]);
  });

  it('reads the real compose.yaml the way a YAML parser does', () => {
    const text = repoText('infrastructure', 'compose', 'compose.yaml');
    const services = parseYaml(text, { merge: true }).services as Record<
      string,
      { image?: string }
    >;
    const expected = Object.entries(services).flatMap(([service, { image }]) =>
      image ? [{ image, service }] : [],
    );
    expect(composeImages(text)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('reads inline services and inherited image anchors', () => {
    expect(
      composeImages(
        'x-base: &base { image: "a/b:1" }\nservices:\n  inherited: { <<: *base }\n  override: { <<: *base, image: "a/c:2" }\n',
      ),
    ).toEqual([
      { image: 'a/b:1', service: 'inherited' },
      { image: 'a/c:2', service: 'override' },
    ]);
  });

  it('refuses malformed YAML, duplicate keys and non-string images', () => {
    for (const yaml of [
      'services: [',
      'services: { a: { image: x, image: y } }',
      'services: { a: { image: 1 } }',
    ]) {
      expect(() => composeImages(yaml)).toThrow();
    }
  });

  it('reads nothing from a file with no services', () => {
    expect(composeImages('')).toEqual([]);
  });
});

describe('dockerfileBaseImage', () => {
  it('reads the final stage, since the build stage does not ship', () => {
    expect(dockerfileBaseImage('FROM a:1 AS build\nRUN x\nFROM b:2\nCMD y\n')).toBe('b:2');
  });

  it('follows a final stage that continues an earlier one', () => {
    expect(dockerfileBaseImage('FROM a:1 AS base\nFROM --platform=linux/amd64 base\n')).toBe('a:1');
  });

  it('refuses a Dockerfile with no FROM', () => {
    expect(() => dockerfileBaseImage('RUN x\n')).toThrow(/no FROM/);
  });
});

describe('imageComponents', () => {
  const images = () => composeImages(fixtureText('compose.yaml'));

  it('leaves our own images out of the third-party list', () => {
    const { components, problems } = imageComponents(images(), DECLARATIONS);
    expect(problems).toEqual([]);
    expect(components.map((component: { name: string }) => component.name)).toEqual([
      'fixture/proxy',
      'fixture/tools',
    ]);
  });

  it('marks what was typed by hand, and joins services that share an image', () => {
    const { components } = imageComponents(images(), DECLARATIONS);
    const tools = components.find((c: { name: string }) => c.name === 'fixture/tools');
    expect(tools.license_declared).toBe('unknown');
    expect(tools.license_evidence).toBe(HAND_EVIDENCE);
    expect(tools.version).toBe(TOOLS_DIGEST);
    expect(tools.note).toContain('tools-a, tools-b');
    expect(tools.attention).toEqual(
      expect.arrayContaining([
        'no_license_declared',
        'license_text_not_found',
        'declared_by_hand_not_read_from_artifact',
      ]),
    );
  });

  it('reports an undeclared image, and still lists it', () => {
    const { components, problems } = imageComponents(images(), [DECLARATIONS[0]]);
    expect(problems.join()).toContain('fixture/tools has no declaration');
    const tools = components.find((c: { name: string }) => c.name === 'fixture/tools');
    expect(tools.license_declared).toBe('unknown');
    expect(tools.license_evidence).toBe('not_found');
  });

  it('treats a moved digest as undeclared, because a project can change license', () => {
    const moved = [{ image: `fixture/proxy:2-alpine@sha256:${'9'.repeat(64)}`, service: 'proxy' }];
    const { problems } = imageComponents(moved, DECLARATIONS.slice(0, 1));
    expect(problems.join()).toContain('fixture/proxy has no declaration');
    expect(problems.join()).toContain('which nothing distributed uses');
  });

  it('refuses an image with no digest', () => {
    const { components, problems } = imageComponents(
      [{ image: 'fixture/loose:latest', service: 'x' }],
      [{ image: 'fixture/loose:latest', license: 'MIT', evidence: HAND_EVIDENCE, note: 'n' }],
    );
    expect(problems.join()).toContain('not pinned by digest');
    expect(components[0].version).toBe('unknown');
    expect(components[0].attention).toContain('version_unknown');
  });

  it('refuses a declaration claiming better evidence than it has, or with no note', () => {
    const { problems } = imageComponents(
      [{ image: `fixture/proxy@${DIGEST}`, service: 'proxy' }],
      [{ image: `fixture/proxy@${DIGEST}`, license: 'MIT', evidence: 'license_file' }],
    );
    expect(problems.join()).toContain('must give evidence');
    expect(problems.join()).toContain('must have a note');
  });

  it('refuses the same image declared twice', () => {
    const { problems } = imageComponents(
      [{ image: DECLARATIONS[0]?.image, service: 'proxy' }],
      [DECLARATIONS[0], DECLARATIONS[0]],
    );
    expect(problems.join()).toContain('declared twice');
  });

  it('carries the artifacts a base image goes into', () => {
    const { components } = imageComponents(
      [
        {
          image: `fixture/base@${DIGEST}`,
          service: 'the final stage of Dockerfile.web',
          distributedIn: ['web_image'],
        },
        {
          image: `fixture/base@${DIGEST}`,
          service: 'the final stage of Dockerfile.worker',
          distributedIn: ['worker_image'],
        },
      ],
      [{ image: `fixture/base@${DIGEST}`, license: 'MIT', evidence: HAND_EVIDENCE, note: 'n' }],
    );
    expect(components[0].distributed_in).toEqual(['web_image', 'worker_image']);
  });
});

describe('testOnlyImages', () => {
  it('names what only the overlay uses, and not what also ships', () => {
    expect(
      testOnlyImages(fixtureText('compose.test.yaml'), composeImages(fixtureText('compose.yaml'))),
    ).toEqual([`fixture/test-sidecar@sha256:${'3'.repeat(64)}`]);
  });
});

describe('the real declarations', () => {
  const declared = JSON.parse(repoText('infrastructure', 'licenses', 'components.json'));
  const compose = composeImages(repoText('infrastructure', 'compose', 'compose.yaml'));
  const bases = ['Dockerfile.web', 'Dockerfile.worker'].map((file) => ({
    image: dockerfileBaseImage(repoText('infrastructure', 'containers', file)),
    service: file,
    distributedIn: [file === 'Dockerfile.web' ? 'web_image' : 'worker_image'],
  }));

  it('account for every image compose.yaml and the Dockerfiles use, and no other', () => {
    const { components, problems } = imageComponents([...compose, ...bases], declared.images);
    expect(problems).toEqual([]);
    expect(components.length).toBe(declared.images.length);
  });

  it('do not list a test tool, or one of our own images', () => {
    const test = testOnlyImages(repoText('infrastructure', 'compose', 'compose.test.yaml'), [
      ...compose,
      ...bases,
    ]);
    expect(test.length).toBeGreaterThan(0);
    const listed = declared.images.map((entry: { image: string }) => entry.image);
    for (const image of test) expect(listed).not.toContain(image);
    expect(listed.join()).not.toContain('ensemus/');
  });

  it('say no model weights are distributed, with why', () => {
    expect(declared.model_weights.state).toBe('none_distributed');
    expect(declared.model_weights.reason).toMatch(/owner decision/i);
  });
});

describe('declaredSection', () => {
  it('says why nothing is distributed', () => {
    const { section, components } = declaredSection(
      { state: 'none_distributed', reason: 'Owner decision.' },
      'model_weights',
      'a declaration',
    );
    expect(section).toEqual({
      state: 'none_distributed',
      source: 'a declaration',
      reason: 'Owner decision.',
    });
    expect(components).toEqual([]);
  });

  it('marks weights the owner has decided as typed by hand', () => {
    const { components } = declaredSection(
      {
        state: 'declared_by_hand',
        components: [
          { name: 'fixture-model', license: 'unknown', distributed_in: ['sovereign_bundle'] },
        ],
      },
      'model_weights',
      'a declaration',
    );
    expect(components[0].version).toBe('unknown');
    expect(components[0].attention).toEqual(
      expect.arrayContaining([
        'no_license_declared',
        'version_unknown',
        'declared_by_hand_not_read_from_artifact',
      ]),
    );
  });

  it('refuses a section nobody declared', () => {
    expect(() => declaredSection(undefined, 'other', 'a declaration')).toThrow(/no entry/);
  });
});

describe('withNotes', () => {
  it('adds a typed fact to the packages it is about, and leaves others alone', () => {
    const noted = withNotes(webComponents(), [{ prefix: '@img/', note: 'A generated fact.' }]);
    expect(named(noted, '@img/fixture-native')[0]).toHaveProperty('note', 'A generated fact.');
    expect(named(noted, 'shared-lib')[0]).not.toHaveProperty('note');
  });
});

describe('sbomComponents', () => {
  const spdx = fixtureJson('sbom.spdx.json');

  it('takes OS packages only, and counts what it left out', () => {
    const components = sbomComponents(spdx, 'web_image');
    expect(components.map((c: { name: string }) => c.name)).toEqual([
      'fixture-libc',
      'fixture-musl',
    ]);
    expect(components.every((c: { kind: string }) => c.kind === 'os_package')).toBe(true);
    expect(sbomLeftOut(spdx)).toEqual({ npm: 1, no_package_url: 1 });
  });

  it('reads what a package declares, never what the scanner concluded', () => {
    const [libc, musl] = sbomComponents(spdx, 'web_image');
    expect(libc.license_declared).toBe('GPL-2.0-only AND LGPL-2.1-only');
    expect(libc.license_evidence).toBe('sbom');
    expect(libc.attention).toEqual(
      expect.arrayContaining(['copyleft_family', 'several_licenses_named']),
    );
    expect(musl.license_declared).toBe('unknown');
    expect(musl.license_evidence).toBe('not_found');
    expect(musl.attention).toEqual(
      expect.arrayContaining(['no_license_declared', 'version_unknown']),
    );
  });

  it('says an SBOM carries no license text', () => {
    for (const component of sbomComponents(spdx, 'worker_image')) {
      expect(component.license_text).toEqual({ found: false });
      expect(component.attention).toContain('license_text_not_found');
    }
  });

  it('refuses a file that is not an SBOM', () => {
    expect(() => sbomComponents({}, 'web_image')).toThrow(/no packages/);
    expect(() => sbomLeftOut({})).toThrow(/no packages/);
  });
});

describe('filesNeedingAnEntry', () => {
  it('finds fonts, models and vendored code, outside tests', () => {
    expect(
      filesNeedingAnEntry([
        'apps/web/public/fonts/a.woff2',
        'models/embed.safetensors',
        'packages/x/vendor/y.js',
        'tests/fixtures/model.gguf',
        'apps/web/src/page.tsx',
      ]),
    ).toEqual([
      'apps/web/public/fonts/a.woff2',
      'models/embed.safetensors',
      'packages/x/vendor/y.js',
    ]);
  });
});

describe('buildInventory', () => {
  it('validates against the schema', () => {
    const inventory = goodInventory();
    expect(validate(inventory), JSON.stringify(validate.errors)).toBe(true);
    expect(checkProblems(inventory)).toEqual([]);
  });

  it('validates with OS packages collected too', () => {
    const inventory = buildInventory({
      release: { commit: COMMIT, dirty: true, release: 'fixture' },
      sections: {
        ...SECTIONS,
        os_packages: { state: 'collected', source: 'a generated SBOM' },
      },
      components: [
        ...goodInventory().components,
        ...sbomComponents(fixtureJson('sbom.spdx.json'), 'web_image'),
      ],
    });
    expect(validate(inventory), JSON.stringify(validate.errors)).toBe(true);
    expect(checkProblems(inventory)).toEqual([]);
    expect(inventory.sections.os_packages.count).toBe(2);
  });

  it('holds review to the constant, however it is called', () => {
    const inventory = buildInventory({
      release: { commit: COMMIT, dirty: false },
      sections: SECTIONS,
      components: goodInventory().components,
      review: 'reviewed_by_counsel',
    } as never);
    expect(inventory.review).toBe(REVIEW);
    expect(REVIEW).toBe(schema.properties.review.const);
  });

  it('sorts, so two runs on one tree produce one file', () => {
    const forward = goodInventory();
    const backward = buildInventory({
      release: forward.release,
      sections: SECTIONS,
      components: [...forward.components].reverse(),
    });
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it('counts each section itself, whatever it is told', () => {
    const inventory = buildInventory({
      release: { commit: COMMIT, dirty: false },
      sections: { ...SECTIONS, npm: { ...SECTIONS.npm, count: 9999 } },
      components: goodInventory().components,
    });
    expect(inventory.sections.npm.count).toBeLessThan(9999);
    expect(checkProblems(inventory)).toEqual([]);
  });
});

describe('the rules repeat the schema', () => {
  const component = schema.$defs.component.properties;

  it('holds the same lists', () => {
    expect(ATTENTION).toEqual(component.attention.items.enum);
    expect(KINDS).toEqual(component.kind.enum);
    expect(EVIDENCE).toEqual(component.license_evidence.enum);
    expect(ARTIFACTS).toEqual(component.distributed_in.items.enum);
    expect(SECTION_STATES).toEqual(schema.$defs.section.properties.state.enum);
  });
});

describe('checkProblems refuses', () => {
  type Inventory = ReturnType<typeof goodInventory>;
  const refused = (change: (inventory: Inventory) => void) => {
    const inventory = structuredClone(goodInventory());
    change(inventory);
    return checkProblems(inventory).join('\n');
  };
  const firstImage = (inventory: Inventory) =>
    inventory.components.find((c: { kind: string }) => c.kind === 'container_image');

  it('a compose image with no declaration', () => {
    const { components } = imageComponents(composeImages(fixtureText('compose.yaml')), [
      DECLARATIONS[0],
    ]);
    const inventory = buildInventory({
      release: { commit: COMMIT, dirty: false },
      sections: SECTIONS,
      components: [...webComponents(), ...components],
    });
    expect(checkProblems(inventory).join()).toContain('fixture/tools has no declaration');
    // The gap is visible in the file too, and it still has the fixed shape.
    expect(validate(inventory), JSON.stringify(validate.errors)).toBe(true);
  });

  it('but not an image declared as unknown, which is a flagged gap', () => {
    expect(checkProblems(goodInventory())).toEqual([]);
    const tools = goodInventory().components.find(
      (c: { name: string }) => c.name === 'fixture/tools',
    );
    expect(tools.license_declared).toBe('unknown');
  });

  it('not_collected with a non-zero count', () => {
    const text = refused((inventory) => {
      inventory.sections.os_packages.count = 3;
    });
    expect(text).toContain('not_collected, with a non-zero count');
    const invalid = structuredClone(goodInventory());
    invalid.sections.os_packages.count = 3;
    expect(validate(invalid)).toBe(false);
  });

  it('not_collected with components listed, even when built honestly', () => {
    const inventory = buildInventory({
      release: { commit: COMMIT, dirty: false },
      sections: SECTIONS,
      components: [
        ...goodInventory().components,
        ...sbomComponents(fixtureJson('sbom.spdx.json'), 'web_image'),
      ],
    });
    expect(checkProblems(inventory).join()).toContain('not_collected, with a non-zero count');
  });

  it('none_distributed with no reason', () => {
    expect(
      refused((inventory) => {
        delete inventory.sections.model_weights.reason;
      }),
    ).toContain('none_distributed with no reason');
  });

  it('an empty npm section', () => {
    const inventory = buildInventory({
      release: { commit: COMMIT, dirty: false },
      sections: SECTIONS,
      components: goodInventory().components.filter((c: { kind: string }) => c.kind !== 'npm'),
    });
    expect(checkProblems(inventory).join()).toContain(
      'section npm is collected, and lists nothing',
    );
  });

  it('a section not marked collected for npm', () => {
    expect(
      refused((inventory) => {
        inventory.sections.npm.state = 'declared_by_hand';
      }),
    ).toContain('section npm must be collected');
  });

  it('a count that disagrees with the list', () => {
    expect(
      refused((inventory) => {
        inventory.sections.npm.count += 1;
      }),
    ).toContain('components, and lists');
  });

  it('a review that says anything else', () => {
    expect(
      refused((inventory) => {
        inventory.review = 'reviewed_by_counsel';
      }),
    ).toContain('review must be the constant');
  });

  it('a missing section', () => {
    expect(
      refused((inventory) => {
        delete (inventory.sections as Record<string, unknown>).other;
      }),
    ).toContain('section other is missing');
  });

  it('a commit that is not one', () => {
    expect(
      refused((inventory) => {
        inventory.release.commit = 'HEAD';
      }),
    ).toContain('not a full commit hash');
  });

  it('a component that dropped its flag', () => {
    expect(
      refused((inventory) => {
        firstImage(inventory).attention = [];
      }),
    ).toContain('attention is missing');
  });

  it('a component listed twice', () => {
    expect(
      refused((inventory) => {
        inventory.components.push(firstImage(inventory));
        inventory.sections.container_images.count += 1;
      }),
    ).toContain('is listed twice');
  });

  it('an image not pinned by digest', () => {
    expect(
      refused((inventory) => {
        firstImage(inventory).version = 'latest';
      }),
    ).toContain('not pinned by digest');
  });

  it('our own image or package listed as third party', () => {
    expect(
      refused((inventory) => {
        firstImage(inventory).name = 'ensemus/web';
      }),
    ).toContain('our own image');
    expect(
      refused((inventory) => {
        inventory.components.find((c: { kind: string }) => c.kind === 'npm').name = '@ensemus/x';
      }),
    ).toContain('our own package');
  });

  it('a found text with no hash, and a license file outside its package', () => {
    const text = refused((inventory) => {
      firstImage(inventory).license_text = { found: true, file: '../../LICENSE' };
    });
    expect(text).toContain('needs its sha256');
    expect(text).toContain('outside the package');
  });

  it.each([
    [String.raw`C:\Users\Fixture.Person\repo\LICENSE`],
    ['C:/Users/Fixture.Person/repo/LICENSE'],
    [String.raw`\\fileserver\share\LICENSE`],
    ['/home/fixture.person/repo/LICENSE'],
    ['/Users/fixture.person/repo/LICENSE'],
    ['see file:///tmp/LICENSE'],
    ['read from /builds/job/LICENSE here'],
  ])('an absolute path: %s', (path) => {
    expect(
      refused((inventory) => {
        firstImage(inventory).note = path;
      }),
    ).toContain('an absolute path reached the inventory');
  });

  it('not a web address or a relative path', () => {
    expect(
      absolutePathsIn([
        'https://example.invalid/home/user/page',
        'git+https://example.invalid/a/b.git',
        'infrastructure/containers/Dockerfile.web',
        '@ensemus/web and @img/sharp',
        'Apache-2.0/MIT',
        'sha256:abc/def',
      ]),
    ).toEqual([]);
  });
});

describe('no absolute path reaches any output', () => {
  const outputs = () => {
    const inventory = goodInventory();
    return [
      JSON.stringify(inventory),
      renderCsv(inventory),
      renderNotices(inventory, { [SHA]: 'A generated license text.' }),
    ];
  };

  it('starts from a fixture that really holds the user name', () => {
    expect(fixtureText('pnpm-web.json')).toContain(USER_NAME);
    expect(fixtureText('pnpm-worker.json').toLowerCase()).toContain(USER_NAME.toLowerCase());
  });

  it('holds no user name, in any case', () => {
    for (const output of outputs()) {
      expect(output.toLowerCase()).not.toContain(USER_NAME.toLowerCase());
      expect(output).not.toContain('node_modules');
    }
  });

  it('finds this machine in either kind of slash', () => {
    expect(mentionsDirectory(String.raw`a C:\\Users\\Me\\x b`, 'C:/Users/me')).toBe(true);
    expect(mentionsDirectory('nothing here', String.raw`C:\Users\Me`)).toBe(false);
    expect(mentionsDirectory('anything', '/')).toBe(false);
  });
});

describe('renderCsv', () => {
  const lines = (csv: string) => csv.split('\r\n').filter(Boolean);

  it('says what was not collected, and that each row is a draft', () => {
    const csv = renderCsv(goodInventory());
    expect(csv).toContain('section,os_packages');
    expect(csv).toContain('not_collected');
    for (const line of lines(csv).slice(1)) expect(line.startsWith(`${REVIEW},`)).toBe(true);
  });

  it('quotes what would break a row', () => {
    const inventory = structuredClone(goodInventory());
    inventory.components[0].note = 'one, "two"\nthree';
    expect(renderCsv(inventory)).toContain('"one, ""two""\nthree"');
  });

  it('stops a value from running as a spreadsheet formula', () => {
    const inventory = structuredClone(goodInventory());
    inventory.components[0].license_declared = '=HYPERLINK("https://example.invalid")';
    inventory.components[1].license_declared = '+1';
    inventory.components[2].license_declared = '-1';
    const csv = renderCsv(inventory);
    expect(csv).toContain(`"'=HYPERLINK(""https://example.invalid"")"`);
    expect(csv).toContain(",'+1,");
    expect(csv).toContain(",'-1,");
    expect(csv).toContain("'@img/fixture-native");
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });
});

describe('renderNotices', () => {
  it('says on its first line that it is a draft counsel has not reviewed', () => {
    const [first] = renderNotices(goodInventory(), {}).split('\n');
    expect(first).toMatch(/^DRAFT/);
    expect(first).toContain('counsel has not reviewed');
  });

  it('says what was not collected, so a short list cannot read as a complete one', () => {
    const notices = renderNotices(goodInventory(), {});
    expect(notices).toContain('**os_packages**: not_collected, 0');
    expect(notices).toContain('No SBOM was given.');
  });

  it('holds each text once, and a text cannot close its own fence', () => {
    const notices = renderNotices(goodInventory(), { [SHA]: 'Text ```` with a fence.' });
    expect(notices.match(new RegExp(`### sha256 ${SHA}`, 'g'))).toHaveLength(1);
    expect(notices).toContain('`````text');
  });

  it('never says anything was reviewed', () => {
    const notices = renderNotices(goodInventory(), {});
    expect(notices).not.toMatch(/\b(approved|cleared)\b/i);
    expect(notices.replace(/not reviewed|has not reviewed/g, '')).not.toMatch(/\breviewed by\b/i);
  });
});

// The script itself, with pnpm replaced by a generated stand-in, so these need no install and no Docker.
describe('the command', { timeout: 120_000 }, () => {
  const script = join(root, 'infrastructure', 'scripts', 'license-inventory.mjs');
  let work: string;
  let fakeBin: string;
  let listing: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'license-inventory-'));
    fakeBin = join(work, 'bin');
    mkdirSync(fakeBin);
    const fake = join(fixtures, 'fake-pnpm.mjs');
    writeFileSync(join(fakeBin, 'pnpm.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`);
    writeFileSync(join(fakeBin, 'pnpm'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    chmodSync(join(fakeBin, 'pnpm'), 0o755);

    // One package with real files, in a directory holding the user name, and one with none.
    const withText = join(work, 'Users', USER_NAME, 'node_modules', 'has-text');
    mkdirSync(withText, { recursive: true });
    writeFileSync(join(withText, 'LICENSE-APACHE'), 'A generated Apache text.\n');
    writeFileSync(join(withText, 'LICENSE-MIT'), 'A generated MIT text.\n');
    writeFileSync(join(withText, 'NOTICE'), 'A generated notice.\n');
    writeFileSync(join(withText, 'index.js'), 'not a license\n');
    const noticeOnly = join(work, 'Users', USER_NAME, 'node_modules', 'notice-only');
    mkdirSync(noticeOnly, { recursive: true });
    writeFileSync(join(noticeOnly, 'NOTICE.txt'), 'Only a notice.\n');
    listing = join(work, 'listing.json');
    const missing = join(work, 'Users', USER_NAME, 'node_modules', 'gone');
    writeFileSync(
      listing,
      JSON.stringify({
        '@ensemus/web': {
          'MIT OR Apache-2.0': [
            {
              name: 'has-text',
              versions: ['1.0.0'],
              paths: [withText],
              license: 'MIT OR Apache-2.0',
            },
          ],
          MIT: [{ name: 'notice-only', versions: ['1.0.0'], paths: [noticeOnly], license: 'MIT' }],
        },
        '@ensemus/worker': {
          Unknown: [{ name: 'gone', versions: ['1.0.0'], paths: [missing], license: 'Unknown' }],
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  function run(mode: string, args: string[]) {
    const env: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toUpperCase() !== 'PATH') env[key] = value;
    }
    env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
    env.FAKE_PNPM_MODE = mode;
    env.FAKE_PNPM_LISTING = listing;
    return spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  }
  const outDir = (name: string) => join(work, name);
  const FILES = ['license-inventory.json', 'license-inventory.csv', 'THIRD-PARTY-NOTICES.draft.md'];

  it.each([
    ['fail', /ERR_PNPM_FIXTURE/],
    ['garbage', /did not print JSON/],
    ['empty', /no third-party packages/],
  ])('exits 1 and writes nothing when pnpm gives %s', (mode, message) => {
    const out = outDir(`bad-${mode}`);
    const result = run(mode, ['--check', '--out', out]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    for (const file of FILES) expect(existsSync(join(out, file))).toBe(false);
  });

  it('removes an older inventory when a run fails, so it cannot read as current', () => {
    const out = outDir('stale');
    expect(run('listing', ['--check', '--out', out]).status).toBe(0);
    expect(existsSync(join(out, FILES[0] as string))).toBe(true);
    expect(run('fail', ['--check', '--out', out]).status).toBe(1);
    for (const file of FILES) expect(existsSync(join(out, file))).toBe(false);
  });

  it('refuses an argument it does not know, rather than ignoring it', () => {
    expect(run('listing', ['--chekc']).status).toBe(1);
  });

  it('writes all three files, valid and with no path, and passes the gate', () => {
    const out = outDir('good');
    const result = run('listing', ['--check', '--out', out]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('not a review');

    const inventory = JSON.parse(readFileSync(join(out, FILES[0] as string), 'utf8'));
    expect(validate(inventory), JSON.stringify(validate.errors)).toBe(true);
    expect(inventory.review).toBe(REVIEW);

    for (const file of FILES) {
      const text = readFileSync(join(out, file), 'utf8');
      expect(text).not.toContain(USER_NAME);
      expect(mentionsDirectory(text, work)).toBe(false);
      expect(mentionsDirectory(text, root)).toBe(false);
    }
    expect(readFileSync(join(out, FILES[2] as string), 'utf8').split('\n')[0]).toMatch(/^DRAFT/);
  });

  it('says why the OS section was not collected, and shows the test tools it left out', () => {
    const out = outDir('sections');
    run('listing', ['--out', out]);
    const { sections } = JSON.parse(readFileSync(join(out, FILES[0] as string), 'utf8'));
    expect(sections.os_packages.state).toBe('not_collected');
    expect(sections.os_packages.reason).toContain('--sbom-dir');
    expect(sections.model_weights.state).toBe('none_distributed');
    expect(sections.container_images.reason).toContain('alpine/socat');
    expect(sections.container_images.reason).toContain('mock-oauth2-server');
  });

  it('finds license files by name, hashes them, and does not take a NOTICE for one', () => {
    const out = outDir('texts');
    run('listing', ['--out', out]);
    const { components } = JSON.parse(readFileSync(join(out, FILES[0] as string), 'utf8'));
    const find = (name: string) => components.find((c: { name: string }) => c.name === name);

    const hasText = find('has-text');
    expect(hasText.license_text.file).toBe('LICENSE-APACHE');
    expect(hasText.license_text.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(hasText.note).toContain('LICENSE-MIT');
    expect(hasText.note).toContain('NOTICE');
    expect(hasText.attention).toContain('dual_or_choice_of_license');

    const noticeOnly = find('notice-only');
    expect(noticeOnly.license_text.found).toBe(false);
    expect(noticeOnly.attention).toContain('license_text_not_found');
    expect(noticeOnly.note).toContain('NOTICE.txt');

    const gone = find('gone');
    expect(gone.license_declared).toBe('unknown');
    expect(gone.license_evidence).toBe('not_found');

    const notices = readFileSync(join(out, FILES[2] as string), 'utf8');
    expect(notices).toContain('A generated MIT text.');
    expect(notices).toContain('A generated notice.');
  });

  it('reads OS packages from both SBOMs, and refuses a folder missing one', () => {
    const sboms = outDir('sboms');
    mkdirSync(sboms, { recursive: true });
    writeFileSync(join(sboms, 'sbom-web.spdx.json'), fixtureText('sbom.spdx.json'));
    const half = run('listing', ['--check', '--sbom-dir', sboms, '--out', outDir('half')]);
    expect(half.status).toBe(1);
    expect(existsSync(join(outDir('half'), FILES[0] as string))).toBe(false);

    writeFileSync(join(sboms, 'sbom-worker.spdx.json'), fixtureText('sbom.spdx.json'));
    const out = outDir('with-os');
    const result = run('listing', ['--check', '--sbom-dir', sboms, '--out', out]);
    expect(result.status, result.stderr).toBe(0);
    const inventory = JSON.parse(readFileSync(join(out, FILES[0] as string), 'utf8'));
    expect(validate(inventory), JSON.stringify(validate.errors)).toBe(true);
    expect(inventory.sections.os_packages.state).toBe('collected');
    expect(inventory.sections.os_packages.count).toBe(2);
    expect(inventory.sections.os_packages.reason).toContain('2 npm');
    const libc = inventory.components.find((c: { name: string }) => c.name === 'fixture-libc');
    expect(libc.distributed_in).toEqual(['web_image', 'worker_image']);
    expect(mentionsDirectory(JSON.stringify(inventory), sboms)).toBe(false);
  });
});
