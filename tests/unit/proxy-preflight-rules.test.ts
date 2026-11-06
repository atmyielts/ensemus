// ADR-037 D9: the checks that tell someone a proxy looks unnamed, which only warn. The preflight's rules
// and how it reads a file, and then the web tier's small part in the runtime check. The runtime check
// itself is tested in packages/telemetry. Run here, because the web app has no test runner of its own.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeFinding,
  parseEnvFile,
  proxyFindings,
} from '../../infrastructure/scripts/proxy-preflight-rules.mjs';

// The real one throws outside a React server build. Named by path: tests/ does not depend on it.
vi.mock('../../apps/web/node_modules/server-only/index.js', () => ({}));

const NO_PROXY = 'PUBLIC_NAME_ON_LOOPBACK_WITH_NO_PROXY_LISTED';
const TOO_MUCH = 'PROXY_LIST_TRUSTS_TOO_MUCH';
const SETTING = 'ENSEMUS_TRUSTED_PROXIES';

const codes = (env: Record<string, string>) =>
  proxyFindings(env).map((finding: { code: string }) => finding.code);

describe('a public name on loopback with no proxy listed', () => {
  const unnamed = { ENSEMUS_PUBLIC_URL: 'https://ensemus.example.invalid' };

  it('is found when the bind address and the list are unset', () => {
    expect(proxyFindings(unnamed)).toEqual([{ code: NO_PROXY, setting: SETTING }]);
  });

  it.each(['', '   ', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost'])(
    'is found with the bind address "%s"',
    (ENSEMUS_BIND_ADDRESS) => {
      expect(codes({ ...unnamed, ENSEMUS_BIND_ADDRESS })).toEqual([NO_PROXY]);
    },
  );

  it.each(['', '  '])('is found with the list "%s"', (ENSEMUS_TRUSTED_PROXIES) => {
    expect(codes({ ...unnamed, ENSEMUS_TRUSTED_PROXIES })).toEqual([NO_PROXY]);
  });

  it('is found for a public address, not only a name', () => {
    expect(codes({ ENSEMUS_PUBLIC_URL: 'https://203.0.113.9:8443' })).toEqual([NO_PROXY]);
  });

  it.each([
    'https://localhost:8443',
    'https://LOCALHOST:8443',
    'https://ensemus.localhost:8443',
    'https://127.0.0.1:8443',
    'https://127.8.9.10',
    'https://[::1]:8443',
  ])('passes when the public address is %s', (ENSEMUS_PUBLIC_URL) => {
    expect(codes({ ENSEMUS_PUBLIC_URL })).toEqual([]);
  });

  it('passes when there is no public address, which defaults to localhost', () => {
    expect(codes({})).toEqual([]);
  });

  it('says nothing about a public address it cannot read', () => {
    expect(codes({ ENSEMUS_PUBLIC_URL: 'not a url' })).toEqual([]);
  });

  it.each(['0.0.0.0', '192.0.2.10', '::'])('passes when bound to %s', (ENSEMUS_BIND_ADDRESS) => {
    expect(codes({ ...unnamed, ENSEMUS_BIND_ADDRESS })).toEqual([]);
  });

  it('passes when a proxy is listed', () => {
    expect(codes({ ...unnamed, ENSEMUS_TRUSTED_PROXIES: '172.30.0.1' })).toEqual([]);
  });
});

describe('a list that trusts too much', () => {
  it.each([
    'private_ranges',
    '0.0.0.0/0',
    '::/0',
    '10.0.0.0/7',
    '128.0.0.0/1',
    'fc00::/7',
    '192.0.2.1 private_ranges',
    '192.0.2.1  0.0.0.0/0\t198.51.100.1',
  ])('is found in "%s"', (ENSEMUS_TRUSTED_PROXIES) => {
    expect(proxyFindings({ ENSEMUS_TRUSTED_PROXIES })).toEqual([
      { code: TOO_MUCH, setting: SETTING },
    ]);
  });

  it.each([
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.0.2.1',
    '192.0.2.0/24',
    '2001:db8::/32',
    '::1',
    '192.0.2.1 198.51.100.0/24',
  ])('passes "%s"', (ENSEMUS_TRUSTED_PROXIES) => {
    expect(proxyFindings({ ENSEMUS_TRUSTED_PROXIES })).toEqual([]);
  });

  it('is one finding however many entries are too wide', () => {
    expect(codes({ ENSEMUS_TRUSTED_PROXIES: 'private_ranges 0.0.0.0/0 ::/0' })).toEqual([TOO_MUCH]);
  });
});

describe('what a finding says', () => {
  const canaries = {
    ENSEMUS_PUBLIC_URL: 'https://canary-host-7f3a.example.invalid',
    ENSEMUS_BIND_ADDRESS: '127.0.0.77',
    ENSEMUS_TRUSTED_PROXIES: '10.77.0.0/7',
  };

  it.each([
    [
      NO_PROXY,
      { ENSEMUS_PUBLIC_URL: canaries.ENSEMUS_PUBLIC_URL, ENSEMUS_BIND_ADDRESS: '127.0.0.77' },
    ],
    [TOO_MUCH, canaries],
  ])('%s repeats no value', (code, env) => {
    const findings = proxyFindings(env);
    expect(findings.map((finding: { code: string }) => finding.code)).toEqual([code]);
    const said = JSON.stringify(findings) + findings.map(describeFinding).join('\n');
    expect(said).not.toContain('canary-host-7f3a');
    expect(said).not.toContain('127.0.0.77');
    expect(said).not.toContain('10.77.0.0');
  });
});

describe('reading an env file', () => {
  it('reads plain values, and skips blank lines, comments and lines with no assignment', () => {
    const text = [
      '# A comment',
      '',
      '   # An indented comment',
      'NOT AN ASSIGNMENT',
      'FIRST=one',
      '  SECOND = two ',
      'EMPTY=',
      '#COMMENTED=out',
    ].join('\n');
    expect(parseEnvFile(text)).toEqual({ FIRST: 'one', SECOND: 'two', EMPTY: '' });
  });

  it('ends an unquoted value at a comment, which needs a space before it', () => {
    expect(parseEnvFile('A=value # about it\nB=a#b\nC= # only a comment\nD=#none')).toEqual({
      A: 'value',
      B: 'a#b',
      C: '',
      D: '',
    });
  });

  it('keeps what is inside quotes, and drops what follows them', () => {
    const text = [
      `A="two words"`,
      `B='two words'`,
      `C="a # b" # after`,
      `D='a # b' # after`,
      `E=""`,
      `F=''`,
      `G="say \\"hi\\""`,
      `H='no \\"escapes\\"'`,
    ].join('\n');
    expect(parseEnvFile(text)).toEqual({
      A: 'two words',
      B: 'two words',
      C: 'a # b',
      D: 'a # b',
      E: '',
      F: '',
      G: 'say "hi"',
      H: 'no \\"escapes\\"',
    });
  });

  it('takes `export`, Windows line endings and a byte order mark in its stride', () => {
    expect(parseEnvFile('﻿export A=one\r\nB="two"\r\n')).toEqual({ A: 'one', B: 'two' });
  });

  it('lets a later line win', () => {
    expect(parseEnvFile('A=one\nA=two')).toEqual({ A: 'two' });
  });

  it('cannot be made to set anything but its own keys', () => {
    const env = parseEnvFile('__proto__=polluted\nconstructor=x');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    expect(Object.keys(env)).toEqual(['__proto__', 'constructor']);
  });

  it('feeds the rules, quotes and comments included', () => {
    const env = parseEnvFile(
      [
        '# A deployment',
        'ENSEMUS_PUBLIC_URL="https://ensemus.example.invalid" # the name',
        'ENSEMUS_TRUSTED_PROXIES= # nobody yet',
      ].join('\n'),
    );
    expect(codes(env)).toEqual([NO_PROXY]);
  });
});

describe('the preflight command', () => {
  const folder = mkdtempSync(join(tmpdir(), 'proxy-preflight-'));
  const script = fileURLToPath(
    new URL('../../infrastructure/scripts/proxy-preflight.mjs', import.meta.url),
  );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: folder, encoding: 'utf8' });
  const envFile = (name: string, text: string) => {
    const path = join(folder, name);
    writeFileSync(path, text);
    return path;
  };

  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it('prints a finding and still exits 0, repeating no value', () => {
    const result = run(
      envFile(
        'findings.env',
        'ENSEMUS_PUBLIC_URL=https://canary-host-7f3a.example.invalid\nENSEMUS_TRUSTED_PROXIES=\n',
      ),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(NO_PROXY);
    expect(result.stdout).not.toContain('canary-host-7f3a');
  });

  it('exits 0 with nothing to warn about', () => {
    const result = run(envFile('clean.env', 'ENSEMUS_PUBLIC_URL=https://localhost:8443\n'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 warning(s)');
    expect(result.stdout).not.toContain('WARNING');
  });

  it('reads .env by default', () => {
    envFile('.env', 'ENSEMUS_TRUSTED_PROXIES=private_ranges\n');
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(TOO_MUCH);
  });

  it('exits 1 only when it cannot read the file', () => {
    const result = run(join(folder, 'missing.env'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not read');
  });
});

describe('the web tier noting a client address', () => {
  const WATCH = Symbol.for('ensemus.clientAddressWatch');
  const holder = globalThis as unknown as Record<symbol, unknown>;
  const WARNING = 'proxy.client_addresses_look_shared';
  const written: string[] = [];

  /** A fresh process, as far as the module and its watch are concerned. */
  async function freshModule() {
    vi.resetModules();
    delete holder[WATCH];
    return import('../../apps/web/src/server/client-address');
  }

  const warnings = () => written.filter((line) => line.includes(WARNING));

  beforeEach(() => {
    written.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete holder[WATCH];
  });

  const people = (
    noteClientAddress: (forwardedFor: string | null, userId: string) => void,
    forwardedFor: string | null,
    count = 5,
  ) => {
    for (let person = 0; person < count; person += 1) {
      noteClientAddress(forwardedFor, `canary-user-${person}`);
    }
  };

  it('logs the count, and neither the address nor who it saw', async () => {
    const { noteClientAddress } = await freshModule();
    people(noteClientAddress, '10.99.88.77');
    expect(warnings()).toHaveLength(1);
    const line = JSON.parse(warnings()[0] as string);
    expect(line).toMatchObject({ level: 'warn', service: 'web', event: WARNING, count: 5 });
    expect(Object.keys(line).sort()).toEqual(['count', 'event', 'level', 'service', 'ts']);
    expect(written.join('')).not.toContain('10.99.88.77');
    expect(written.join('')).not.toContain('canary-user');
  });

  it('reads the first value, trimmed, and nothing after the comma', async () => {
    const { noteClientAddress } = await freshModule();
    for (let person = 0; person < 5; person += 1) {
      noteClientAddress(`  10.1.2.3 , 203.0.113.${person}`, `user-${person}`);
    }
    expect(warnings()).toHaveLength(1);
  });

  it('is not fooled by a private address after a public first value', async () => {
    const { noteClientAddress } = await freshModule();
    people(noteClientAddress, '203.0.113.9, 10.1.2.3');
    expect(warnings()).toEqual([]);
  });

  it.each([null, '', '   ', ' , 10.1.2.3'])('ignores the header %j', async (header) => {
    const { noteClientAddress } = await freshModule();
    people(noteClientAddress, header);
    expect(warnings()).toEqual([]);

    // None of those counted as an address, so people arriving afterwards are still seen.
    people(noteClientAddress, '10.1.2.3');
    expect(warnings()).toHaveLength(1);
  });

  it('keeps one watch for the process, however many times the module is loaded', async () => {
    const pages = await freshModule();
    vi.resetModules();
    const routes = await import('../../apps/web/src/server/client-address');
    expect(routes.noteClientAddress).not.toBe(pages.noteClientAddress);

    for (let person = 0; person < 3; person += 1) {
      pages.noteClientAddress('10.1.2.3', `user-${person}`);
    }
    for (let person = 3; person < 5; person += 1) {
      routes.noteClientAddress('10.1.2.3', `user-${person}`);
    }
    expect(warnings()).toHaveLength(1);
  });

  it('never fails a request, even when the warning cannot be written', async () => {
    const { noteClientAddress } = await freshModule();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw Object.assign(new Error('stdout is gone'), { code: 'EPIPE' });
    });
    expect(() => people(noteClientAddress, '10.1.2.3')).not.toThrow();
    expect(() => people(noteClientAddress, '10.1.2.3')).not.toThrow();
  });
});
