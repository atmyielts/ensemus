// QA-022, DEP-TS-02, SEC-012: every way a bundle can be wrong, in a temp folder, with generated keys.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, type TestContext } from 'vitest';
import {
  BUNDLE_MANIFEST_FILE,
  isInsideFolder,
  KNOWN_ROLLBACK_CONSTRAINTS,
  verifyBundleDirectory,
} from './bundle';
import { generateTestSigningKey, signForTest, testTrustRoot } from './testing';

const bundleKey = { ...generateTestSigningKey('bundle-key'), purposes: ['bundle'] as const };
const licenseKey = { ...generateTestSigningKey('license-key'), purposes: ['license'] as const };
const root = testTrustRoot([bundleKey, licenseKey]);

const DIGEST = `sha256:${'a'.repeat(64)}`;
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

const CONTENT: Record<string, { text: string; role: string }> = {
  'images/web.tar': { text: 'pretend image archive', role: 'image' },
  'compose/compose.yaml': { text: 'services: {}\n', role: 'compose' },
  'notices/third-party.txt': { text: 'notices\n', role: 'notice' },
};

function manifestFor(overrides: Record<string, unknown> = {}) {
  return {
    format: 'ensemus.bundle',
    format_version: 1,
    bundle_id: '6f1c2c6e-3333-4333-8333-333333333333',
    issued_at: '2027-01-01T00:00:00.000Z',
    release: {
      version: '2.0.1',
      line: '2.0',
      kind: 'patch',
      security: false,
      published_on: '2027-01-01',
      git_commit: 'b'.repeat(40),
    },
    files: Object.entries(CONTENT).map(([path, { text, role }]) => ({
      path,
      sha256: sha256(text),
      bytes: Buffer.byteLength(text),
      role,
    })),
    images: [{ name: 'web', digest: DIGEST, file: 'images/web.tar' }],
    compatibility: {
      upgrade_from: ['2.0.0'],
      rollback_to: ['2.0.0'],
      rollback_constraints: [],
      database_schema_version: '0301_sovereign_security.sql',
      workflow_compatibility: 'replay corpus of this release',
      node_version: '24',
    },
    models: [],
    ...overrides,
  };
}

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const tempFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), 'ensemus-bundle-'));
  folders.push(folder);
  return folder;
};

