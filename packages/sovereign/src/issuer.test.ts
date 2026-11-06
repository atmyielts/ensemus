// ADR-030 D3 and D5: the vendor's tool, run whole with files in memory and generated keys. Nothing here is a
// real key, and the rights below are test values, not a policy anyone decided.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AdvisoryDocument } from '@ensemus/domain/license';
import { PAYLOAD_TYPES } from './envelope';
import {
  createRehearsalFileSigner,
  issueDocument,
  IssuerRefused,
  runIssuerCommand,
  type DocumentSigner,
  type IssueRecord,
  type IssuerIo,
} from './issuer';
import { generateTestSigningKey, testLicense, testMaintenance, testTrustRoot } from './testing';
import { parseTrustRoot, type DocumentPurpose } from './trust-root';
import { verifyDocument } from './verify';

const folder = mkdtempSync(join(tmpdir(), 'issuer-test-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const generatedPem = () =>
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const pemFile = (pem = generatedPem()) => {
  const path = join(folder, `${createHash('sha256').update(pem).digest('hex')}.pem`);
  writeFileSync(path, pem);
  return path;
};

const fileSigner = (keyId = 'rehearsal-1') =>
  createRehearsalFileSigner({ keyId, privateKeyPemFile: pemFile(), rehearsal: true });

const rootFor = (signer: DocumentSigner, purposes: readonly DocumentPurpose[]) =>
  parseTrustRoot(
    JSON.stringify({
      format: 'ensemus.trust_root',
      format_version: 1,
      keys: [
        {
          key_id: signer.keyId,
          algorithm: 'ed25519',
          public_key: signer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          purposes,
          test_only: true,
        },
      ],
    }),
  );

/** A file system in a map, and a record of what was printed, so a test sees everything the tool did. */
function memoryIo(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const out: string[] = [];
  const err: string[] = [];
  const io: IssuerIo = {
    readFile: async (path) => {
      const found = files.get(path);
      if (found === undefined) throw new Error('not there');
      return Buffer.from(found);
    },
    // The real tool's writes refuse to replace a file, and so does this.
    writeFile: async (path, data) => {
      if (files.has(path)) throw new Error('already there');
      files.set(path, data.toString());
    },
    appendFile: async (path, data) => {
      files.set(path, (files.get(path) ?? '') + data);
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2027-03-01T12:00:00.000Z'),
  };
  return { io, files, out, err };
}

const rights = () => {
  const { licensee, term, licensed_release, footprint, components, update_rights } = testLicense();
  return { licensee, term, licensed_release, footprint, components, update_rights };
};

const issuing = ['--signer', 'k1=key.pem', '--rehearsal', '--out', 'doc.json', '--register', 'r'];

function ready(extra: Record<string, string> = {}) {
  return memoryIo({ 'key.pem': generatedPem(), ...extra });
}

const createPublicKeyBase64 = (pem: string) =>
  createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');

const trustRootFrom = (pem: string, purposes: readonly DocumentPurpose[]) =>
  testTrustRoot([
    {
      keyId: 'k1',
      privateKey: createPrivateKey(pem),
      publicKeyBase64: createPublicKeyBase64(pem),
      purposes,
    },
  ]);

describe('the rehearsal signer', () => {
  it('signs with a generated key and says that it is rehearsal', async () => {
    const signer = fileSigner();
    expect(signer.rehearsal).toBe(true);
    expect((await signer.sign(Buffer.from('bytes'))).length).toBe(64);
  });

  it.each([[false], [undefined], ['true'], [1]])('refuses when rehearsal is %s', (rehearsal) => {
    expect(() =>
      createRehearsalFileSigner({
        keyId: 'rehearsal-1',
        privateKeyPemFile: pemFile(),
        rehearsal: rehearsal as true,
      }),
    ).toThrow(expect.objectContaining({ code: 'REHEARSAL_ONLY' }));
  });

  it('refuses a key that is missing or not Ed25519, and says nothing of what it read', () => {
    const x25519 = generateKeyPairSync('x25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    for (const privateKeyPemFile of [join(folder, 'nowhere.pem'), pemFile(x25519), pemFile('no')]) {
      let thrown: unknown;
      try {
        createRehearsalFileSigner({ keyId: 'k1', privateKeyPemFile, rehearsal: true });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(IssuerRefused);
      expect((thrown as IssuerRefused).code).toBe('KEY_UNREADABLE');
      expect((thrown as IssuerRefused).message).not.toContain('PRIVATE');
    }
  });

  it('refuses a key name a trust root could not hold', () => {
    expect(() =>
      createRehearsalFileSigner({
        keyId: 'Not A Key Id',
        privateKeyPemFile: pemFile(),
        rehearsal: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'KEY_ID_INVALID' }));
  });
});

describe('issuing a document', () => {
  it('writes format version 1, and a customer can verify it offline', async () => {
    const signer = fileSigner();
    const envelope = await issueDocument('license', testLicense() as never, [signer]);
    const verdict = verifyDocument('license', envelope, rootFor(signer, ['license']));
    expect(verdict).toMatchObject({ ok: true, keyIds: ['rehearsal-1'], testKey: true });
    if (verdict.ok) expect(verdict.document.format_version).toBe(1);
    expect(JSON.parse(envelope).payloadType).toBe(PAYLOAD_TYPES.license);
  });

  it('carries as many signatures as it has signers', async () => {
    const [first, second] = [fileSigner('key-a'), fileSigner('key-b')];
    const envelope = await issueDocument('maintenance', testMaintenance() as never, [
      first,
      second,
    ]);
    expect(
      (JSON.parse(envelope) as { signatures: unknown[] }).signatures.map(
        (entry) => (entry as { keyid: string }).keyid,
      ),
    ).toEqual(['key-a', 'key-b']);
  });

  it('never signs a field its schema does not know', async () => {
    const envelope = await issueDocument(
      'license',
      testLicense({ expires_on: '2030-01-01' }) as never,
      [fileSigner()],
    );
    const payload = Buffer.from(JSON.parse(envelope).payload, 'base64').toString('utf8');
    expect(payload).not.toContain('expires_on');
  });

  it.each([
    ['a newer format', testLicense({ format_version: 2 })],
    ['a date that is not one', testLicense({ issued_at: 'soon' })],
    ['a license without its rights', { ...testLicense(), update_rights: undefined }],
    ['a right nobody defined', testLicense({ edition: 'cloud' })],
  ])('refuses %s, and names only the field', async (_label, document) => {
    await expect(issueDocument('license', document as never, [fileSigner()])).rejects.toMatchObject(
      { code: 'DOCUMENT_INVALID' },
    );
  });

  it('refuses a maintenance statement that ends before it starts', async () => {
    await expect(
      issueDocument(
        'maintenance',
        testMaintenance({ starts_on: '2028-01-01', ends_on: '2027-01-01' }) as never,
        [fileSigner()],
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_INVALID' });
  });

  it('refuses with no signer, and with one key signing twice to look like two', async () => {
    await expect(issueDocument('license', testLicense() as never, [])).rejects.toMatchObject({
      code: 'NO_SIGNER',
    });
    const signer = fileSigner();
    await expect(
      issueDocument('license', testLicense() as never, [signer, signer]),
    ).rejects.toMatchObject({ code: 'SIGNER_REPEATED' });
  });

  it('refuses when its own output would not verify, as with a signer holding another key', async () => {
    const claimed = fileSigner();
    const held = createPrivateKey(generatedPem());
    const wrong: DocumentSigner = {
      keyId: claimed.keyId,
      publicKey: claimed.publicKey,
      sign: async (bytes) => sign(null, bytes, held),
    };
    await expect(issueDocument('license', testLicense() as never, [wrong])).rejects.toMatchObject({
      code: 'SELF_CHECK_FAILED',
    });
  });

  it('refuses a signer whose key is not Ed25519', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed448');
    const wrong: DocumentSigner = {
      keyId: 'k1',
      publicKey,
      sign: async (bytes) => sign(null, bytes, privateKey),
    };
    await expect(issueDocument('license', testLicense() as never, [wrong])).rejects.toMatchObject({
      code: 'SELF_CHECK_FAILED',
    });
  });

  it('refuses an advisory too large for a customer to read back', async () => {
    const huge = {
      format: 'ensemus.advisory',
      format_version: 1,
      advisory_id: 'ENS-TEST-1',
      issued_at: '2027-03-01T00:00:00.000Z',
      severity: 'high',
      title: 'Generated title',
      summary: 'x'.repeat(20_001),
      affected_versions: ['2.0.0'],
      fixed_in_versions: [],
    } satisfies AdvisoryDocument;
    await expect(issueDocument('advisory', huge, [fileSigner()])).rejects.toMatchObject({
      code: 'DOCUMENT_INVALID',
    });
  });
});

describe('keygen', () => {
  it('prints a trust root entry marked test_only, and never the private key', async () => {
    const { io, files, out } = memoryIo();
    const status = await runIssuerCommand(
      ['keygen', '--key-id', 'rehearsal-1', '--purposes', 'license,maintenance', '--out', 'k.pem'],
      io,
    );
    expect(status).toBe(0);
    const entry = JSON.parse(out[0] as string);
    expect(entry).toMatchObject({
      key_id: 'rehearsal-1',
      algorithm: 'ed25519',
      purposes: ['license', 'maintenance'],
      test_only: true,
      retired_on: null,
      compromised_on: null,
    });
    expect(files.get('k.pem')).toContain('PRIVATE KEY');
    expect(out.join('\n')).not.toContain('PRIVATE');
  });

  it('can write a whole trust root, which a deployment reads and which says test_only', async () => {
    const { io, files } = memoryIo();
    await runIssuerCommand(
      [
        'keygen',
        '--key-id',
        'rehearsal-1',
        '--purposes',
        'license',
        '--out',
        'k.pem',
        '--trust-root-out',
        'root.json',
      ],
      io,
    );
    const root = parseTrustRoot(files.get('root.json') as string);
    expect(root.keys[0]?.test_only).toBe(true);
    expect(root.thresholds.license).toBe(1);
    expect(files.get('root.json')).not.toContain('PRIVATE');
  });

  it.each([
    [['--test-only', 'false']],
    [['--test-only=false']],
    [['--no-test-only']],
    [['--production']],
    [['--real']],
  ])('has no way to write test_only false: %j', async (extra) => {
    const { io, files, err } = memoryIo();
    const status = await runIssuerCommand(
      ['keygen', '--key-id', 'k1', '--purposes', 'license', '--out', 'k.pem', ...extra],
      io,
    );
    expect(status).toBe(2);
    expect(err).toEqual(['NOT_AN_OPTION']);
    expect(files.size).toBe(0);
  });

  it.each([
    ['no purposes', ['keygen', '--key-id', 'k1', '--out', 'k.pem'], 'PURPOSES_REQUIRED'],
    ['no key name', ['keygen', '--purposes', 'license', '--out', 'k.pem'], 'KEY_ID_REQUIRED'],
    ['nowhere to write', ['keygen', '--key-id', 'k1', '--purposes', 'license'], 'OUT_REQUIRED'],
    [
      'an unknown purpose',
      ['keygen', '--key-id', 'k1', '--purposes', 'everything', '--out', 'k.pem'],
      'PURPOSE_UNKNOWN',
    ],
    [
      'a bad key name',
      ['keygen', '--key-id', 'Not A Name', '--purposes', 'license', '--out', 'k.pem'],
      'KEY_ID_INVALID',
    ],
  ])('refuses %s', async (_label, argv, code) => {
    const { io, files, err } = memoryIo();
    expect(await runIssuerCommand(argv, io)).toBe(2);
    expect(err).toEqual([code]);
    expect(files.size).toBe(0);
  });

  it('will not replace a key that is already there', async () => {
    const { io, files } = memoryIo({ 'k.pem': 'kept' });
    const status = await runIssuerCommand(
      ['keygen', '--key-id', 'k1', '--purposes', 'license', '--out', 'k.pem'],
      io,
    );
    expect(status).toBe(1);
    expect(files.get('k.pem')).toBe('kept');
  });
});

describe('license', () => {
  const run = (rightsFile: unknown, extra = issuing) => {
    const memory = ready({ 'rights.json': JSON.stringify(rightsFile) });
    return runIssuerCommand(['license', '--rights', 'rights.json', ...extra], memory.io).then(
      (status) => ({ status, ...memory }),
    );
  };

  it('issues exactly what the file says, verifies, and adds one line to the register', async () => {
    const { status, files, out } = await run(rights());
    expect(status).toBe(0);

    const root = trustRootFrom(files.get('key.pem') as string, ['license']);
    const verdict = verifyDocument('license', files.get('doc.json') as string, root);
    if (!verdict.ok) throw new Error(verdict.code);
    expect(verdict.testKey).toBe(true);
    expect(verdict.document.update_rights).toEqual(rights().update_rights);
    expect(verdict.document.issued_at).toBe('2027-03-01T12:00:00.000Z');

    const lines = (files.get('r') as string).trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as IssueRecord;
    expect(record).toEqual({
      issued_at: '2027-03-01T12:00:00.000Z',
      purpose: 'license',
      document_id: verdict.document.license_id,
      envelope_sha256: createHash('sha256')
        .update(files.get('doc.json') as string)
        .digest('hex'),
      key_ids: ['k1'],
      rehearsal: true,
    });
    expect(files.get('r')).not.toContain('Test Licensee');
    expect(out.join('\n')).not.toContain('Test Licensee');
  });

  it('refuses to run without a rights file, and writes nothing', async () => {
    const { io, files, err } = ready();
    expect(await runIssuerCommand(['license', ...issuing], io)).toBe(2);
    expect(err).toEqual(['RIGHTS_REQUIRED']);
    expect(files.has('doc.json')).toBe(false);
    expect(files.has('r')).toBe(false);
  });

  it('refuses a rights file that cannot be read or is not JSON', async () => {
    const missing = ready();
    expect(await runIssuerCommand(['license', '--rights', 'no', ...issuing], missing.io)).toBe(2);
    expect(missing.err).toEqual(['INPUT_UNREADABLE']);

    const broken = ready({ 'rights.json': '{ not json' });
    expect(
      await runIssuerCommand(['license', '--rights', 'rights.json', ...issuing], broken.io),
    ).toBe(2);
    expect(broken.err).toEqual(['INPUT_NOT_JSON']);
  });

  const withoutKey = (object: Record<string, unknown>, key: string) =>
    Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

  it.each([
    'security_patches_after_lapse',
    'major_versions_with_maintenance',
    'releases_published_during_maintenance',
    'outside_rights_on_install',
  ])('has no default for %s', async (field) => {
    const file = {
      ...rights(),
      update_rights: withoutKey(rights().update_rights, field),
    };
    const { status, err, files } = await run(file);
    expect(status).toBe(2);
    expect(err[0]).toContain('INPUT_INVALID');
    expect(err[0]).toContain(`update_rights.${field}`);
    expect(files.has('doc.json')).toBe(false);
    expect(files.has('r')).toBe(false);
  });

  it.each(['licensee', 'term', 'licensed_release', 'footprint', 'components', 'update_rights'])(
    'has no default for %s',
    async (field) => {
      const { status, err } = await run(withoutKey(rights(), field));
      expect(status).toBe(2);
      expect(err[0]).toContain(field);
    },
  );

  it.each([
    [
      'a value nobody defined',
      { update_rights: { ...rights().update_rights, security_patches_after_lapse: 'all' } },
      'update_rights.security_patches_after_lapse',
    ],
    ['an unknown field', { price: 100 }, 'price'],
    [
      'an unknown right',
      { update_rights: { ...rights().update_rights, kill_switch: true } },
      'kill_switch',
    ],
    ['an unknown term', { term: { kind: 'subscription' } }, 'term'],
    [
      'an expiry on a perpetual term',
      { term: { kind: 'perpetual', expires_on: '2030-01-01' } },
      'expires_on',
    ],
    [
      'a line that does not match the version',
      { licensed_release: { line: '3.0', version: '2.0.0' } },
      'licensed_release',
    ],
  ])('refuses %s', async (_label, change, named) => {
    const { status, err, files } = await run({ ...rights(), ...change });
    expect(status).toBe(2);
    expect(err[0]).toContain('INPUT_INVALID');
    expect(err[0]).toContain(named);
    expect(files.has('doc.json')).toBe(false);
  });

  it('never echoes what a rights file holds', async () => {
    const { err, out } = await run({
      ...rights(),
      licensee: { display_name: 'Secret Licensee Name', contract_reference: '' },
    });
    expect(`${err.join('\n')}${out.join('\n')}`).not.toContain('Secret Licensee Name');
  });

  it.each([
    [
      'without saying rehearsal',
      ['--signer', 'k1=key.pem', '--out', 'doc.json', '--register', 'r'],
      'REHEARSAL_ONLY',
    ],
    ['with no signer', ['--rehearsal', '--out', 'doc.json', '--register', 'r'], 'SIGNER_REQUIRED'],
    [
      'with no output',
      ['--signer', 'k1=key.pem', '--rehearsal', '--register', 'r'],
      'OUT_REQUIRED',
    ],
    [
      'with no register',
      ['--signer', 'k1=key.pem', '--rehearsal', '--out', 'doc.json'],
      'REGISTER_REQUIRED',
    ],
    [
      'with a signer that is not a pair',
      ['--signer', 'key.pem', '--rehearsal', '--out', 'doc.json', '--register', 'r'],
      'SIGNER_NOT_ID_AND_FILE',
    ],
    [
      'with a key that is not there',
      ['--signer', 'k1=gone.pem', '--rehearsal', '--out', 'doc.json', '--register', 'r'],
      'KEY_UNREADABLE',
    ],
  ])('refuses to sign %s', async (_label, extra, code) => {
    const { status, err, files } = await run(rights(), extra);
    expect(status).toBe(2);
    expect(err).toEqual([code]);
    expect(files.has('doc.json')).toBe(false);
    expect(files.has('r')).toBe(false);
  });

  it('adds to the register and replaces nothing in it', async () => {
    const { io, files } = ready({
      'rights.json': JSON.stringify(rights()),
      r: 'an earlier line\n',
    });
    await runIssuerCommand(['license', '--rights', 'rights.json', ...issuing], io);
    const lines = (files.get('r') as string).trim().split('\n');
    expect(lines[0]).toBe('an earlier line');
    expect(lines).toHaveLength(2);
  });

  it('leaves a line and no file when the file cannot be written, since nothing was handed over', async () => {
    const { io, files, err } = ready({
      'rights.json': JSON.stringify(rights()),
      'doc.json': 'already there',
    });
    expect(await runIssuerCommand(['license', '--rights', 'rights.json', ...issuing], io)).toBe(1);
    expect(err).toEqual(['OUTPUT_NOT_WRITTEN']);
    expect(files.get('doc.json')).toBe('already there');
    expect(files.get('r')).toContain('"purpose":"license"');
  });
});

describe('maintenance, advisory and support policy', () => {
  const statement = {
    license_id: testLicense().license_id,
    starts_on: '2027-01-01',
    ends_on: '2027-12-31',
  };
  const advisory = {
    advisory_id: 'ENS-TEST-1',
    severity: 'high',
    title: 'Generated title',
    summary: 'Generated summary.',
    affected_versions: ['2.0.0'],
    fixed_in_versions: ['2.0.1'],
  };
  const policy = {
    branches: [{ line: '2.0', status: 'supported' }],
    security_patches_after_lapse_grant: 'none',
  };

  it.each([
    ['maintenance', '--statement', statement, 'maintenance'],
    ['advisory', '--advisory', advisory, 'advisory'],
    ['support-policy', '--policy', policy, 'support_policy'],
  ] as const)('%s issues what its file says', async (command, flag, content, purpose) => {
    const { io, files } = ready({ 'in.json': JSON.stringify(content) });
    expect(await runIssuerCommand([command, flag, 'in.json', ...issuing], io)).toBe(0);
    const root = trustRootFrom(files.get('key.pem') as string, [purpose]);
    const verdict = verifyDocument(purpose, files.get('doc.json') as string, root);
    if (!verdict.ok) throw new Error(verdict.code);
    expect(verdict.document).toMatchObject(content);
    expect(JSON.parse(files.get('r') as string)).toMatchObject({ purpose, rehearsal: true });
  });

  it.each([
    ['maintenance', '--statement', statement],
    ['advisory', '--advisory', advisory],
    ['support-policy', '--policy', policy],
  ] as const)('%s has no default and takes no extra value', async (command, flag, content) => {
    const [first] = Object.keys(content);
    const missing = Object.fromEntries(Object.entries(content).filter(([name]) => name !== first));
    const noFile = ready();
    expect(await runIssuerCommand([command, ...issuing], noFile.io)).toBe(2);

    const lacking = ready({ 'in.json': JSON.stringify(missing) });
    expect(await runIssuerCommand([command, flag, 'in.json', ...issuing], lacking.io)).toBe(2);
    expect(lacking.err[0]).toContain(first);

    const extra = ready({ 'in.json': JSON.stringify({ ...content, unknown_value: 1 }) });
    expect(await runIssuerCommand([command, flag, 'in.json', ...issuing], extra.io)).toBe(2);
    expect(extra.err[0]).toContain('unknown_value');
  });

  it('refuses a maintenance statement that ends before it starts', async () => {
    const { io, err } = ready({
      'in.json': JSON.stringify({ ...statement, ends_on: '2026-01-01' }),
    });
    expect(await runIssuerCommand(['maintenance', '--statement', 'in.json', ...issuing], io)).toBe(
      2,
    );
    expect(err[0]).toContain('DOCUMENT_INVALID');
  });
});

describe('verify', () => {
  async function issued() {
    const memory = ready({ 'rights.json': JSON.stringify(rights()) });
    await runIssuerCommand(['license', '--rights', 'rights.json', ...issuing], memory.io);
    const pem = memory.files.get('key.pem') as string;
    memory.files.set(
      'root.json',
      JSON.stringify({
        format: 'ensemus.trust_root',
        format_version: 1,
        keys: [
          {
            key_id: 'k1',
            algorithm: 'ed25519',
            public_key: createPublicKeyBase64(pem),
            purposes: ['license'],
            test_only: true,
          },
        ],
      }),
    );
    return memory;
  }

  it('says what it checked, with IDs and no names', async () => {
    const { io, out } = await issued();
    expect(await runIssuerCommand(['verify', 'doc.json', '--trust-root', 'root.json'], io)).toBe(0);
    expect(out.at(-1)).toContain('Verified license');
    expect(out.at(-1)).toContain('test key true');
    expect(out.at(-1)).not.toContain('Test Licensee');
  });

  it('refuses a changed byte with exit 1', async () => {
    const { io, files, err } = await issued();
    const envelope = JSON.parse(files.get('doc.json') as string) as { payload: string };
    const changed = Buffer.from(envelope.payload, 'base64')
      .toString('utf8')
      .replace('Test Licensee', 'Other Licensee');
    files.set(
      'forged.json',
      JSON.stringify({ ...envelope, payload: Buffer.from(changed).toString('base64') }),
    );
    expect(await runIssuerCommand(['verify', 'forged.json', '--trust-root', 'root.json'], io)).toBe(
      1,
    );
    expect(err).toEqual(['BAD_SIGNATURE']);
  });

  it('refuses a document from a key this root does not hold', async () => {
    const { io, files, err } = await issued();
    const stranger = generateTestSigningKey('k-stranger');
    files.set(
      'root.json',
      JSON.stringify({
        format: 'ensemus.trust_root',
        format_version: 1,
        keys: [
          {
            key_id: stranger.keyId,
            algorithm: 'ed25519',
            public_key: stranger.publicKeyBase64,
            purposes: ['license'],
            test_only: true,
          },
        ],
      }),
    );
    expect(await runIssuerCommand(['verify', 'doc.json', '--trust-root', 'root.json'], io)).toBe(1);
    expect(err).toEqual(['UNKNOWN_KEY']);
  });

  it.each([
    ['no file', ['verify', '--trust-root', 'root.json'], 'FILE_REQUIRED'],
    ['no trust root', ['verify', 'doc.json'], 'TRUST_ROOT_REQUIRED'],
    [
      'a trust root that is not there',
      ['verify', 'doc.json', '--trust-root', 'gone'],
      'TRUST_ROOT_UNREADABLE',
    ],
    [
      'a document that is not there',
      ['verify', 'gone', '--trust-root', 'root.json'],
      'INPUT_UNREADABLE',
    ],
  ])('refuses %s with exit 2', async (_label, argv, code) => {
    const { io, err } = await issued();
    expect(await runIssuerCommand(argv, io)).toBe(2);
    expect(err).toEqual([code]);
  });

  it('refuses something that is not an envelope, or of no known kind', async () => {
    const { io, files, err } = await issued();
    files.set('junk.json', 'not json');
    files.set('other.json', JSON.stringify({ payloadType: 'text/plain' }));
    expect(await runIssuerCommand(['verify', 'junk.json', '--trust-root', 'root.json'], io)).toBe(
      1,
    );
    expect(await runIssuerCommand(['verify', 'other.json', '--trust-root', 'root.json'], io)).toBe(
      1,
    );
    expect(err).toEqual(['MALFORMED', 'WRONG_TYPE']);
  });
});

describe('the command line', () => {
  it.each([[[]], [['sign']], [['constructor']], [['__proto__']]])(
    'answers an unknown command %j with exit 2',
    async (argv) => {
      const { io, err } = memoryIo();
      expect(await runIssuerCommand(argv, io)).toBe(2);
      expect(err[0]).toContain('COMMAND_UNKNOWN');
    },
  );
});
