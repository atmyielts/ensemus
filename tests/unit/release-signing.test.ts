// FOUND-07, ADR-037 D4: what a release can be trusted for. These run the real verifier on temporary
// folders, with generated keys and a local fake signer, because the end-to-end in build-release.mjs
// needs built images and Docker. Passing here does not close FOUND-07: key custody is the owner's.
import { spawnSync } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_SIGNER_MARKER,
  createCommandSigner,
  createThrowawaySigner,
  keyIdOf,
  signerFromEnv,
  signManifest,
  THROWAWAY_MARKER,
  verifierFlags,
} from '../../infrastructure/scripts/release-signing.mjs';

// Each test starts Node at least once, on a machine that may be busy.
vi.setConfig({ testTimeout: 60_000 });

const here = dirname(fileURLToPath(import.meta.url));
const scripts = resolve(here, '..', '..', 'infrastructure', 'scripts');
const VERIFIER = join(scripts, 'verify-release.mjs');
const FAKE_SIGNER = join(here, 'fixtures', 'fake-signer.mjs');

const PLAIN_OK = 'OK: this release verified with no network access.';
const TEST_OK = 'OK (test key, not a release)';
const ALLOW = '--allow-test-key';

interface Signer {
  marker: string;
  publicKeyPem: string;
  keyId: string;
  sign(bytes: Buffer): string;
}

/** A signer holding a generated key, marked as a real one. It is what a real release looks like. */
function realSigner(): Signer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return {
    marker: COMMAND_SIGNER_MARKER,
    publicKeyPem,
    keyId: keyIdOf(publicKeyPem),
    sign: (bytes) => sign(null, bytes, privateKey).toString('base64'),
  };
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'ensemus-release-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

const SBOM = JSON.stringify({ packages: [{ name: 'example' }] });
const baseManifest = () => ({
  release: 'test',
  sboms: {
    web: {
      file: 'sbom-web.spdx.json',
      sha256: createHash('sha256').update(SBOM).digest('hex'),
      packages: 1,
    },
  },
});

/** Writes the signed parts of a release, as build-release.mjs does. */
function writeSigned(folder: string, manifest: object, signer: Signer) {
  const { bytes, signature } = signManifest(manifest, signer);
  writeFileSync(join(folder, 'release-manifest.json'), bytes);
  writeFileSync(join(folder, 'release-manifest.sig'), signature);
  writeFileSync(join(folder, 'release-signing-public.pem'), signer.publicKeyPem);
}

/** A complete release folder, with its public key beside it and a copy held outside it. */
function makeRelease(signer: Signer, name = 'release') {
  const folder = join(work, name);
  mkdirSync(folder);
  writeFileSync(join(folder, 'sbom-web.spdx.json'), SBOM);
  writeSigned(folder, baseManifest(), signer);
  const trustedKey = join(work, `${name}-trusted.pem`);
  writeFileSync(trustedKey, signer.publicKeyPem);
  return { folder, trustedKey };
}

/** Signs a manifest by hand, so a test can write what signManifest refuses to produce. */
function writeHandSigned(folder: string, manifest: object, signer: Signer) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(folder, 'release-manifest.json'), bytes);
  writeFileSync(join(folder, 'release-manifest.sig'), signer.sign(bytes));
}

