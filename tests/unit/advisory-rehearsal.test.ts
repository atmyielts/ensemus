// SOV-04, walked whole with generated keys and no network: issue a signed advisory and a patched bundle
// manifest, verify both offline with only what a customer holds, refuse forgeries, and work out rights against
// the bundle. No key here is real, and the rights are test values. This is a rehearsal of the process and says
// nothing about any real deployment.
//
// The customer's own tools are proved here too, since they are the same promise from the other side: someone
// with Node and a file needs nothing from us. They cannot sit beside what they test, because every file in
// their folder gets bundled and shipped, and this is where the archive's contract can be reached.
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { exportManifestSchema } from '@ensemus/contracts/portability-records';
import {
  evaluateUpdateRight,
  licenseNotices,
  maintenanceStatus,
  type ReleaseFacts,
} from '@ensemus/domain/license';
import {
  EXPORT_MANIFEST_PATH,
  recordPartPath,
  artifactPartPath,
} from '@ensemus/domain/portability';
import type { BundleManifest } from '@ensemus/sovereign/documents';
import {
  createRehearsalFileSigner,
  issueDocument,
  runIssuerCommand,
  type DocumentSigner,
  type IssuerIo,
} from '@ensemus/sovereign/issuer';
import {
  exportRecipientPublicKey,
  generateRecipientKeyPair,
  open,
  parseRecipientPrivateKey,
  parseRecipientPublicKey,
  recipientKeyId,
  seal,
} from '@ensemus/sovereign/sealed';
import { tarEnd, tarHeader, tarPadding } from '@ensemus/sovereign/tar';
import {
  generateTestSigningKey,
  signForTest,
  testLicense,
  testMaintenance,
} from '@ensemus/sovereign/testing';
import {
  parseTrustRoot,
  type DocumentPurpose,
  type TrustRoot,
} from '@ensemus/sovereign/trust-root';
import { verifyDocument } from '@ensemus/sovereign/verify';
import { createLogger } from '@ensemus/telemetry';
import { readReleaseFacts } from '../../workers/workflow/src/diagnostics-command';
import { openArchive, openArchiveCommand } from '../../workers/workflow/src/tools/open-archive';
import {
  recipientKeyCommand,
  writeRecipientKey,
} from '../../workers/workflow/src/tools/recipient-key';

const folder = mkdtempSync(join(tmpdir(), 'advisory-rehearsal-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const inFolder = (name = randomUUID()) => join(folder, name);

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** The tool's own keygen, so the rehearsal starts where a real one would. */
async function generatedKey(keyId: string, purposes: readonly DocumentPurpose[]) {
  const privateKeyPemFile = inFolder(`${keyId}-${randomUUID()}.pem`);
  const lines: string[] = [];
  const io: IssuerIo = {
    readFile: async (path) => readFileSync(path),
    writeFile: async (path, data) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 }),
    appendFile: async () => undefined,
    out: (line) => lines.push(line),
    err: (line) => {
      throw new Error(line);
    },
    now: () => new Date(),
  };
  const status = await runIssuerCommand(
    ['keygen', '--key-id', keyId, '--purposes', purposes.join(','), '--out', privateKeyPemFile],
    io,
  );
  expect(status).toBe(0);
  const signer = createRehearsalFileSigner({ keyId, privateKeyPemFile, rehearsal: true });
  return {
    signer,
    entry: JSON.parse(lines[0] as string) as Record<string, unknown>,
    privateKeyPemFile,
  };
}

const rootOf = (...entries: readonly Record<string, unknown>[]): TrustRoot =>
  parseTrustRoot(
    JSON.stringify({ format: 'ensemus.trust_root', format_version: 1, keys: entries }),
  );

const advisory = {
  format: 'ensemus.advisory',
  format_version: 1,
  advisory_id: 'ENS-REHEARSAL-1',
  issued_at: '2028-02-01T00:00:00.000Z',
  severity: 'high',
  title: 'Generated advisory title',
  summary: 'A generated advisory, for this rehearsal only.',
  affected_versions: ['2.0.0'],
  fixed_in_versions: ['2.0.1'],
} as const;

const patchRelease = {
  version: '2.0.1',
  line: '2.0',
  kind: 'patch',
  security: true,
  published_on: '2028-02-01',
  git_commit: 'a'.repeat(40),
} as const;

