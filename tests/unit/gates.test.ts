// Every gate that exists runs both on one machine and in CI, and a stack left by one cannot be picked
// up by the next. A new gate fails this until it is added to both.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** A gate that is commented out does not run, so a comment naming it must not satisfy a check. */
const commandsIn = (path: string) =>
  readFileSync(join(root, path), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
const local = commandsIn('infrastructure/scripts/run-all-gates.sh');
const ci = commandsIn('.github/workflows/ci.yml');
const scripts = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/** What has to appear in both files for each gate. */
const COMMANDS: Record<string, string> = {
  format: 'pnpm format:check',
  lint: 'pnpm lint',
  typecheck: 'pnpm typecheck',
  'route types': 'next typegen',
  'test:unit': 'pnpm test:unit',
  'test:replay': 'pnpm test:replay',
  'test:integration': 'pnpm test:integration',
  'test:browser': 'pnpm test:browser',
  'check:backlog': 'pnpm check:backlog',
  'check:contracts': 'pnpm check:contracts',
  'check:licenses': 'pnpm check:licenses',
  // The one place the deployed Caddyfile runs. CI needs no install for it, so it names the script.
  'check:proxy': 'node infrastructure/scripts/check-proxy.mjs',
  audit: 'pnpm audit --prod --audit-level high',
  manifest: 'regenerate-manifest.mjs',
  'air-gap control': 'air-gap-gate.mjs --control',
  // The stack suite runs here, with outbound traffic blocked. Nothing runs test:stack by name.
  'test:stack': 'node infrastructure/scripts/air-gap-gate.mjs',
  'build-release.mjs': 'build-release.mjs',
  // test:upgrade is this script without --from.
  'test:upgrade': 'upgrade-gate.mjs --from',
  'stack:slice-2': 'pnpm stack:slice-2',
  'connector air-gap': 'air-gap-gate.mjs --connectors',
  'connector browser': 'playwright test specs/external-actions.spec.ts',
};

const gateScripts = readdirSync(join(root, 'infrastructure/scripts')).filter((name) =>
  name.endsWith('-gate.mjs'),
);

describe('every gate runs in both places', () => {
  it.each(Object.entries(COMMANDS))('%s', (_, command) => {
    expect(local).toContain(command);
    expect(ci).toContain(command);
  });

  it('knows about every test and check script in package.json', () => {
    const declared = Object.keys(scripts).filter((name) => /^(test|check):/.test(name));
    expect(declared.filter((name) => !(name in COMMANDS))).toEqual([]);
  });

  it('knows about every gate script', () => {
    const named = Object.values(COMMANDS).join(' ');
    expect(gateScripts.filter((name) => !named.includes(name))).toEqual([]);
    expect(gateScripts.length).toBeGreaterThan(0);
  });

  it('runs the full air-gap round in both, and not only the control', () => {
    const fullRun = /air-gap-gate\.mjs( --keep)?\s*$/m;
    expect(local).toMatch(fullRun);
    expect(ci).toMatch(fullRun);
  });

  it('enables the real AI contract and canary cases in the offline CI stack job', () => {
    const stackJob = ci.slice(ci.indexOf('\n  stack:'), ci.indexOf('\n  connectors:'));
    expect(stackJob).toMatch(/ENSEMUS_AI_ENABLED:\s*'true'/);
  });

  it('enables those same AI cases in the local full offline round', () => {
    expect(local).toMatch(
      /fresh env ENSEMUS_AI_ENABLED=true node infrastructure\/scripts\/air-gap-gate\.mjs\s*$/m,
    );
  });
});

describe('on one machine', () => {
  const gateLines = local.split('\n').filter((line) => line.startsWith('gate "'));

  it('starts every disposable gate from nothing, and leaves nothing', () => {
    const usesTheProject = gateLines.filter((line) =>
      /test:integration|air-gap-gate|browser_tests|connectors_tests/.test(line),
    );
    expect(usesTheProject).toHaveLength(6);
    for (const line of usesTheProject) expect(line).toMatch(/^gate "[^"]+" fresh /);
  });

  it('uses its own invocation project and refuses low disk space before any stack cleanup', () => {
    expect(local).toContain('export COMPOSE_PROJECT_NAME="ensemus-gates-${BASHPID:-$$}"');
    expect(local.indexOf('node infrastructure/scripts/disk-headroom.mjs || exit 1')).toBeLessThan(
      local.indexOf('\nclean_stack\n'),
    );
  });

  it('clears the stack on both sides of a gate, whatever its result', () => {
    expect(local).toMatch(
      /fresh\(\) \{\n {2}clean_stack\n {2}"\$@"\n {2}local status=\$\?\n {2}clean_stack\n {2}return "\$status"\n\}/,
    );
  });

  it('clears everything those gates can start, with every overlay and profile', () => {
    const clean = /clean_stack\(\) \{([\s\S]*?)\n\}/.exec(local)?.[1] ?? '';
    expect(clean).toContain('"${compose_files[@]}"');
    expect(clean).toContain('compose.airgap.yaml');
    expect(clean).toContain('--profile test-oidc');
    expect(clean).toContain('--profile connectors');
    expect(clean).toContain('down -v --remove-orphans');
  });

  it('runs the air-gap gate without leaving its stack up', () => {
    expect(gateLines.filter((line) => line.includes('--keep'))).toEqual([]);
  });

  it('lets the upgrade gate apart, because it has its own project, addresses and port', () => {
    const upgrade = readFileSync(join(root, 'infrastructure/scripts/upgrade-gate.mjs'), 'utf8');
    expect(upgrade).toContain("const PROJECT = 'ensemus-upgrade'");
    expect(upgrade).toContain("ENSEMUS_NETWORK_PREFIX: '172.29'");
    expect(upgrade).toContain("process.env.ENSEMUS_UPGRADE_PORT ?? '18443'");
  });
});