function verifyRelease(...args: string[]) {
  const result = spawnSync(process.execPath, [VERIFIER, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A refusal is a clean failure, and never prints a stack trace or either kind of OK. */
function expectRefused(result: ReturnType<typeof verifyRelease>, reason: RegExp) {
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(reason);
  expect(result.stderr).toMatch(/^FAILED: /m);
  expect(result.stderr).not.toMatch(/\n\s+at /);
  expect(result.stdout).not.toContain('OK');
}

describe('verify-release: which key it trusts', () => {
  it('fails with no key named, although a good key sits in the folder', () => {
    const { folder } = makeRelease(realSigner());
    expect(existsSync(join(folder, 'release-signing-public.pem'))).toBe(true);
    expectRefused(verifyRelease(folder), /key from outside the release/);
  });

  it('fails with no key named for a test release too, flag or no flag', () => {
    const { folder } = makeRelease(createThrowawaySigner());
    expectRefused(verifyRelease(folder), /key from outside the release/);
    expectRefused(verifyRelease(folder, ALLOW), /key from outside the release/);
  });

  it('will not give a plain OK against the key sitting in the folder, even when named', () => {
    const { folder } = makeRelease(realSigner());
    expectRefused(
      verifyRelease(folder, join(folder, 'release-signing-public.pem')),
      /inside the release/,
    );
  });

  it('rejects a key swapped in the folder alongside a changed manifest, given the real key', () => {
    const { folder, trustedKey } = makeRelease(realSigner());
    const attacker = realSigner();
    const changed = { ...baseManifest(), release: 'changed-by-someone-else' };
    writeSigned(folder, changed, attacker);
    expect(readFileSync(join(folder, 'release-signing-public.pem'), 'utf8')).toBe(
      attacker.publicKeyPem,
    );
    expectRefused(verifyRelease(folder, trustedKey), /signature/);
  });

  it('shows that same swap would have passed if the folder key were believed', () => {
    // The control for the test above: the attacker's folder is good, except for whose key it is.
    const { folder } = makeRelease(realSigner());
    const attacker = realSigner();
    writeSigned(folder, baseManifest(), attacker);
    const attackerKey = join(work, 'attacker.pem');
    writeFileSync(attackerKey, attacker.publicKeyPem);
    expect(verifyRelease(folder, attackerKey).stdout).toContain(PLAIN_OK);
  });

  it('refuses a key of another type', () => {
    const { folder } = makeRelease(realSigner());
    const rsaKey = join(work, 'rsa.pem');
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(rsaKey, publicKey.export({ type: 'spki', format: 'pem' }));
    expectRefused(verifyRelease(folder, rsaKey), /Ed25519/);
  });

  it('fails cleanly when the named key cannot be read or parsed', () => {
    const { folder } = makeRelease(realSigner());
    expectRefused(verifyRelease(folder, join(work, 'no-such-key.pem')), /could not/);
    const notAKey = join(work, 'not-a-key.pem');
    writeFileSync(notAKey, 'not a key');
    expectRefused(verifyRelease(folder, notAKey), /could not/);
  });
});

describe('verify-release: a real release', () => {
  it('passes with a good signature, the right key and no test marker', () => {
    const { folder, trustedKey } = makeRelease(realSigner());
    const result = verifyRelease(folder, trustedKey);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(PLAIN_OK);
    expect(result.stdout).not.toContain(TEST_OK);
  });

  it('fails when signing_key_id is missing', () => {
    const signer = realSigner();
    const { folder, trustedKey } = makeRelease(signer);
    writeHandSigned(folder, { ...baseManifest(), signing: signer.marker }, signer);
    expectRefused(verifyRelease(folder, trustedKey), /signing_key_id/);
  });

  it('fails when signing_key_id names another key', () => {
    const signer = realSigner();
    const { folder, trustedKey } = makeRelease(signer);
    writeHandSigned(
      folder,
      { ...baseManifest(), signing: signer.marker, signing_key_id: realSigner().keyId },
      signer,
    );
    expectRefused(verifyRelease(folder, trustedKey), /signing_key_id/);
  });

  it('fails when the manifest does not say how it was signed', () => {
    const signer = realSigner();
    const { folder, trustedKey } = makeRelease(signer);
    writeHandSigned(folder, { ...baseManifest(), signing_key_id: signer.keyId }, signer);
    expectRefused(verifyRelease(folder, trustedKey), /signing/);
  });

  it('fails when the manifest lists no SBOMs, because there is then nothing to check', () => {
    const signer = realSigner();
    const { folder, trustedKey } = makeRelease(signer);
    writeSigned(folder, { release: 'test', sboms: {} }, signer);
    expectRefused(verifyRelease(folder, trustedKey), /sbom/);
  });

  it('fails on a bad signature', () => {
    const { folder, trustedKey } = makeRelease(realSigner());
    writeFileSync(join(folder, 'release-manifest.sig'), randomBytes(64).toString('base64'));
    expectRefused(verifyRelease(folder, trustedKey), /signature/);
  });

  it('fails on a changed manifest', () => {
    const { folder, trustedKey } = makeRelease(realSigner());
    const path = join(folder, 'release-manifest.json');
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
    expectRefused(verifyRelease(folder, trustedKey), /signature/);
  });

  it('fails on a changed SBOM', () => {
    const { folder, trustedKey } = makeRelease(realSigner());
    writeFileSync(join(folder, 'sbom-web.spdx.json'), `${SBOM}\n`);
    expectRefused(verifyRelease(folder, trustedKey), /sbom:web/);
  });

  it('fails on a missing SBOM and a missing signature, without a stack trace', () => {
    const missingSbom = makeRelease(realSigner(), 'missing-sbom');
    rmSync(join(missingSbom.folder, 'sbom-web.spdx.json'));
    expectRefused(verifyRelease(missingSbom.folder, missingSbom.trustedKey), /sbom:web/);

    const missingSig = makeRelease(realSigner(), 'missing-signature');
    rmSync(join(missingSig.folder, 'release-manifest.sig'));
    expectRefused(verifyRelease(missingSig.folder, missingSig.trustedKey), /could not/);
  });

  it('refuses arguments it does not know, so a typing slip cannot change what is checked', () => {
    const { folder, trustedKey } = makeRelease(realSigner());
    expectRefused(verifyRelease(folder, trustedKey, '--allow-test-keys'), /--allow-test-keys/);
    expectRefused(verifyRelease(folder, trustedKey, 'extra'), /extra/);
    expectRefused(verifyRelease(), /Usage/);
  });
});

describe('verify-release: a test key', () => {
  it('fails without the flag, and says it is a test release', () => {
    const { folder, trustedKey } = makeRelease(createThrowawaySigner());
    expectRefused(verifyRelease(folder, trustedKey), /test release/);
  });

  it('gives only the test OK with the flag', () => {
    const { folder, trustedKey } = makeRelease(createThrowawaySigner());
    const result = verifyRelease(folder, trustedKey, ALLOW);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(TEST_OK);
    expect(result.stdout).not.toContain(PLAIN_OK);
  });

  it('takes the flag before the key as well', () => {
    const { folder, trustedKey } = makeRelease(createThrowawaySigner());
    expect(verifyRelease(folder, ALLOW, trustedKey).stdout).toContain(TEST_OK);
  });

  it('fails when the flag is used on a release that is not test-marked', () => {
    const { folder, trustedKey } = makeRelease(realSigner());
    expectRefused(verifyRelease(folder, trustedKey, ALLOW), /--allow-test-key/);
  });

  it('still checks everything else with the flag', () => {
    const changedSbom = makeRelease(createThrowawaySigner(), 'changed-sbom');
    writeFileSync(join(changedSbom.folder, 'sbom-web.spdx.json'), `${SBOM}\n`);
    expectRefused(verifyRelease(changedSbom.folder, changedSbom.trustedKey, ALLOW), /sbom:web/);

    const changedManifest = makeRelease(createThrowawaySigner(), 'changed-manifest');
    const path = join(changedManifest.folder, 'release-manifest.json');
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('\n')]));
    expectRefused(
      verifyRelease(changedManifest.folder, changedManifest.trustedKey, ALLOW),
      /signature/,
    );

    const wrongKey = makeRelease(createThrowawaySigner(), 'wrong-key');
    const other = join(work, 'other.pem');
    writeFileSync(other, createThrowawaySigner().publicKeyPem);
    expectRefused(verifyRelease(wrongKey.folder, other, ALLOW), /signature/);
  });

  it('refuses a marker that nearly matches, with or without the flag', () => {
    // M6 follows this marker, so a copy that drifted must not read as a real release.
    const signer = { ...realSigner(), marker: 'THROWAWAY-TEST-KEY' };
    const { folder, trustedKey } = makeRelease(signer);
    expectRefused(verifyRelease(folder, trustedKey), /test release/);
    expectRefused(verifyRelease(folder, trustedKey, ALLOW), /test release/);
  });

  it('keeps the marker text that M6 follows, in both scripts', () => {
    expect(THROWAWAY_MARKER).toBe('THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION');
    expect(readFileSync(VERIFIER, 'utf8')).toContain(`'${THROWAWAY_MARKER}'`);
  });
});