/** A good bundle, unless a test passes something else to sign. */
function makeBundle(
  document: object = manifestFor(),
  keys: readonly Parameters<typeof signForTest>[2][number][] = [bundleKey],
) {
  const folder = tempFolder();
  for (const [path, { text }] of Object.entries(CONTENT)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  writeFileSync(join(folder, BUNDLE_MANIFEST_FILE), signForTest('bundle', document, keys));
  return folder;
}

/** A symbolic link to a file needs a privilege on Windows that a test run may not have. */
function fileLinkOrSkip(context: TestContext, target: string, path: string) {
  try {
    symlinkSync(target, path, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip();
    throw error;
  }
}

describe('a good bundle', () => {
  it('is accepted, and says it was signed with a test key', async () => {
    const verdict = await verifyBundleDirectory(makeBundle(), root);
    expect(verdict).toMatchObject({ ok: true, keyIds: ['bundle-key'], testKey: true });
    if (verdict.ok) expect(verdict.manifest.release.version).toBe('2.0.1');
  });

  it('may hold an empty file, since it is listed and hashed like any other', async () => {
    const folder = tempFolder();
    writeFileSync(join(folder, 'empty.txt'), '');
    writeFileSync(join(folder, 'image.tar'), 'x');
    writeFileSync(
      join(folder, BUNDLE_MANIFEST_FILE),
      signForTest(
        'bundle',
        manifestFor({
          files: [
            { path: 'empty.txt', sha256: sha256(''), bytes: 0, role: 'documentation' },
            { path: 'image.tar', sha256: sha256('x'), bytes: 1, role: 'image' },
          ],
          images: [{ name: 'web', digest: DIGEST, file: 'image.tar' }],
        }),
        [bundleKey],
      ),
    );
    expect(await verifyBundleDirectory(folder, root)).toMatchObject({ ok: true });
  });
});

describe('the files', () => {
  it('refuses a changed byte, with the size the same', async () => {
    const folder = makeBundle();
    writeFileSync(join(folder, 'images/web.tar'), 'Pretend image archive');
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'FILE_CHANGED',
      path: 'images/web.tar',
    });
  });

  it('refuses a changed size', async () => {
    const folder = makeBundle();
    appendFileSync(join(folder, 'compose/compose.yaml'), '# one more line\n');
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'FILE_CHANGED',
      path: 'compose/compose.yaml',
    });
  });

  it('refuses a removed file', async () => {
    const folder = makeBundle();
    rmSync(join(folder, 'notices/third-party.txt'));
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'FILE_MISSING',
      path: 'notices/third-party.txt',
    });
  });

  it('refuses an added file', async () => {
    const folder = makeBundle();
    writeFileSync(join(folder, 'compose/extra.yaml'), 'services: {}\n');
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'FILE_NOT_LISTED',
      path: 'compose/extra.yaml',
    });
  });

  it('refuses an added folder, even an empty one, because it was not signed either', async () => {
    const folder = makeBundle();
    mkdirSync(join(folder, 'plugins'));
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'FILE_NOT_LISTED',
      path: 'plugins',
    });
  });

  it('refuses a name that differs only by case, on any file system', async () => {
    const folder = makeBundle();
    rmSync(join(folder, 'notices/third-party.txt'));
    writeFileSync(
      join(folder, 'notices/Third-Party.txt'),
      CONTENT['notices/third-party.txt']!.text,
    );
    expect(await verifyBundleDirectory(folder, root)).toMatchObject({
      ok: false,
      code: 'FILE_NOT_LISTED',
    });
  });

  it('refuses a file whose listed hash differs from what is there', async () => {
    const document = manifestFor();
    document.files[0]!.sha256 = 'f'.repeat(64);
    expect(await verifyBundleDirectory(makeBundle(document), root)).toEqual({
      ok: false,
      code: 'FILE_CHANGED',
      path: 'images/web.tar',
    });
  });

  it('finds out what is on disk before opening anything the manifest names', async () => {
    // A reserved or odd name in a signed manifest is still only a name: it is looked up in what the walk
    // found, so the verifier never opens a path just because a manifest asked it to.
    const document = manifestFor();
    document.files.push({ path: 'nul', sha256: sha256(''), bytes: 0, role: 'documentation' });
    expect(await verifyBundleDirectory(makeBundle(document), root)).toEqual({
      ok: false,
      code: 'FILE_MISSING',
      path: 'nul',
    });
  });
});

describe('links', () => {
  it('refuses a link to a folder, and does not follow it', async () => {
    const folder = makeBundle();
    const outside = tempFolder();
    writeFileSync(join(outside, 'planted.txt'), 'never read');
    symlinkSync(outside, join(folder, 'notices/linked'), 'junction');
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'LINK_REFUSED',
      path: 'notices/linked',
    });
  });

  it('refuses a listed file replaced by a link to one with the same bytes', async (context) => {
    const folder = makeBundle();
    const outside = tempFolder();
    writeFileSync(join(outside, 'web.tar'), CONTENT['images/web.tar']!.text);
    rmSync(join(folder, 'images/web.tar'));
    fileLinkOrSkip(context, join(outside, 'web.tar'), join(folder, 'images/web.tar'));
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'LINK_REFUSED',
      path: 'images/web.tar',
    });
  });

  it('refuses a manifest that is itself a link', async (context) => {
    const folder = makeBundle();
    const outside = tempFolder();
    writeFileSync(join(outside, 'manifest'), signForTest('bundle', manifestFor(), [bundleKey]));
    rmSync(join(folder, BUNDLE_MANIFEST_FILE));
    fileLinkOrSkip(context, join(outside, 'manifest'), join(folder, BUNDLE_MANIFEST_FILE));
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'LINK_REFUSED',
      path: BUNDLE_MANIFEST_FILE,
    });
  });

  it('refuses a bundle folder that is a link', async () => {
    const parent = tempFolder();
    const link = join(parent, 'link');
    symlinkSync(makeBundle(), link, 'junction');
    expect(await verifyBundleDirectory(link, root)).toEqual({
      ok: false,
      code: 'LINK_REFUSED',
      path: '.',
    });
  });
});