const patchManifest = (release: BundleManifest['release'] = patchRelease): BundleManifest => ({
  format: 'ensemus.bundle',
  format_version: 1,
  bundle_id: randomUUID(),
  issued_at: '2028-02-01T00:00:00.000Z',
  release,
  files: [
    { path: 'images/web.tar', sha256: sha256('web'), bytes: 3, role: 'image' },
    { path: 'images/worker.tar', sha256: sha256('worker'), bytes: 6, role: 'image' },
  ],
  images: [
    { name: 'web', digest: `sha256:${sha256('web')}`, file: 'images/web.tar' },
    { name: 'worker', digest: `sha256:${sha256('worker')}`, file: 'images/worker.tar' },
  ],
  compatibility: {
    upgrade_from: ['2.0.0'],
    rollback_to: ['2.0.0'],
    rollback_constraints: [],
    database_schema_version: '0301_sovereign_security.sql',
    workflow_compatibility: 'Generated value for rehearsal',
    node_version: '24',
  },
  models: [],
});

describe('the advisory rehearsal', () => {
  it('walks the whole process, offline, with generated keys', async () => {
    const { signer: advisoryKey, entry: advisoryEntry } = await generatedKey('adv-1', ['advisory']);
    const { signer: bundleKey, entry: bundleEntry } = await generatedKey('bundle-1', ['bundle']);
    const { signer: licenseKey, entry: licenseEntry } = await generatedKey('lic-1', [
      'license',
      'maintenance',
    ]);
    // Everything from here on uses only public keys, as a customer's machine has.
    const customerRoot = rootOf(advisoryEntry, bundleEntry, licenseEntry);

    const signedAdvisory = await issueDocument('advisory', advisory, [advisoryKey]);
    const signedBundle = await issueDocument('bundle', patchManifest(), [bundleKey]);
    const signedLicense = await issueDocument('license', testLicense() as never, [licenseKey]);
    const signedMaintenance = await issueDocument('maintenance', testMaintenance() as never, [
      licenseKey,
    ]);

    const readAdvisory = verifyDocument('advisory', signedAdvisory, customerRoot);
    const readBundle = verifyDocument('bundle', signedBundle, customerRoot);
    const readLicense = verifyDocument('license', signedLicense, customerRoot);
    const readMaintenance = verifyDocument('maintenance', signedMaintenance, customerRoot);
    if (!readAdvisory.ok || !readBundle.ok || !readLicense.ok || !readMaintenance.ok) {
      throw new Error('A rehearsal document did not verify');
    }
    // It says plainly that it was signed with a test key, everywhere it is shown.
    expect(readAdvisory.testKey).toBe(true);
    expect(readBundle.testKey).toBe(true);

    // The advisory points at the bundle, and the bundle says it fixes what the advisory names.
    expect(readAdvisory.document.fixed_in_versions).toContain(readBundle.document.release.version);
    expect(readAdvisory.document.affected_versions).toContain(
      readLicense.document.licensed_release.version,
    );

    // Maintenance ended in 2027 and the patch came out in 2028, so these narrow rights do not cover it.
    const verdict = evaluateUpdateRight({
      license: readLicense.document,
      agreements: [readMaintenance.document],
      policies: [],
      release: readBundle.document.release,
      today: '2028-03-01',
    });
    expect(verdict).toEqual({ covered: false, basis: null, onInstall: 'warn' });

    // And nothing here can stop what is running: the only output is notices.
    const notices = licenseNotices({
      standing: 'licensed',
      license: readLicense.document,
      maintenance: maintenanceStatus([readMaintenance.document], '2028-03-01'),
      today: '2028-03-01',
      signedWithTestKey: readLicense.testKey,
      signedWithRetiredKey: false,
      runningReleaseCovered: true,
      seatsInUse: null,
    });
    expect(notices).toEqual(['maintenance_lapsed', 'signed_with_test_key']);
  });

  describe('refusing a forgery', () => {
    async function keys() {
      const genuine = await generatedKey('adv-1', ['advisory', 'bundle']);
      return { genuine, root: rootOf(genuine.entry) };
    }

    it('refuses an advisory signed by a key this customer does not hold', async () => {
      const { root } = await keys();
      const stranger = generateTestSigningKey('stranger');
      expect(
        verifyDocument('advisory', signForTest('advisory', advisory, [stranger]), root),
      ).toEqual({ ok: false, code: 'UNKNOWN_KEY' });
    });

    it('refuses an impostor using the genuine key name', async () => {
      const { root } = await keys();
      const stranger = generateTestSigningKey('adv-1');
      expect(
        verifyDocument('advisory', signForTest('advisory', advisory, [stranger]), root),
      ).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    });

    it('refuses an advisory that was changed after signing', async () => {
      const { genuine, root } = await keys();
      const envelope = JSON.parse(await issueDocument('advisory', advisory, [genuine.signer])) as {
        payload: string;
      };
      const changed = Buffer.from(envelope.payload, 'base64')
        .toString('utf8')
        .replace('"high"', '"low"');
      const forged = JSON.stringify({
        ...envelope,
        payload: Buffer.from(changed).toString('base64'),
      });
      expect(verifyDocument('advisory', forged, root)).toEqual({
        ok: false,
        code: 'BAD_SIGNATURE',
      });
    });

    it('refuses a bundle with a changed file hash, which is what a tampered patch would need', async () => {
      const { genuine, root } = await keys();
      const envelope = JSON.parse(
        await issueDocument('bundle', patchManifest(), [genuine.signer]),
      ) as {
        payload: string;
      };
      const changed = Buffer.from(envelope.payload, 'base64')
        .toString('utf8')
        .replace(sha256('web'), sha256('tampered'));
      const forged = JSON.stringify({
        ...envelope,
        payload: Buffer.from(changed).toString('base64'),
      });
      expect(verifyDocument('bundle', forged, root)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    });

    it('refuses an advisory passed off as a bundle, since the type is signed', async () => {
      const { genuine, root } = await keys();
      const signed = await issueDocument('advisory', advisory, [genuine.signer]);
      expect(verifyDocument('bundle', signed, root)).toEqual({ ok: false, code: 'WRONG_TYPE' });
    });

    it('refuses a bundle signed by a key only trusted for advisories', async () => {
      const advisoryOnly = await generatedKey('adv-only', ['advisory']);
      const root = rootOf(advisoryOnly.entry);
      const signed = signForTest('bundle', patchManifest(), [
        {
          keyId: 'adv-only',
          privateKey: createPrivateKey(readFileSync(advisoryOnly.privateKeyPemFile)),
          publicKeyBase64: advisoryOnly.entry.public_key as string,
        },
      ]);
      expect(verifyDocument('bundle', signed, root)).toEqual({ ok: false, code: 'WRONG_PURPOSE' });
    });

    it('refuses an advisory signed after its key was marked compromised', async () => {
      const { signer, entry } = await generatedKey('adv-1', ['advisory']);
      const root = rootOf({ ...entry, compromised_on: '2028-01-01' });
      expect(
        verifyDocument('advisory', await issueDocument('advisory', advisory, [signer]), root),
      ).toEqual({ ok: false, code: 'KEY_NOT_VALID_FOR_THIS_DATE' });
    });
  });

  describe('rights against a bundle', () => {
    const license = testLicense() as unknown as Parameters<
      typeof evaluateUpdateRight
    >[0]['license'];
    const maintained = [{ starts_on: '2027-01-01', ends_on: '2027-12-31' }];
    const during = { ...patchRelease, published_on: '2027-06-01' } as ReleaseFacts;
    const after = patchRelease as ReleaseFacts;

    const evaluate = (
      release: ReleaseFacts,
      overrides: Partial<Parameters<typeof evaluateUpdateRight>[0]> = {},
    ) =>
      evaluateUpdateRight({
        license,
        agreements: maintained,
        policies: [],
        release,
        today: '2028-03-01',
        ...overrides,
      });

    it('covers a patch published while maintained, even after the lapse', () => {
      expect(evaluate(during)).toMatchObject({ covered: true, basis: 'maintenance' });
    });

    it('goes by the signed publication date, so moving a clock grants nothing', () => {
      for (const today of ['2027-06-01', '2028-03-01', '2099-01-01', '1970-01-01']) {
        expect(evaluate(after, { today }).covered).toBe(false);
      }
    });

    it('warns or refuses as the license says, for a new install only', () => {
      expect(evaluate(after).onInstall).toBe('warn');
      const refusing = testLicense({
        update_rights: { ...testLicense().update_rights, outside_rights_on_install: 'refuse' },
      }) as unknown as typeof license;
      expect(evaluate(after, { license: refusing }).onInstall).toBe('refuse');
    });

    it('lets a later signed policy add a security patch, with no new license', () => {
      expect(
        evaluate(after, {
          policies: [{ branches: [], security_patches_after_lapse_grant: 'licensed_line' }],
        }),
      ).toMatchObject({ covered: true, basis: 'support_policy_grant' });
    });

    it('has no way for a later policy to take away what a license gave', () => {
      const generous = testLicense({
        update_rights: {
          ...testLicense().update_rights,
          security_patches_after_lapse: 'licensed_line',
        },
      }) as unknown as typeof license;
      expect(
        evaluate(after, {
          license: generous,
          policies: [{ branches: [], security_patches_after_lapse_grant: 'none' }],
        }),
      ).toMatchObject({ covered: true, basis: 'security_after_lapse' });
    });

    it('does not treat a patch that is not a security fix as one', () => {
      const plain = { ...patchRelease, security: false } as ReleaseFacts;
      expect(
        evaluate(plain, {
          policies: [{ branches: [], security_patches_after_lapse_grant: 'licensed_line' }],
        }).covered,
      ).toBe(false);
    });
  });
});

describe('what a diagnostic report says about a release', () => {
  const log = createLogger('test', () => undefined);

  async function installed(signer: DocumentSigner) {
    const bundleManifestFile = inFolder();
    writeFileSync(bundleManifestFile, await issueDocument('bundle', patchManifest(), [signer]));
    return bundleManifestFile;
  }

  it('reads a verified manifest', async () => {
    const { signer, entry } = await generatedKey('bundle-1', ['bundle']);
    const trustRootFile = inFolder();
    writeFileSync(
      trustRootFile,
      JSON.stringify({ format: 'ensemus.trust_root', format_version: 1, keys: [entry] }),
    );
    expect(
      await readReleaseFacts({
        release: 'unreleased',
        bundleManifestFile: await installed(signer),
        trustRootFile,
        log,
      }),
    ).toMatchObject({ version: '2.0.1', images: [{ name: 'web' }, { name: 'worker' }] });
  });

  it('does not believe one that fails, and falls back to the setting', async () => {
    const { signer } = await generatedKey('bundle-1', ['bundle']);
    const stranger = await generatedKey('stranger', ['bundle']);
    const trustRootFile = inFolder();
    writeFileSync(
      trustRootFile,
      JSON.stringify({ format: 'ensemus.trust_root', format_version: 1, keys: [stranger.entry] }),
    );
    expect(
      await readReleaseFacts({
        release: 'unreleased',
        bundleManifestFile: await installed(signer),
        trustRootFile,
        log,
      }),
    ).toEqual({ version: 'unreleased', images: [] });
  });

  it('uses the setting when nothing is installed', async () => {
    expect(
      await readReleaseFacts({
        release: '2.0.0',
        bundleManifestFile: null,
        trustRootFile: null,
        log,
      }),
    ).toEqual({ version: '2.0.0', images: [] });
  });
});

describe('recipient-key', () => {
  const console_ = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it('prints the public key, writes the private one, and never prints it', async () => {
    const path = inFolder();
    const { io, out, err } = console_();
    expect(await recipientKeyCommand(['--out', path], io)).toBe(0);
    const pem = readFileSync(path, 'utf8');
    expect(pem).toContain('PRIVATE KEY');
    const printed = [...out, ...err].join('\n');
    expect(printed).not.toContain('PRIVATE');
    expect(printed).not.toContain(pem.split('\n')[1]);
    // What it prints is what a seal takes, and what it wrote opens what that seal made.
    const publicKey = parseRecipientPublicKey(/^public key: (.+)$/m.exec(printed)?.[1] as string);
    expect(printed).toContain(`key id: ${recipientKeyId(publicKey)}`);
    const opened = open(seal(Buffer.from('generated'), publicKey), parseRecipientPrivateKey(pem));
    expect(opened.toString()).toBe('generated');
  });

  it.skipIf(process.platform === 'win32')(
    'leaves the private key readable only by its owner',
    async () => {
      const path = inFolder();
      await writeRecipientKey(path);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it('never replaces a key', async () => {
    const path = inFolder();
    writeFileSync(path, 'kept');
    const { io, err } = console_();
    expect(await recipientKeyCommand(['--out', path], io)).toBe(1);
    expect(err[0]).toContain('OUT_EXISTS');
    expect(readFileSync(path, 'utf8')).toBe('kept');
  });

  it.each([
    ['no output file', []],
    ['an option it does not have', ['--out', 'x', '--print-private-key']],
  ])('refuses %s', async (_label, args) => {
    const { io } = console_();
    expect(await recipientKeyCommand(args, io)).toBe(2);
  });
});

describe('open-archive', () => {
  const recipient = () => {
    const { publicKey, privateKey } = generateRecipientKeyPair();
    return {
      publicKey,
      privateKey,
      pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: recipientKeyId(publicKey),
    };
  };
  const owner = recipient();

  const manifestFor = (parts: readonly object[], keyId: string) => ({
    format: 'ensemus.organization_export',
    schema_version: 1,
    export_id: randomUUID(),
    organization_id: randomUUID(),
    exported_at: '2028-01-01T00:00:00.000Z',
    snapshot_at: '2028-01-01T00:00:00.000Z',
    tombstones_through: '2028-01-01T00:00:00.000Z',
    initiated_by_membership_id: randomUUID(),
    source_release: '2.0.0',
    scope: 'standard',
    excluded: { restricted_work: 0, restricted_artifacts: 0, restricted_clients: 0 },
    sections: {},
    parts,
    encryption: { scheme: 'ensemus.sealed/v1', recipient_key_id: keyId },
  });

  type Entry = { path: string; bytes: Buffer };
  const tarOf = (entries: readonly Entry[]) =>
    Buffer.concat([
      ...entries.flatMap(({ path, bytes }) => [
        tarHeader(path, bytes.length),
        bytes,
        tarPadding(bytes.length),
      ]),
      tarEnd(),
    ]);

  const workPath = recordPartPath('work', 'work_units', 1);
  const fileId = randomUUID();
  const filePath = artifactPartPath(fileId);
  const workLines = Buffer.from('{"id":"one"}\n{"id":"two"}\n');
  const fileBytes = Buffer.from([0, 1, 2, 255, 254]);

  /** A well-formed archive, built the way the export slice builds one, with hooks for spoiling it. */
  function buildArchive(
    options: {
      key?: ReturnType<typeof recipient>;
      partKey?: ReturnType<typeof recipient>;
      changeManifest?: (manifest: ReturnType<typeof manifestFor>) => object;
      changeEntries?: (entries: Entry[]) => Entry[];
    } = {},
  ) {
    const key = options.key ?? owner;
    const partKey = options.partKey ?? key;
    const sealedWork = seal(workLines, partKey.publicKey);
    const sealedFile = seal(fileBytes, partKey.publicKey);
    const parts = [
      {
        path: workPath,
        section: 'work',
        records: 2,
        plaintext_sha256: sha256(workLines),
        sealed_sha256: sha256(sealedWork),
        sealed_bytes: sealedWork.length,
      },
      {
        path: filePath,
        section: 'artifacts',
        records: 0,
        plaintext_sha256: sha256(fileBytes),
        sealed_sha256: sha256(sealedFile),
        sealed_bytes: sealedFile.length,
      },
    ];
    const manifest = manifestFor(parts, key.keyId);
    const finalManifest = options.changeManifest?.(manifest) ?? manifest;
    const entries: Entry[] = [
      { path: workPath, bytes: sealedWork },
      { path: filePath, bytes: sealedFile },
      {
        path: EXPORT_MANIFEST_PATH,
        bytes: seal(Buffer.from(JSON.stringify(finalManifest)), key.publicKey),
      },
    ];
    const archivePath = inFolder();
    writeFileSync(archivePath, tarOf(options.changeEntries?.(entries) ?? entries));
    return { archivePath, manifest };
  }

  const openIt = (archivePath: string, pem = owner.pem) => {
    const outFolder = inFolder();
    return openArchive({ archivePath, recipientPrivateKeyPem: pem, outFolder }).then((result) => ({
      result,
      outFolder,
    }));
  };

  /** Whatever happened, a refused archive leaves nothing in the folder, or beside it. */
  function expectNothingLeft(outFolder: string) {
    expect(existsSync(outFolder)).toBe(false);
    const name = outFolder.slice(dirname(outFolder).length + 1);
    expect(readdirSync(dirname(outFolder)).filter((entry) => entry.startsWith(name))).toEqual([]);
  }

  it('opens a good archive to the folder named, with everything checked', async () => {
    const { archivePath, manifest } = buildArchive();
    const { result, outFolder } = await openIt(archivePath);
    expect(result).toEqual({
      ok: true,
      exportId: manifest.export_id,
      parts: 2,
      records: 2,
      bytes: workLines.length + fileBytes.length,
    });
    expect(readFileSync(join(outFolder, 'work/work_units-000001.jsonl'))).toEqual(workLines);
    expect(readFileSync(join(outFolder, `artifacts/${fileId}.bin`))).toEqual(fileBytes);
    expect(JSON.parse(readFileSync(join(outFolder, 'manifest.json'), 'utf8'))).toEqual(manifest);
  });

  it('reads a manifest the export contract accepts, so the tool and the contract agree', () => {
    const { manifest } = buildArchive();
    expect(() => exportManifestSchema.parse(manifest)).not.toThrow();
  });

  it('says which key an archive is for when given the wrong one', async () => {
    const { archivePath } = buildArchive();
    const { result, outFolder } = await openIt(archivePath, recipient().pem);
    expect(result).toEqual({ ok: false, code: 'WRONG_KEY', recipientKeyId: owner.keyId });
    expectNothingLeft(outFolder);
  });

  it('refuses a part sealed to someone else, and names who', async () => {
    const other = recipient();
    const { archivePath } = buildArchive({ partKey: other });
    const { result, outFolder } = await openIt(archivePath);
    expect(result).toEqual({ ok: false, code: 'WRONG_KEY', recipientKeyId: other.keyId });
    expectNothingLeft(outFolder);
  });

  const manifestPart = (manifest: ReturnType<typeof manifestFor>, index: number) =>
    manifest.parts[index] as Record<string, unknown>;

  it.each([
    [
      'a name outside the format',
      (entries: Entry[]) => [
        ...entries,
        { path: 'work/../../evil.jsonl.sealed', bytes: Buffer.from('x') },
      ],
      'PATH_REFUSED',
    ],
    [
      'an absolute name',
      (entries: Entry[]) => [...entries, { path: '/etc/passwd', bytes: Buffer.from('x') }],
      'PATH_REFUSED',
    ],
    [
      'a Windows name',
      (entries: Entry[]) => [
        ...entries,
        { path: 'work\\evil.jsonl.sealed', bytes: Buffer.from('x') },
      ],
      'PATH_REFUSED',
    ],
    [
      'a section nobody defined',
      (entries: Entry[]) => [
        ...entries,
        { path: 'secrets/x-000001.jsonl.sealed', bytes: Buffer.from('x') },
      ],
      'PATH_REFUSED',
    ],
    ['a good name twice', (entries: Entry[]) => [...entries, entries[0] as Entry], 'PATH_REFUSED'],
    [
      'a part the manifest does not list',
      (entries: Entry[]) => [
        ...entries,
        { path: recordPartPath('work', 'extra', 2), bytes: Buffer.from('x') },
      ],
      'PATH_REFUSED',
    ],
    [
      'a part the manifest lists and the archive lacks',
      (entries: Entry[]) => entries.filter(({ path }) => path !== workPath),
      'PART_MISSING',
    ],
    [
      'no manifest',
      (entries: Entry[]) => entries.filter(({ path }) => path !== EXPORT_MANIFEST_PATH),
      'MANIFEST_INVALID',
    ],
    [
      'a sealed part that changed by one byte',
      (entries: Entry[]) =>
        entries.map((entry) =>
          entry.path === workPath
            ? {
                ...entry,
                bytes: Buffer.concat([
                  entry.bytes.subarray(0, 30),
                  Buffer.from([1]),
                  entry.bytes.subarray(31),
                ]),
              }
            : entry,
        ),
      'PART_CHANGED',
    ],
    [
      'a part of the wrong length',
      (entries: Entry[]) =>
        entries.map((entry) =>
          entry.path === workPath
            ? { ...entry, bytes: Buffer.concat([entry.bytes, Buffer.from([0])]) }
            : entry,
        ),
      'PART_CHANGED',
    ],
  ])('refuses %s, and leaves nothing', async (_label, changeEntries, code) => {
    const { archivePath } = buildArchive({ changeEntries });
    const { result, outFolder } = await openIt(archivePath);
    expect(result).toMatchObject({ ok: false, code });
    expectNothingLeft(outFolder);
  });

  it.each([
    [
      'a plain hash that differs',
      (m: ReturnType<typeof manifestFor>) => ({
        ...m,
        parts: [{ ...manifestPart(m, 0), plaintext_sha256: 'a'.repeat(64) }, m.parts[1]],
      }),
      'PART_CHANGED',
    ],
    [
      'a sealed hash that differs',
      (m: ReturnType<typeof manifestFor>) => ({
        ...m,
        parts: [{ ...manifestPart(m, 0), sealed_sha256: 'a'.repeat(64) }, m.parts[1]],
      }),
      'PART_CHANGED',
    ],
    [
      'a path outside the format',
      (m: ReturnType<typeof manifestFor>) => ({
        ...m,
        parts: [{ ...manifestPart(m, 0), path: '../../evil.sealed' }, m.parts[1]],
      }),
      'PATH_REFUSED',
    ],
    [
      'the manifest listed as its own part',
      (m: ReturnType<typeof manifestFor>) => ({
        ...m,
        parts: [{ ...manifestPart(m, 0), path: EXPORT_MANIFEST_PATH }],
      }),
      'MANIFEST_INVALID',
    ],
    [
      'a part in the wrong section',
      (m: ReturnType<typeof manifestFor>) => ({
        ...m,
        parts: [{ ...manifestPart(m, 0), section: 'people' }, m.parts[1]],
      }),
      'MANIFEST_INVALID',
    ],
    [
      'a part listed twice',
      (m: ReturnType<typeof manifestFor>) => ({
        ...m,
        parts: [m.parts[0], m.parts[0], m.parts[1]],
      }),
      'MANIFEST_INVALID',
    ],
    [
      'a hash that is not one',
      (m: ReturnType<typeof manifestFor>) => ({
        ...m,
        parts: [{ ...manifestPart(m, 0), sealed_sha256: 'x' }, m.parts[1]],
      }),
      'MANIFEST_INVALID',
    ],
    [
      'no parts list',
      (m: ReturnType<typeof manifestFor>) => ({ ...m, parts: undefined }),
      'MANIFEST_INVALID',
    ],
    [
      'another kind of file',
      (m: ReturnType<typeof manifestFor>) => ({ ...m, format: 'something_else' }),
      'MANIFEST_INVALID',
    ],
    [
      'a version from the future',
      (m: ReturnType<typeof manifestFor>) => ({ ...m, schema_version: 2 }),
      'FORMAT_NOT_SUPPORTED',
    ],
    [
      'an unknown encryption',
      (m: ReturnType<typeof manifestFor>) => ({
        ...m,
        encryption: { scheme: 'other', recipient_key_id: owner.keyId },
      }),
      'FORMAT_NOT_SUPPORTED',
    ],
  ])('refuses a manifest with %s, and leaves nothing', async (_label, changeManifest, code) => {
    const { archivePath } = buildArchive({ changeManifest });
    const { result, outFolder } = await openIt(archivePath);
    expect(result).toMatchObject({ ok: false, code });
    expectNothingLeft(outFolder);
  });

  it('refuses an archive that was cut off, or is not one', async () => {
    const { archivePath } = buildArchive();
    const cut = inFolder();
    writeFileSync(cut, readFileSync(archivePath).subarray(0, 1024));
    const shortened = await openIt(cut);
    expect(shortened.result).toEqual({ ok: false, code: 'ARCHIVE_UNREADABLE' });
    expectNothingLeft(shortened.outFolder);

    const junk = inFolder();
    writeFileSync(junk, Buffer.alloc(2048, 7));
    expect((await openIt(junk)).result).toEqual({ ok: false, code: 'ARCHIVE_UNREADABLE' });
    expect((await openIt(inFolder('no-such-archive'))).result).toEqual({
      ok: false,
      code: 'ARCHIVE_UNREADABLE',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a link where the archive should be',
    async () => {
      const { archivePath } = buildArchive();
      const link = inFolder();
      symlinkSync(archivePath, link);
      expect((await openIt(link)).result).toEqual({ ok: false, code: 'ARCHIVE_UNREADABLE' });
    },
  );

  describe('as a command', () => {
    const run = async (args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const status = await openArchiveCommand(args, {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      });
      return { status, out, err, printed: [...out, ...err].join('\n') };
    };
    const keyFile = (pem = owner.pem) => {
      const path = inFolder();
      writeFileSync(path, pem);
      return path;
    };

    it('prints counts and IDs, and no key', async () => {
      const { archivePath, manifest } = buildArchive();
      const { status, printed } = await run([
        '--archive',
        archivePath,
        '--key-file',
        keyFile(),
        '--out',
        inFolder(),
      ]);
      expect(status).toBe(0);
      expect(printed).toContain(manifest.export_id);
      expect(printed).toContain('2 parts');
      expect(printed).not.toContain('PRIVATE');
    });

    it('answers exit 1 for a refused archive, and says which key it is for', async () => {
      const { archivePath } = buildArchive();
      const { status, err } = await run([
        '--archive',
        archivePath,
        '--key-file',
        keyFile(recipient().pem),
        '--out',
        inFolder(),
      ]);
      expect(status).toBe(1);
      expect(err[0]).toContain(`WRONG_KEY: this archive is sealed for key ${owner.keyId}`);
    });

    it('will not open into a folder that exists, so two archives cannot mix', async () => {
      const { archivePath } = buildArchive();
      const outFolder = inFolder();
      await run(['--archive', archivePath, '--key-file', keyFile(), '--out', outFolder]);
      const second = await run([
        '--archive',
        archivePath,
        '--key-file',
        keyFile(),
        '--out',
        outFolder,
      ]);
      expect(second.status).toBe(2);
      expect(second.err[0]).toContain('OUT_EXISTS');
    });

    it.each([
      ['a key file that is not there', () => inFolder('no-such-key')],
      ['a file that is not a key', () => keyFile('not a key')],
      [
        'a signing key, which is the wrong kind',
        () =>
          keyFile(
            generateKeyPairSync('ed25519')
              .privateKey.export({ type: 'pkcs8', format: 'pem' })
              .toString(),
          ),
      ],
    ])('refuses %s, with fixed words', async (_label, key) => {
      const { archivePath } = buildArchive();
      const { status, err, printed } = await run([
        '--archive',
        archivePath,
        '--key-file',
        key(),
        '--out',
        inFolder(),
      ]);
      expect(status).toBe(2);
      expect(err[0]).toContain('KEY_UNREADABLE');
      expect(printed).not.toContain('PRIVATE');
    });

    it('needs all of its arguments, and takes no others', async () => {
      expect((await run([])).status).toBe(2);
      expect((await run(['--archive', 'x'])).status).toBe(2);
      expect((await run(['--archive', 'x', '--key', 'pasted-on-the-command-line'])).status).toBe(2);
    });

    it('takes a key only from a file, so it stays out of shell history', () => {
      const source = readFileSync(
        new URL('../../workers/workflow/src/tools/open-archive.ts', import.meta.url),
        'utf8',
      );
      expect(source).toContain("'key-file'");
      expect(source).not.toMatch(/['"]key['"]\s*:/);
    });
  });

  it('a customer can make the key with one tool and open with the other', async () => {
    const keyPath = inFolder();
    const { publicKey, keyId } = await writeRecipientKey(keyPath);
    const pem = readFileSync(keyPath, 'utf8');
    const made = {
      publicKey: parseRecipientPublicKey(publicKey),
      privateKey: createPrivateKey(pem),
      pem,
      keyId,
    };
    const { archivePath } = buildArchive({ key: made });
    expect((await openIt(archivePath, pem)).result.ok).toBe(true);
    expect(exportRecipientPublicKey(made.publicKey)).toBe(publicKey);
  });
});