describe('verify-release ships alone', () => {
  it('imports only node: modules', () => {
    const source = readFileSync(VERIFIER, 'utf8');
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\bimport\(\s*['"`]([^'"`]+)['"`]/g),
      ...source.matchAll(/\brequire\(\s*['"`]([^'"`]+)['"`]/g),
    ].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !specifier?.startsWith('node:'))).toEqual([]);
  });

  it('runs with nothing but itself beside it', () => {
    const { folder, trustedKey } = makeRelease(realSigner());
    const copy = join(folder, 'verify-release.mjs');
    copyFileSync(VERIFIER, copy);
    const result = spawnSync(process.execPath, [copy, folder, trustedKey], {
      encoding: 'utf8',
      cwd: folder,
    });
    expect(result.stdout).toContain(PLAIN_OK);
    expect(result.status).toBe(0);
  });
});

describe('keyIdOf', () => {
  it('is the SHA-256 of the SPKI DER bytes', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    expect(keyIdOf(pem)).toBe(createHash('sha256').update(der).digest('hex'));
  });

  it('is stable, including across changes to how the PEM is written', () => {
    const { publicKeyPem } = realSigner();
    expect(keyIdOf(publicKeyPem)).toBe(keyIdOf(publicKeyPem));
    expect(keyIdOf(publicKeyPem.replaceAll('\n', '\r\n'))).toBe(keyIdOf(publicKeyPem));
  });

  it('differs between keys', () => {
    expect(keyIdOf(realSigner().publicKeyPem)).not.toBe(keyIdOf(realSigner().publicKeyPem));
  });
});