describe('the signature comes first', () => {
  it('refuses a folder with no manifest', async () => {
    const folder = makeBundle();
    rmSync(join(folder, BUNDLE_MANIFEST_FILE));
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'MANIFEST_MISSING',
    });
  });

  it('refuses a folder that does not exist', async () => {
    expect(await verifyBundleDirectory(join(tempFolder(), 'nothing'), root)).toEqual({
      ok: false,
      code: 'MANIFEST_MISSING',
    });
  });

  it('refuses a manifest signed by a key nobody trusts', async () => {
    const stranger = generateTestSigningKey('stranger');
    expect(await verifyBundleDirectory(makeBundle(manifestFor(), [stranger]), root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'UNKNOWN_KEY',
    });
  });

  it('refuses a bundle-purpose key that this trust root does not hold', async () => {
    const elsewhere = { ...generateTestSigningKey('elsewhere'), purposes: ['bundle'] as const };
    const signed = makeBundle(manifestFor(), [elsewhere]);
    expect(await verifyBundleDirectory(signed, testTrustRoot([bundleKey]))).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'UNKNOWN_KEY',
    });
  });

  it('refuses a key claiming to be a trusted one, because the signature does not match', async () => {
    const impostor = generateTestSigningKey('bundle-key');
    expect(await verifyBundleDirectory(makeBundle(manifestFor(), [impostor]), root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'BAD_SIGNATURE',
    });
  });

  it('refuses a license-purpose key signing a bundle', async () => {
    expect(await verifyBundleDirectory(makeBundle(manifestFor(), [licenseKey]), root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'WRONG_PURPOSE',
    });
  });

  it('refuses a license passed off as a bundle manifest', async () => {
    const folder = makeBundle();
    writeFileSync(
      join(folder, BUNDLE_MANIFEST_FILE),
      signForTest('license', manifestFor(), [bundleKey]),
    );
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'WRONG_TYPE',
    });
  });

  it('refuses a manifest whose payload was edited after signing', async () => {
    const folder = makeBundle();
    const signed = JSON.parse(signForTest('bundle', manifestFor(), [bundleKey])) as {
      payload: string;
    };
    signed.payload = Buffer.from(JSON.stringify(manifestFor({ models: [] }), null, 1)).toString(
      'base64',
    );
    writeFileSync(join(folder, BUNDLE_MANIFEST_FILE), JSON.stringify(signed));
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'BAD_SIGNATURE',
    });
  });

  it('refuses a manifest signed after its key was retired', async () => {
    const retired = {
      ...generateTestSigningKey('retired'),
      purposes: ['bundle'] as const,
      retiredOn: '2026-06-01',
    };
    const folder = makeBundle(manifestFor(), [retired]);
    expect(await verifyBundleDirectory(folder, testTrustRoot([retired]))).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'KEY_NOT_VALID_FOR_THIS_DATE',
    });
  });

  it('refuses a manifest too big to be one, without reading it', async () => {
    const folder = makeBundle();
    writeFileSync(join(folder, BUNDLE_MANIFEST_FILE), Buffer.alloc(16 * 1024 * 1024 + 1, 32));
    expect(await verifyBundleDirectory(folder, root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'TOO_LARGE',
    });
  });

  it('looks at nothing else until the signature has passed', async () => {
    // Everything is wrong here. Only the signature gets reported, so a forged manifest learns nothing.
    const folder = makeBundle(manifestFor(), [generateTestSigningKey('stranger')]);
    writeFileSync(join(folder, 'unlisted.txt'), 'x');
    rmSync(join(folder, 'images/web.tar'));
    expect(await verifyBundleDirectory(folder, root)).toMatchObject({
      code: 'MANIFEST_REFUSED',
    });
  });
});

