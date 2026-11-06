// FOUND-01, ADR-037 D1: what the pin check refuses. It blocks now, so each rule is shown failing as well
// as passing, and the last block runs the real check over this repository.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkRepository } from '../../infrastructure/scripts/check-pins.mjs';
import {
  composeProblems,
  dockerfileProblems,
  manifestProblems,
  scriptImageProblems,
  toolImageProblems,
  versionFileProblems,
  workflowProblems,
} from '../../infrastructure/scripts/pin-rules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const COMMIT = 'b'.repeat(40);

describe('dockerfileProblems', () => {
  const problems = (text: string) => dockerfileProblems('Dockerfile.x', text);

  it('accepts a digest, with or without a tag and a stage name', () => {
    expect(problems(`FROM node:24-slim@${DIGEST} AS build\nFROM node@${DIGEST}\n`)).toEqual([]);
  });

  it('refuses a tag with no digest, naming the file and the reference', () => {
    expect(problems('FROM node:24-slim\n')).toEqual([
      expect.stringMatching(/Dockerfile\.x.*node:24-slim/),
    ]);
  });

  it('refuses a name with neither', () => {
    expect(problems('FROM node\n')).toHaveLength(1);
  });

  it('refuses a digest that is cut short, or is not sha256', () => {
    expect(problems('FROM node@sha256:abc123\n')).toHaveLength(1);
    expect(problems(`FROM node@sha512:${'a'.repeat(128)}\n`)).toHaveLength(1);
    expect(problems(`FROM node@sha256:${'A'.repeat(64)}\n`)).toHaveLength(1);
  });

  it('accepts a reference to an earlier stage, in any case', () => {
    expect(problems(`FROM node@${DIGEST} AS Build\nFROM build\nFROM BUILD AS next\n`)).toEqual([]);
  });

  it('refuses a stage that has not been declared yet, or its own name', () => {
    expect(problems(`FROM later\nFROM node@${DIGEST} AS later\n`)).toHaveLength(1);
    expect(problems('FROM node AS node\n')).toHaveLength(1);
  });

  it('does not take a tag on a stage name for that stage', () => {
    expect(problems(`FROM node@${DIGEST} AS build\nFROM build:1\n`)).toHaveLength(1);
  });

  it('reads past --platform, and still refuses what follows it', () => {
    expect(problems(`FROM --platform=linux/amd64 node:24@${DIGEST} AS a\n`)).toEqual([]);
    expect(problems('FROM --platform=$BUILDPLATFORM node:24\n')).toEqual([
      expect.stringContaining('node:24'),
    ]);
  });

  it('reads a lower-case instruction, a continued line and CRLF', () => {
    expect(problems('from node:24\r\n')).toHaveLength(1);
    expect(problems('FROM \\\n  node:24\n')).toEqual([expect.stringContaining('node:24')]);
    expect(problems(`FROM node:24@${DIGEST}\r\nRUN true\r\n`)).toEqual([]);
  });

  it('honours the escape directive when it reads a continued line', () => {
    expect(problems('# escape=`\nFROM `\n  node:24\n')).toEqual([
      expect.stringContaining('node:24'),
    ]);
  });

  it('refuses what it cannot check: a variable, in the name or the digest', () => {
    expect(problems('ARG BASE\nFROM $BASE\n')).toHaveLength(1);
    expect(problems(`ARG BASE\nFROM \${BASE}@${DIGEST}\n`)).toHaveLength(1);
    expect(problems('ARG SUM\nFROM node@sha256:$SUM\n')).toHaveLength(1);
  });

  it('ignores a comment that names an image', () => {
    expect(problems(`# FROM node:24\nFROM node@${DIGEST}\n`)).toEqual([]);
  });

  it('allows scratch, which is empty and has nothing to pin', () => {
    expect(problems('FROM scratch\n')).toEqual([]);
  });

  it('holds an image pulled in through COPY --from to the same rule', () => {
    expect(problems(`FROM node@${DIGEST}\nCOPY --from=nginx:1 /a /b\n`)).toEqual([
      expect.stringContaining('nginx:1'),
    ]);
    expect(problems(`FROM node@${DIGEST}\nCOPY --from=nginx@${DIGEST} /a /b\n`)).toEqual([]);
    expect(problems(`FROM node@${DIGEST} AS b\nFROM node@${DIGEST}\nCOPY --from=b /a /b\n`)).toEqual(
      [],
    );
    expect(problems(`FROM node@${DIGEST}\nFROM node@${DIGEST}\nCOPY --from=0 /a /b\n`)).toEqual([]);
  });

  it('holds an image mounted into a RUN to the same rule', () => {
    expect(
      problems(`FROM node@${DIGEST}\nRUN --mount=type=bind,from=nginx:1,target=/x true\n`),
    ).toEqual([expect.stringContaining('nginx:1')]);
    expect(problems(`FROM node@${DIGEST}\nRUN --mount=type=cache,target=/x true\n`)).toEqual([]);
  });

  it('refuses a file with no FROM, because it checked nothing', () => {
    expect(problems('')).toEqual([expect.stringContaining('Dockerfile.x')]);
  });
});