describe('createThrowawaySigner', () => {
  it('is marked, names its key, and signs what verifies against that key', () => {
    const signer = createThrowawaySigner();
    expect(signer.marker).toBe(THROWAWAY_MARKER);
    expect(signer.keyId).toBe(keyIdOf(signer.publicKeyPem));
    const bytes = Buffer.from('some bytes');
    const signature = Buffer.from(signer.sign(bytes), 'base64');
    expect(verify(null, bytes, createPublicKey(signer.publicKeyPem), signature)).toBe(true);
  });

  it('never lets the private key out', () => {
    const signer = createThrowawaySigner();
    expect(Object.keys(signer).sort()).toEqual(['keyId', 'marker', 'publicKeyPem', 'sign']);
    expect(JSON.stringify(signer)).not.toContain('PRIVATE');
    expect(signer.publicKeyPem).not.toContain('PRIVATE');
  });

  it('is a new key each time', () => {
    expect(createThrowawaySigner().keyId).not.toBe(createThrowawaySigner().keyId);
  });
});

describe('createCommandSigner', () => {
  const canary = () => `sk-CANARY-${randomBytes(16).toString('hex')}`;

  /** Writes a generated key pair to the temporary folder and returns where. */
  function generatedKeyFiles(name = 'signer') {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyFile = join(work, `${name}-private.pem`);
    const publicKeyFile = join(work, `${name}-public.pem`);
    writeFileSync(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(publicKeyFile, publicKeyPem);
    return { publicKeyPem, privateKeyFile, publicKeyFile };
  }

  /** Sets the environment so Node, run with no arguments, behaves as the fake signer. */
  function stubFakeSigner(privateKeyFile: string, behaviour = 'sign', secret = '') {
    vi.stubEnv('NODE_OPTIONS', `--import=${pathToFileURL(FAKE_SIGNER).href}`);
    vi.stubEnv('ENSEMUS_TEST_FAKE_SIGNER_KEY_FILE', privateKeyFile);
    vi.stubEnv('ENSEMUS_TEST_FAKE_SIGNER_BEHAVIOUR', behaviour);
    vi.stubEnv('ENSEMUS_TEST_FAKE_SIGNER_SECRET', secret);
  }

  /** Everything a thrown error could carry into a log. */
  function everythingThrownBy(run: () => unknown) {
    try {
      run();
    } catch (error) {
      const failure = error as Error;
      return [
        failure.message,
        failure.stack,
        String(failure.cause),
        JSON.stringify(failure),
        JSON.stringify(Object.getOwnPropertyDescriptors(failure)),
      ].join('\n');
    }
    throw new Error('expected this to throw');
  }

  it('signs what it is given on standard input, and a real-marked release verifies', () => {
    const { publicKeyPem, privateKeyFile } = generatedKeyFiles();
    stubFakeSigner(privateKeyFile);
    const signer = createCommandSigner({ command: process.execPath, publicKeyPem });
    expect(signer.marker).toBe(COMMAND_SIGNER_MARKER);
    expect(signer.marker).not.toBe(THROWAWAY_MARKER);
    expect(signer.keyId).toBe(keyIdOf(publicKeyPem));

    const { folder, trustedKey } = makeRelease(signer);
    vi.unstubAllEnvs();
    const result = verifyRelease(folder, trustedKey);
    expect(result.stdout).toContain(PLAIN_OK);
    expect(result.status).toBe(0);
  });

  it('fails when the command exits non-zero', () => {
    const { publicKeyPem, privateKeyFile } = generatedKeyFiles();
    stubFakeSigner(privateKeyFile, 'exit-nonzero');
    const signer = createCommandSigner({ command: process.execPath, publicKeyPem });
    expect(() => signer.sign(Buffer.from('bytes'))).toThrow(/exited with status 3/);
  });

  it('fails when the command returns garbage', () => {
    const { publicKeyPem, privateKeyFile } = generatedKeyFiles();
    stubFakeSigner(privateKeyFile, 'garbage');
    const signer = createCommandSigner({ command: process.execPath, publicKeyPem });
    expect(() => signer.sign(Buffer.from('bytes'))).toThrow(/did not return/);
  });

  it('fails when the command returns base64 of the wrong length', () => {
    const { publicKeyPem, privateKeyFile } = generatedKeyFiles();
    stubFakeSigner(privateKeyFile, 'too-short');
    const signer = createCommandSigner({ command: process.execPath, publicKeyPem });
    expect(() => signer.sign(Buffer.from('bytes'))).toThrow(/did not return/);
  });

  it('fails when the command signs with the wrong key, and returns nothing to write', () => {
    const { publicKeyPem } = generatedKeyFiles('expected');
    const { privateKeyFile: wrongKey } = generatedKeyFiles('wrong');
    stubFakeSigner(wrongKey);
    const signer = createCommandSigner({ command: process.execPath, publicKeyPem });
    expect(() => signManifest(baseManifest(), signer)).toThrow(/does not verify/);
  });

  it('fails when the command does not exist, or runs too long', () => {
    const { publicKeyPem, privateKeyFile } = generatedKeyFiles();
    const missing = createCommandSigner({ command: join(work, 'no-such-signer'), publicKeyPem });
    expect(() => missing.sign(Buffer.from('bytes'))).toThrow(/did not run: ENOENT/);

    stubFakeSigner(privateKeyFile, 'hang');
    const slow = createCommandSigner({
      command: process.execPath,
      publicKeyPem,
      timeoutMs: 2_000,
    });
    expect(() => slow.sign(Buffer.from('bytes'))).toThrow(/did not run: ETIMEDOUT/);
  });

  it.each([
    ['on stderr, failing', 'secret-on-stderr-and-fail'],
    ['on stdout, failing', 'secret-on-stdout-and-fail'],
    ['in place of a signature', 'secret-instead-of-signature'],
  ])('does not repeat a secret the command wrote %s', (_, behaviour) => {
    const secret = canary();
    const { publicKeyPem, privateKeyFile } = generatedKeyFiles();
    stubFakeSigner(privateKeyFile, behaviour, secret);
    const signer = createCommandSigner({ command: process.execPath, publicKeyPem });
    expect(everythingThrownBy(() => signer.sign(Buffer.from('bytes')))).not.toContain(secret);
  });

  it('does not pass what the command wrote on stderr through to its own output', () => {
    // A thrown message is only half of it. A stderr left inherited would reach a CI log directly.
    const secret = canary();
    const { publicKeyPem, privateKeyFile } = generatedKeyFiles();
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { createCommandSigner } from ${JSON.stringify(
          pathToFileURL(join(scripts, 'release-signing.mjs')).href,
        )};
         const signer = createCommandSigner({
           command: process.execPath,
           publicKeyPem: process.env.TEST_PUBLIC_KEY,
         });
         process.env.NODE_OPTIONS = process.env.TEST_NODE_OPTIONS;
         signer.sign(Buffer.from('bytes'));
         process.env.ENSEMUS_TEST_FAKE_SIGNER_BEHAVIOUR = 'secret-on-stderr-and-fail';
         signer.sign(Buffer.from('bytes'));`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEST_PUBLIC_KEY: publicKeyPem,
          TEST_NODE_OPTIONS: `--import=${pathToFileURL(FAKE_SIGNER).href}`,
          ENSEMUS_TEST_FAKE_SIGNER_KEY_FILE: privateKeyFile,
          ENSEMUS_TEST_FAKE_SIGNER_BEHAVIOUR: 'secret-on-stderr-and-sign',
          ENSEMUS_TEST_FAKE_SIGNER_SECRET: secret,
        },
      },
    );
    // The first call succeeded and the second failed, so both paths ran and neither printed it.
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('exited with status 1');
    expect(child.stdout).not.toContain(secret);
    expect(child.stderr).not.toContain(secret);
  });

  it('uses no shell, so a command line is a name that does not exist and runs nothing', () => {
    const touched = join(work, 'touched');
    const { publicKeyPem } = generatedKeyFiles();
    const signer = createCommandSigner({
      command: `"${process.execPath}" -e "require('fs').writeFileSync('${touched.replaceAll('\\', '/')}','x')"`,
      publicKeyPem,
    });
    expect(() => signer.sign(Buffer.from('bytes'))).toThrow(/did not run/);
    expect(existsSync(touched)).toBe(false);
  });

  it('refuses a private key named as the public key, so it can never reach the folder', () => {
    const { privateKeyFile } = generatedKeyFiles();
    const pem = readFileSync(privateKeyFile, 'utf8');
    const body = pem.split('\n')[1] ?? '';
    expect(body).not.toBe('');
    const text = everythingThrownBy(() =>
      createCommandSigner({ command: process.execPath, publicKeyPem: pem }),
    );
    expect(text).toMatch(/private key/);
    expect(text).not.toContain(body);
  });

  it('refuses a key of another type, and text that is not a key', () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() =>
      createCommandSigner({
        command: process.execPath,
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      }),
    ).toThrow(/Ed25519/);
    expect(() =>
      createCommandSigner({ command: process.execPath, publicKeyPem: 'not a key' }),
    ).toThrow(/public key/);
  });
});

describe('signerFromEnv', () => {
  const COMMAND = 'ENSEMUS_RELEASE_SIGNER_COMMAND';
  const KEY_FILE = 'ENSEMUS_RELEASE_PUBLIC_KEY_FILE';

  it('is null with neither set, so the caller falls back to a marked throwaway', () => {
    expect(signerFromEnv({})).toBeNull();
    expect(signerFromEnv({ [COMMAND]: '', [KEY_FILE]: '' })).toBeNull();
  });

  it('throws with only the command set, and does not repeat its value', () => {
    const value = 'signer-path-should-not-be-repeated';
    expect(() => signerFromEnv({ [COMMAND]: value })).toThrow(KEY_FILE);
    expect(() => signerFromEnv({ [COMMAND]: value, [KEY_FILE]: '' })).toThrow(KEY_FILE);
    expect(() => signerFromEnv({ [COMMAND]: value })).not.toThrow(value);
  });

  it('throws with only the key file set', () => {
    expect(() => signerFromEnv({ [KEY_FILE]: join(work, 'key.pem') })).toThrow(COMMAND);
    expect(() => signerFromEnv({ [KEY_FILE]: join(work, 'key.pem'), [COMMAND]: '' })).toThrow(
      COMMAND,
    );
  });

  it('makes a command signer with both, reading the public key from the file', () => {
    const signer = realSigner();
    const keyFile = join(work, 'public.pem');
    writeFileSync(keyFile, signer.publicKeyPem);
    const fromEnv = signerFromEnv({ [COMMAND]: process.execPath, [KEY_FILE]: keyFile });
    expect(fromEnv?.marker).toBe(COMMAND_SIGNER_MARKER);
    expect(fromEnv?.keyId).toBe(signer.keyId);
  });

  it('throws when the named file cannot be read', () => {
    expect(() =>
      signerFromEnv({ [COMMAND]: process.execPath, [KEY_FILE]: join(work, 'missing.pem') }),
    ).toThrow(KEY_FILE);
  });
});

describe('signManifest', () => {
  it('adds how it was signed and by which key, and signs exactly the bytes it returns', () => {
    const signer = realSigner();
    const { bytes, signature } = signManifest(baseManifest(), signer);
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    expect(parsed.signing).toBe(signer.marker);
    expect(parsed.signing_key_id).toBe(signer.keyId);
    expect(parsed.release).toBe('test');
    expect(
      verify(
        null,
        bytes,
        createPublicKey(signer.publicKeyPem),
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true);
  });

  it('overwrites anything the manifest already claimed about its signing', () => {
    const signer = createThrowawaySigner();
    const { bytes } = signManifest(
      { ...baseManifest(), signing: 'a-real-key', signing_key_id: 'someone-else' },
      signer,
    );
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    expect(parsed.signing).toBe(THROWAWAY_MARKER);
    expect(parsed.signing_key_id).toBe(signer.keyId);
  });

  it('does not change the manifest it was given', () => {
    const manifest = baseManifest();
    signManifest(manifest, realSigner());
    expect(manifest).toEqual(baseManifest());
  });

  it('throws when the signature does not verify against the public key', () => {
    const signer = realSigner();
    const other = realSigner();
    expect(() => signManifest(baseManifest(), { ...signer, sign: other.sign })).toThrow(
      /does not verify/,
    );
    expect(() => signManifest(baseManifest(), { ...signer, sign: () => 'garbage' })).toThrow(
      /does not verify/,
    );
  });

  it('throws when the key ID it would write is not the ID of the public key', () => {
    const signer = realSigner();
    expect(() =>
      signManifest(baseManifest(), { ...signer, keyId: realSigner().keyId }),
    ).toThrow(/key ID/);
  });
});

describe('what build-release.mjs does with these', () => {
  // The script needs built images and Docker, so its decisions are checked here and its source is
  // read for the rest. The end-to-end did not run, and these do not stand in for it.
  const source = readFileSync(join(scripts, 'build-release.mjs'), 'utf8');

  it('passes the test-key flag only for the throwaway', () => {
    expect(verifierFlags(createThrowawaySigner())).toEqual([ALLOW]);
    expect(verifierFlags(realSigner())).toEqual([]);
  });

  it('parses, on plain Node', () => {
    const result = spawnSync(process.execPath, ['--check', join(scripts, 'build-release.mjs')], {
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([
    'tampered manifest',
    'tampered SBOM',
    'test release with no flag',
    'real-marked manifest with the flag',
  ])('keeps the control: %s', (label) => {
    expect(source).toContain(label);
    expect(source).toContain('Control, ${label}');
  });

  it('holds no private key of its own, and writes only what a signer exposes', () => {
    expect(source).not.toMatch(/generateKeyPair|createPrivateKey|privateKey/);
    expect(source).toContain('signerFromEnv(process.env) ?? createThrowawaySigner()');
  });
});