describe('what a signed manifest may say', () => {
  it.each([
    ['climbing out', '../outside.txt'],
    ['climbing out from inside', 'images/../../outside.txt'],
    ['a dot-dot in a name', 'images/a..b.tar'],
    ['an absolute path', '/etc/passwd'],
    ['a Windows path', 'C:\\Windows\\win.ini'],
    ['a backslash', 'images\\web.tar'],
    ['an empty segment', 'images//web.tar'],
    ['a capital letter', 'images/Web.tar'],
  ])('refuses %s in a path, even when properly signed', async (_label, path) => {
    const document = manifestFor();
    document.files.push({ path, sha256: sha256(''), bytes: 0, role: 'documentation' });
    expect(await verifyBundleDirectory(makeBundle(document), root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'CONTENT_INVALID',
    });
  });

  it('refuses a path with .. in an image entry', async () => {
    const document = manifestFor({
      images: [{ name: 'web', digest: DIGEST, file: '../images/web.tar' }],
    });
    expect(await verifyBundleDirectory(makeBundle(document), root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'CONTENT_INVALID',
    });
  });

  it('refuses a digest that is not one', async () => {
    const document = manifestFor({
      images: [{ name: 'web', digest: 'sha256:short', file: 'images/web.tar' }],
    });
    expect(await verifyBundleDirectory(makeBundle(document), root)).toMatchObject({
      code: 'MANIFEST_REFUSED',
      reason: 'CONTENT_INVALID',
    });
  });

  it('refuses a newer format by name, and changes nothing about what is installed', async () => {
    const document = manifestFor({ format_version: 2 });
    expect(await verifyBundleDirectory(makeBundle(document), root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'FORMAT_NOT_SUPPORTED',
    });
  });

  it('refuses a file listed twice, since which entry counts would be a guess', async () => {
    const document = manifestFor();
    document.files.push({ ...document.files[0]! });
    expect(await verifyBundleDirectory(makeBundle(document), root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'CONTENT_INVALID',
    });
  });

  it('refuses a manifest that lists itself, since it cannot hold its own hash', async () => {
    const document = manifestFor();
    document.files.push({
      path: BUNDLE_MANIFEST_FILE,
      sha256: sha256(''),
      bytes: 0,
      role: 'documentation',
    });
    expect(await verifyBundleDirectory(makeBundle(document), root)).toEqual({
      ok: false,
      code: 'MANIFEST_REFUSED',
      reason: 'CONTENT_INVALID',
    });
  });

  it('refuses an image whose file is not listed at all', async () => {
    const document = manifestFor({
      images: [{ name: 'web', digest: DIGEST, file: 'images/worker.tar' }],
    });
    expect(await verifyBundleDirectory(makeBundle(document), root)).toEqual({
      ok: false,
      code: 'IMAGE_NOT_LISTED',
      path: 'images/worker.tar',
    });
  });

  it('refuses an image whose file is listed with another role', async () => {
    const document = manifestFor({
      images: [{ name: 'web', digest: DIGEST, file: 'notices/third-party.txt' }],
    });
    expect(await verifyBundleDirectory(makeBundle(document), root)).toEqual({
      ok: false,
      code: 'IMAGE_NOT_LISTED',
      path: 'notices/third-party.txt',
    });
  });
});

describe('a trust root inside the bundle', () => {
  it('is found directly inside, further down, and through a name with a dot', async () => {
    const folder = makeBundle();
    expect(await isInsideFolder(join(folder, 'trust-root.json'), folder)).toBe(true);
    expect(await isInsideFolder(join(folder, 'notices/trust-root.json'), folder)).toBe(true);
    expect(await isInsideFolder(join(folder, 'notices', '..', 'x.json'), folder)).toBe(true);
    expect(await isInsideFolder(folder, folder)).toBe(true);
  });

  it('is not confused by a sibling whose name starts the same', async () => {
    const folder = makeBundle();
    expect(await isInsideFolder(`${folder}-trust-root.json`, folder)).toBe(false);
    expect(await isInsideFolder(join(folder, '..', 'trust-root.json'), folder)).toBe(false);
    expect(await isInsideFolder(join(tempFolder(), 'trust-root.json'), folder)).toBe(false);
  });

  it('is found through a link pointing into the bundle', async () => {
    const folder = makeBundle();
    const parent = tempFolder();
    symlinkSync(join(folder, 'notices'), join(parent, 'looks-outside'), 'junction');
    expect(await isInsideFolder(join(parent, 'looks-outside', 'trust-root.json'), folder)).toBe(
      true,
    );
  });
});

describe('rollback constraint codes', () => {
  it('fit the format a manifest allows', () => {
    for (const code of Object.keys(KNOWN_ROLLBACK_CONSTRAINTS)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
    }
  });
});