describe('composeProblems', () => {
  const problems = (text: string) => composeProblems('compose.x.yaml', text);

  it('accepts a digest, quoted or not, and a trailing comment', () => {
    expect(
      problems(
        [
          'services:',
          `  a: { image: 'caddy@${DIGEST}' }`,
          '  b:',
          `    image: caddy:2-alpine@${DIGEST} # the proxy`,
          '  c:',
          `    image: "caddy@${DIGEST}"`,
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('refuses a tag with no digest, naming the file and the image', () => {
    expect(problems('services:\n  a:\n    image: ghcr.io/x/y:2.3.0\n')).toEqual([
      expect.stringMatching(/compose\.x\.yaml.*ghcr\.io\/x\/y:2\.3\.0/),
    ]);
  });

  it('refuses a flow mapping, a bare name and a short digest', () => {
    expect(problems("services:\n  a: { image: 'caddy:2' }\n")).toHaveLength(1);
    expect(problems('services:\n  a:\n    image: caddy\n')).toHaveLength(1);
    expect(problems('services:\n  a:\n    image: caddy@sha256:abc\n')).toHaveLength(1);
  });

  it('refuses a variable, an alias or an empty value, which it cannot check', () => {
    expect(problems('services:\n  a:\n    image: ${IMAGE}\n')).toHaveLength(1);
    expect(problems(`services:\n  a:\n    image: \${IMAGE:-caddy@${DIGEST}}\n`)).toHaveLength(1);
    expect(problems('services:\n  a:\n    image: *base\n')).toHaveLength(1);
    expect(problems('services:\n  a:\n    image:\n')).toHaveLength(1);
  });

  it('ignores a comment and a key that only ends in image', () => {
    expect(
      problems('services:\n  a:\n    # image: caddy:2\n    environment:\n      x-image: caddy:2\n'),
    ).toEqual([]);
  });

  it('accepts an image built here, only beside its own build', () => {
    const built = [
      'services:',
      '  web:',
      '    build:',
      '      context: ../..',
      '    image: ensemus/web:local',
      '  worker:',
      '    image: ensemus/worker:local',
      '    build: { context: ../.. }',
    ].join('\n');
    expect(problems(built)).toEqual([]);
  });

  it('refuses that name with no build, because it would be pulled from a registry', () => {
    const notBuilt = [
      'services:',
      '  other:',
      '    build: .',
      '  web:',
      '    image: ensemus/web:local',
      '  more:',
      '    build: .',
    ].join('\n');
    expect(problems(notBuilt)).toEqual([expect.stringContaining('ensemus/web:local')]);
  });

  it('refuses any other tag on that name', () => {
    expect(problems('services:\n  a:\n    build: .\n    image: ensemus/web:latest\n')).toHaveLength(
      1,
    );
  });
});

describe('workflowProblems', () => {
  const problems = (text: string) => workflowProblems('ci.yml', text);
  const step = (line: string) => `jobs:\n  a:\n    steps:\n      ${line}\n`;

  it('accepts a 40-hex commit, with the version in a comment', () => {
    expect(problems(step(`- uses: actions/checkout@${COMMIT} # v7.0.1`))).toEqual([]);
    expect(problems(step(`- uses: 'actions/cache/restore@${COMMIT}'`))).toEqual([]);
    expect(problems(step(`- name: x\n        uses: a/b@${COMMIT}`))).toEqual([]);
  });

  it('refuses a tag and a branch, naming the file and the reference', () => {
    expect(problems(step('- uses: actions/checkout@v7'))).toEqual([
      expect.stringMatching(/ci\.yml.*actions\/checkout@v7/),
    ]);
    expect(problems(step('- uses: actions/checkout@main'))).toHaveLength(1);
  });

  it('refuses a short commit, a long one, capitals, and none at all', () => {
    expect(problems(step('- uses: actions/checkout@3d3c42e'))).toHaveLength(1);
    expect(problems(step(`- uses: actions/checkout@${COMMIT}0`))).toHaveLength(1);
    expect(problems(step(`- uses: actions/checkout@${'B'.repeat(40)}`))).toHaveLength(1);
    expect(problems(step('- uses: actions/checkout'))).toHaveLength(1);
  });

  it('does not take the version in a comment for the pin', () => {
    expect(problems(step(`- uses: actions/checkout@v7 # ${COMMIT}`))).toHaveLength(1);
  });

  it('accepts an action from this repository, which is the commit being run', () => {
    expect(problems(step('- uses: ./.github/actions/setup'))).toEqual([]);
  });

  it('holds a container action to the image rule', () => {
    expect(problems(step(`- uses: docker://alpine@${DIGEST}`))).toEqual([]);
    expect(problems(step('- uses: docker://alpine:3'))).toHaveLength(1);
  });

  it('accepts a frozen install', () => {
    expect(problems(step('- run: pnpm install --frozen-lockfile'))).toEqual([]);
    expect(problems(step('- run: pnpm --filter @ensemus/web install --frozen-lockfile'))).toEqual(
      [],
    );
    expect(problems(step('- run: |\n          pnpm install \\\n            --frozen-lockfile'))).toEqual(
      [],
    );
  });

  it('refuses an install that can change the lockfile', () => {
    for (const command of [
      '- run: pnpm install',
      '- run: pnpm i',
      '- run: pnpm install --no-frozen-lockfile',
      '- run: pnpm install --frozen-lockfile=false',
      '- run: pnpm --filter @ensemus/web install',
      '- run: corepack enable && pnpm install && pnpm test --frozen-lockfile',
      '- run: |\n          corepack enable\n          pnpm install',
    ]) {
      expect(problems(step(command)), command).toEqual([expect.stringContaining('ci.yml')]);
    }
  });

  it('is not fooled by another tool called install, a step name or a comment', () => {
    expect(
      problems(
        step(
          [
            '- name: pnpm install',
            '        run: pnpm --filter @ensemus/browser-tests exec playwright install chromium',
            '      # - run: pnpm install',
          ].join('\n'),
        ),
      ),
    ).toEqual([]);
  });
});

describe('manifestProblems', () => {
  const problems = (json: unknown) => manifestProblems('package.json', json);

  it('accepts exact versions, a prerelease and workspace:*', () => {
    expect(
      problems({
        dependencies: { a: '1.2.3', '@x/b': 'workspace:*' },
        devDependencies: { c: '1.2.3-rc.1' },
      }),
    ).toEqual([]);
  });

  it.each(['^1.2.3', '~1.2.3', '*', 'latest', '>=1.0.0', '1.2', '1.x', '', 'workspace:^'])(
    'refuses %j',
    (version) => {
      expect(problems({ dependencies: { left: version } })).toEqual([
        expect.stringMatching(/package\.json.*left/),
      ]);
    },
  );

  it.each(['git+https://example.invalid/x.git', 'file:../x', 'npm:other@1.2.3', 'catalog:'])(
    'refuses %j, which a version check would not otherwise see',
    (version) => {
      expect(problems({ dependencies: { left: version } })).toHaveLength(1);
    },
  );

  it.each(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])(
    'looks in %s',
    (section) => {
      expect(problems({ [section]: { left: '^1.0.0' } })).toHaveLength(1);
    },
  );

  it('looks at overrides, which replace what the rest of the file says', () => {
    expect(problems({ pnpm: { overrides: { left: '^1.0.0' } } })).toHaveLength(1);
    expect(problems({ overrides: { left: '^1.0.0' } })).toHaveLength(1);
  });

  it('refuses a version that is not a string, and a manifest that is not an object', () => {
    expect(problems({ dependencies: { left: 1 } })).toHaveLength(1);
    expect(problems(null)).toHaveLength(1);
  });

  it('accepts a manifest with no dependencies', () => {
    expect(problems({ name: 'x' })).toEqual([]);
  });
});

describe('scriptImageProblems', () => {
  const problems = (text: string, name = 'gate.mjs') => scriptImageProblems(name, text);

  it('accepts a digest, a built image and a tool from tool-images.mjs', () => {
    expect(
      problems(
        [
          "import { SYFT } from './tool-images.mjs';",
          `const NODE = 'node:24-slim@${DIGEST}';`,
          "const IMAGES = { web: 'ensemus/web:local' };",
          "run('docker', ['run', '--rm', SYFT.image, 'scan']);",
          "run('docker', ['run', '--rm', NODE, 'node']);",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('refuses a tag with no digest, naming the file and the image', () => {
    expect(problems("const TOOLS = 'nicolaka/netshoot:v0.14';\n")).toEqual([
      expect.stringMatching(/gate\.mjs.*nicolaka\/netshoot:v0\.14/),
    ]);
    expect(problems("const A = 'alpine:3.20';\n")).toHaveLength(1);
    expect(problems("const A = 'alpine:latest';\n")).toHaveLength(1);
    expect(problems('const A = "ghcr.io/x/y:2.3.0";\n')).toHaveLength(1);
  });

  it('refuses a digest that is cut short', () => {
    expect(problems("const A = 'alpine@sha256:abc';\n")).toHaveLength(1);
  });

  it('refuses another tag on a name built here', () => {
    expect(problems("const A = 'ensemus/web:latest';\n")).toHaveLength(1);
    expect(problems("const A = 'other/web:local';\n")).toHaveLength(1);
  });

  it('refuses an image with no tag, where docker would run it', () => {
    expect(problems("run('docker', ['run', '--rm', 'alpine', 'sh']);\n")).toEqual([
      expect.stringContaining('alpine'),
    ]);
    expect(problems("run('docker', ['pull', 'alpine']);\n")).toHaveLength(1);
    expect(problems('docker run --rm -v a:/b --network none alpine sh\n', 'x.sh')).toEqual([
      expect.stringContaining('alpine'),
    ]);
    expect(problems('docker pull alpine\n', 'x.sh')).toHaveLength(1);
  });

  it('follows a constant to the image it names', () => {
    expect(
      problems("const TOOLS = 'alpine';\nrun('docker', ['run', '--network', 'host', TOOLS]);\n"),
    ).toEqual([expect.stringContaining('alpine')]);
  });

  it('reports one image once, however many ways it finds it', () => {
    expect(
      problems("const TOOLS = 'alpine:3';\nrun('docker', ['run', TOOLS]);\nrun('docker', ['run', TOOLS]);\n"),
    ).toHaveLength(1);
  });

  it('reads a shell assignment and a tagged image on a docker line', () => {
    expect(problems('TOOLS=alpine:3\n', 'x.sh')).toHaveLength(1);
    expect(problems('docker run --rm alpine:3 sh\n', 'x.sh')).toHaveLength(1);
    expect(problems(`docker run --rm alpine@${DIGEST} sh\n`, 'x.sh')).toEqual([]);
  });

  it('ignores a comment', () => {
    expect(problems("// docker run alpine:3\n# docker pull alpine\n * 'alpine:3'\n")).toEqual([]);
  });

  it('leaves what is decided at run time to the rules for where it comes from', () => {
    expect(
      problems(
        [
          "run('docker', ['run', '--rm', ...runArguments(proxy), proxy.image, 'caddy']);",
          'run(`ensemus-upgrade/${image}:current`);',
          'docker run --rm "$IMAGE" sh',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('is not fooled by what only looks like an image', () => {
    expect(
      problems(
        [
          "import { spawnSync } from 'node:child_process';",
          "import { x } from 'node:fs/promises';",
          "const a = ['web:127.0.0.1', 'postgres:5432', 'localhost:58080', 'check:pins'];",
          "const b = ['postgres://u:p@postgres:5432/db', 'text/plain', 'test:unit', 'a b:c'];",
          "const c = ['@ensemus/web', 'https://example.invalid/x:1', 'SIGTERM:now'];",
          "run('docker', ['exec', 'x', 'wget']);",
          "run('docker', ['compose', 'pull']);",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('still catches a builtin name with a version on it', () => {
    expect(problems("const A = 'node:24-slim';\n")).toHaveLength(1);
    expect(problems("const A = 'node:lts';\n")).toHaveLength(1);
  });
});

describe('toolImageProblems', () => {
  it('accepts every entry by digest', () => {
    expect(toolImageProblems({ SYFT: { image: `anchore/syft:v1@${DIGEST}` } })).toEqual([]);
  });

  it('refuses a tag with no digest, naming the tool and the image', () => {
    expect(toolImageProblems({ SYFT: { image: 'anchore/syft:v1' } })).toEqual([
      expect.stringMatching(/SYFT.*anchore\/syft:v1/),
    ]);
  });

  it('refuses a short digest and an entry with no image', () => {
    expect(toolImageProblems({ A: { image: 'a@sha256:abc' } })).toHaveLength(1);
    expect(toolImageProblems({ A: {} })).toHaveLength(1);
    expect(toolImageProblems({ A: 'a' })).toHaveLength(1);
  });

  it('refuses an empty list, because it checked nothing', () => {
    expect(toolImageProblems({})).toHaveLength(1);
  });
});

describe('versionFileProblems', () => {
  const packageManager = `pnpm@10.17.0+sha512.${'f'.repeat(128)}`;

  it('accepts an exact Node and a hashed package manager', () => {
    expect(versionFileProblems({ nvmrc: '24.22.2\n', packageManager })).toEqual([]);
    expect(
      versionFileProblems({
        nvmrc: '24.22.2',
        packageManager: `pnpm@10.17.0+sha256.${'f'.repeat(64)}`,
      }),
    ).toEqual([]);
  });

  it.each(['24', '24.22', 'lts/*', 'v24.22.2', 'node', '', '24.22.2.1'])(
    'refuses a floating .nvmrc of %j',
    (nvmrc) => {
      expect(versionFileProblems({ nvmrc, packageManager })).toEqual([
        expect.stringContaining('.nvmrc'),
      ]);
    },
  );

  it('refuses a missing .nvmrc and a missing packageManager', () => {
    expect(versionFileProblems({ nvmrc: undefined, packageManager })).toHaveLength(1);
    expect(versionFileProblems({ nvmrc: '24.22.2', packageManager: undefined })).toHaveLength(1);
  });

  it.each([
    'pnpm@10.17.0',
    'pnpm@latest',
    'pnpm@10+sha512.abc',
    'pnpm@10.17.0+sha1.abc',
    'pnpm@10.17.0+sha512.',
    'pnpm@10.17.0+sha512.abc',
    `pnpm@10.17.0+sha512.${'z'.repeat(128)}`,
    `pnpm@10.17.0+sha256.${'f'.repeat(128)}`,
  ])('refuses a packageManager of %j', (value) => {
    expect(versionFileProblems({ nvmrc: '24.22.2', packageManager: value })).toEqual([
      expect.stringContaining('packageManager'),
    ]);
  });
});

describe('checkRepository, on a made-up repository', () => {
  const inFolder = async (files: Record<string, string>) => {
    const folder = mkdtempSync(join(tmpdir(), 'pins-'));
    try {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(folder, path)), { recursive: true });
        writeFileSync(join(folder, path), text);
      }
      return await checkRepository(folder);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };
  const good = {
    '.nvmrc': '24.22.2\n',
    'package.json': JSON.stringify({
      packageManager: `pnpm@10.17.0+sha512.${'f'.repeat(128)}`,
      dependencies: { a: '1.2.3' },
    }),
    'infrastructure/containers/Dockerfile.web': `FROM node@${DIGEST}\n`,
    'infrastructure/compose/compose.yaml': `services:\n  a:\n    image: caddy@${DIGEST}\n`,
    '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - uses: a/b@${COMMIT}\n`,
    'infrastructure/scripts/tool-images.mjs': `export const A = { image: 'a@${DIGEST}' };\n`,
    'infrastructure/scripts/gate.mjs': `const A = 'a@${DIGEST}';\n`,
  };

  it('passes a clean one and counts what it read', async () => {
    const { checked, problems } = await inFolder(good);
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it.each([
    ['infrastructure/containers/Dockerfile.web', 'FROM node:24\n'],
    ['infrastructure/compose/compose.yaml', 'services:\n  a:\n    image: caddy:2\n'],
    ['.github/workflows/ci.yml', 'jobs:\n  a:\n    steps:\n      - uses: a/b@v1\n'],
    ['package.json', '{"packageManager":"pnpm@10.17.0","dependencies":{"a":"^1.0.0"}}'],
    ['packages/x/package.json', '{"dependencies":{"a":"^1.0.0"}}'],
    ['infrastructure/scripts/gate.mjs', "const A = 'alpine:3';\n"],
    ['tests/stack/x.test.ts', "run('docker', ['run', 'alpine']);\n"],
    ['infrastructure/scripts/tool-images.mjs', "export const A = { image: 'a:1' };\n"],
    ['.nvmrc', '24\n'],
  ])('finds an unpinned %s', async (path, text) => {
    const { problems } = await inFolder({ ...good, [path]: text });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(path.split('/').pop());
  });

  it('does not read a dependency folder, a generated one or the docs', async () => {
    const { problems } = await inFolder({
      ...good,
      'node_modules/x/Dockerfile': 'FROM node:24\n',
      '.local/x/gate.mjs': "const A = 'alpine:3';\n",
      'docs/specifications/compose.reference.yaml': 'services:\n  a:\n    image: caddy:2\n',
    });
    expect(problems).toEqual([]);
  });

  it.each([
    ['infrastructure/containers/Dockerfile.web', 'Dockerfile'],
    ['infrastructure/compose/compose.yaml', 'Compose'],
    ['.github/workflows/ci.yml', 'workflow'],
    ['infrastructure/scripts/gate.mjs', 'script'],
  ])('fails when %s is gone, so a moved folder cannot pass by checking nothing', async (path, kind) => {
    const files: Record<string, string> = { ...good };
    delete files[path];
    if (kind === 'script') delete files['infrastructure/scripts/tool-images.mjs'];
    const { problems } = await inFolder(files);
    expect(problems.join('\n')).toContain(kind);
  });

  it('fails an empty folder', async () => {
    const { problems } = await inFolder({});
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('this repository', () => {
  it('has nothing unpinned', async () => {
    const { checked, problems } = await checkRepository(root);
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });

  it('gets the same answer from the command line', async () => {
    const { problems } = await checkRepository(root);
    const result = spawnSync(
      process.execPath,
      [join(root, 'infrastructure/scripts/check-pins.mjs')],
      { cwd: root, encoding: 'utf8' },
    );
    if (problems.length === 0) {
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^Pins: OK, \d+ checked\s*$/);
    } else {
      expect(result.status).toBe(1);
      for (const problem of problems) expect(result.stdout + result.stderr).toContain(problem);
    }
  });
});
