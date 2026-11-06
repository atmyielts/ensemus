// What needs no database, plus `install` against stand-ins for the services. tests/integration/licensing.test.ts
// runs `install` against real roles. Lint keeps @ensemus/sovereign/testing out of the workers, so the few
// lines that sign a document live here, with generated keys that end with this file.
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppError, type LicenseStatusView } from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import { PAYLOAD_TYPES, preAuthEncoding } from '@ensemus/sovereign/envelope';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CANNOT_CHECK, licenseCommand, NOT_VERIFIED, VERIFIED } from './sovereign-license-command';

const folder = mkdtempSync(join(tmpdir(), 'sovereign-license-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const fileWith = (text: string) => {
  const path = join(folder, `${randomUUID()}.json`);
  writeFileSync(path, text);
  return path;
};

type TestKey = { keyId: string; privateKey: KeyObject; publicKey: string };

const generateKey = (keyId: string): TestKey => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
};

const trustRootFor = (keys: readonly TestKey[], overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 'ensemus.trust_root',
    format_version: 1,
    keys: keys.map(({ keyId, publicKey }) => ({
      key_id: keyId,
      algorithm: 'ed25519',
      public_key: publicKey,
      purposes: ['license', 'maintenance', 'advisory', 'support_policy'],
      test_only: true,
      ...overrides,
    })),
  });

const signed = (
  purpose: 'license' | 'maintenance' | 'advisory',
  document: object,
  key: TestKey,
): string => {
  const payload = Buffer.from(JSON.stringify(document));
  const type = PAYLOAD_TYPES[purpose];
  return JSON.stringify({
    payloadType: type,
    payload: payload.toString('base64'),
    signatures: [
      {
        keyid: key.keyId,
        sig: sign(null, preAuthEncoding(type, payload), key.privateKey).toString('base64'),
      },
    ],
  });
};

const LICENSE_ID = randomUUID();
const CANARY_NAME = 'Canary Licensee Ltd';
const license = {
  format: 'ensemus.license',
  format_version: 1,
  license_id: LICENSE_ID,
  issued_at: '2027-01-01T00:00:00.000Z',
  licensee: { display_name: CANARY_NAME, contract_reference: 'CANARY-CONTRACT' },
  edition: 'sovereign',
  term: { kind: 'perpetual' },
  licensed_release: { line: '2.0', version: '2.0.0' },
  footprint: {
    organizations: null,
    seats: null,
    production_deployments: null,
    nonproduction_deployments: null,
  },
  components: ['web'],
  update_rights: {
    security_patches_after_lapse: 'none',
    major_versions_with_maintenance: 'separate_purchase',
    releases_published_during_maintenance: 'kept_after_lapse',
    outside_rights_on_install: 'warn',
  },
};
const maintenance = {
  format: 'ensemus.maintenance',
  format_version: 1,
  maintenance_id: randomUUID(),
  license_id: LICENSE_ID,
  issued_at: '2027-01-01T00:00:00.000Z',
  starts_on: '2027-01-01',
  ends_on: '2027-12-31',
};

const key = generateKey('key-a');
const stranger = generateKey('key-b');
const trustRootFile = fileWith(trustRootFor([key]));
const licenseFile = fileWith(signed('license', license, key));
const now = () => new Date('2030-06-01T00:00:00.000Z');

/** Runs the command, and keeps what it said. Any database it opens counts as a failure unless asked for. */
async function run(args: string[], deps: Partial<Parameters<typeof licenseCommand>[1]> = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const openDatabase = vi.fn(() => {
    throw new Error('opened a database');
  });
  const code = await licenseCommand(args, {
    openDatabase,
    env: {},
    now,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    ...deps,
  });
  return {
    code,
    openDatabase,
    said: lines.join('\n') + errors.join('\n'),
    result: lines[0] ? JSON.parse(lines[0]) : null,
    refusal: errors[0] ? JSON.parse(errors[0]) : null,
  };
}

const verify = (file: string, root: string | null = trustRootFile) =>
  run(['verify', file, ...(root ? ['--trust-root', root] : [])]);

describe('verify, which needs no database', () => {
  it('prints the standing, IDs and notices for a good license, and opens nothing', async () => {
    const { code, result, openDatabase } = await verify(licenseFile);
    expect(code).toBe(VERIFIED);
    expect(openDatabase).not.toHaveBeenCalled();
    expect(result).toEqual({
      command: 'verify',
      ok: true,
      standing: 'licensed',
      type: 'license',
      documentId: LICENSE_ID,
      keyIds: ['key-a'],
      testKey: true,
      retiredKey: false,
      notices: ['signed_with_test_key'],
    });
  });

  it('takes the trust root from the setting when no option names one', async () => {
    const { code } = await run(['verify', licenseFile], {
      env: { ENSEMUS_LICENSE_TRUST_ROOT_FILE: trustRootFile },
    });
    expect(code).toBe(VERIFIED);
  });

  it('never prints a licensee name or the file itself', async () => {
    const envelope = readFileSync(licenseFile, 'utf8');
    const payload = (JSON.parse(envelope) as { payload: string }).payload;
    const { said } = await verify(licenseFile);
    expect(said).not.toContain(CANARY_NAME);
    expect(said).not.toContain('CANARY-CONTRACT');
    expect(said).not.toContain(payload);
  });

  it.each([
    ['a stopped clock', '2001-01-01T00:00:00.000Z', ['clock_before_issue']],
    ['ten years on', '2040-01-01T00:00:00.000Z', []],
  ])('still exits 0 with %s', async (_name, at, extra) => {
    const { code, result } = await run(['verify', licenseFile, '--trust-root', trustRootFile], {
      now: () => new Date(at),
    });
    expect(code).toBe(VERIFIED);
    expect(result.standing).toBe('licensed');
    expect(result.notices).toEqual(['signed_with_test_key', ...extra]);
  });

  it('reads a maintenance statement, which has no standing of its own', async () => {
    const { code, result } = await verify(fileWith(signed('maintenance', maintenance, key)));
    expect(code).toBe(VERIFIED);
    expect(result).toMatchObject({
      type: 'maintenance',
      standing: null,
      documentId: maintenance.maintenance_id,
      licenseId: LICENSE_ID,
    });
  });

  it('says so of a key since retired, and it is still good', async () => {
    const root = fileWith(trustRootFor([key], { retired_on: '2028-01-01' }));
    const { code, result } = await verify(licenseFile, root);
    expect(code).toBe(VERIFIED);
    expect(result.retiredKey).toBe(true);
    expect(result.notices).toContain('signed_with_retired_key');
  });

  it('refuses a key that was retired before the document was issued', async () => {
    const root = fileWith(trustRootFor([key], { retired_on: '2026-01-01' }));
    const { code, refusal } = await verify(licenseFile, root);
    expect(code).toBe(NOT_VERIFIED);
    expect(refusal.reasonCode).toBe('KEY_NOT_VALID_FOR_THIS_DATE');
  });

  const forged = () => {
    const envelope = JSON.parse(readFileSync(licenseFile, 'utf8')) as Record<string, unknown>;
    return JSON.stringify({
      ...envelope,
      payload: Buffer.from(JSON.stringify({ ...license, components: ['everything'] })).toString(
        'base64',
      ),
    });
  };

  it.each([
    ['a forged payload', forged, 'BAD_SIGNATURE'],
    ['text that is not JSON', () => 'not a document', 'MALFORMED'],
    ['JSON that is not an envelope', () => '{"a":1}', 'WRONG_TYPE'],
    ['the JSON word null', () => 'null', 'WRONG_TYPE'],
    ['a bundle manifest, which has its own tool', () => bundleEnvelope(), 'WRONG_TYPE'],
    [
      'content that does not fit its kind',
      () => signed('license', { ...license, term: { kind: 'expiring' } }, key),
      'CONTENT_INVALID',
    ],
    [
      'a newer format',
      () => signed('license', { ...license, format_version: 2 }, key),
      'FORMAT_NOT_SUPPORTED',
    ],
    [
      'a maintenance statement with a license type',
      () => {
        const statement = JSON.parse(signed('maintenance', maintenance, key)) as object;
        return JSON.stringify({ ...statement, payloadType: PAYLOAD_TYPES.license });
      },
      'BAD_SIGNATURE',
    ],
  ])('exits 1 for %s', async (_name, text, reasonCode) => {
    const { code, refusal, result } = await verify(fileWith(text()));
    expect(code).toBe(NOT_VERIFIED);
    expect(refusal.reasonCode).toBe(reasonCode);
    expect(result).toBeNull();
  });

  it('exits 1 for a file it cannot read, or one too large to be a document', async () => {
    expect((await verify(join(folder, 'missing.json'))).refusal.reasonCode).toBe('FILE_UNREADABLE');
    expect((await verify(folder)).refusal.reasonCode).toBe('FILE_UNREADABLE');
    const large = await verify(fileWith('x'.repeat(1024 * 1024 + 1)));
    expect(large.code).toBe(NOT_VERIFIED);
    expect(large.refusal.reasonCode).toBe('TOO_LARGE');
  });

  it.each([
    ['one that does not know the signer', () => fileWith(trustRootFor([stranger])), 'UNKNOWN_KEY'],
    ['a file that is not one', () => fileWith('{}'), 'TRUST_ROOT_UNREADABLE'],
    ['a path with nothing there', () => join(folder, 'none.json'), 'TRUST_ROOT_UNREADABLE'],
  ])('exits 2 for a wrong trust root: %s', async (_name, root, reasonCode) => {
    const { code, refusal } = await verify(licenseFile, root());
    expect(code).toBe(CANNOT_CHECK);
    expect(refusal.reasonCode).toBe(reasonCode);
  });

  it('exits 2 with no trust root at all, and never takes one from the document', async () => {
    const { code, refusal } = await verify(licenseFile, null);
    expect(code).toBe(CANNOT_CHECK);
    expect(refusal.reasonCode).toBe('TRUST_ROOT_NOT_CONFIGURED');
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['renew', licenseFile]],
    ['no file', ['verify']],
    ['two files', ['verify', licenseFile, licenseFile]],
    ['an unknown option', ['verify', licenseFile, '--force']],
  ])('exits 2 for %s', async (_name, args) => {
    expect((await run(args)).code).toBe(CANNOT_CHECK);
  });
});

const bundleEnvelope = () => {
  const payload = Buffer.from('{}');
  const type = PAYLOAD_TYPES.bundle;
  return JSON.stringify({
    payloadType: type,
    payload: payload.toString('base64'),
    signatures: [
      {
        keyid: key.keyId,
        sig: sign(null, preAuthEncoding(type, payload), key.privateKey).toString('base64'),
      },
    ],
  });
};

describe('install', () => {
  const organization = randomUUID();
  const env = { ENSEMUS_LICENSE_TRUST_ROOT_FILE: trustRootFile };
  const status: LicenseStatusView = {
    standing: 'licensed',
    license: null,
    maintenance: { status: 'lapsed', lastCoveredOn: '2027-12-31' },
    runningRelease: null,
    seatsInUse: 3,
    notices: ['maintenance_lapsed'],
  };

  const standIns = () => {
    const close = vi.fn(async () => undefined);
    const db = {} as AppDatabase;
    return {
      close,
      db,
      openDatabase: vi.fn(() => ({ db, close })),
      services: {
        installSignedDocument: vi.fn(async () => ({
          type: 'license' as const,
          id: 'row-id',
          created: true,
          testKey: true,
        })),
        getLicenseStatus: vi.fn(async () => status),
      },
    };
  };

  it('installs as a service for that organization, with the bytes exactly as they are', async () => {
    const given = standIns();
    const text = `${readFileSync(licenseFile, 'utf8')}\n`;
    const { code, result } = await run(['install', '--organization', organization, fileWith(text)], {
      env,
      ...given,
    });
    expect(code).toBe(VERIFIED);
    const [db, context, input] = given.services.installSignedDocument.mock.calls[0] as unknown as [
      AppDatabase,
      { organizationId: string; actorType: string },
      { envelope: string },
    ];
    expect(db).toBe(given.db);
    expect(context).toMatchObject({ organizationId: organization, actorType: 'service' });
    expect(input.envelope).toBe(text);
    expect(given.close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      command: 'install',
      organizationId: organization,
      recordId: 'row-id',
      created: true,
      standing: 'licensed',
      documentId: LICENSE_ID,
      maintenance: 'lapsed',
      notices: ['maintenance_lapsed'],
    });
  });

  it('exits 0 for a lapsed license, and says nothing of the licensee', async () => {
    const { code, said } = await run(['install', '--organization', organization, licenseFile], {
      env,
      ...standIns(),
    });
    expect(code).toBe(VERIFIED);
    expect(said).not.toContain(CANARY_NAME);
  });

  it('opens no database for a file that does not verify', async () => {
    const given = standIns();
    const { code } = await run(
      ['install', '--organization', organization, fileWith('not a document')],
      { env, ...given },
    );
    expect(code).toBe(NOT_VERIFIED);
    expect(given.openDatabase).not.toHaveBeenCalled();
  });

  it('exits 1 for a maintenance statement for a license not installed here', async () => {
    const given = standIns();
    given.services.installSignedDocument.mockRejectedValue(new AppError('LICENSE_NOT_VALID'));
    const { code, refusal } = await run(
      ['install', '--organization', organization, fileWith(signed('maintenance', maintenance, key))],
      { env, ...given },
    );
    expect(code).toBe(NOT_VERIFIED);
    expect(refusal.reasonCode).toBe('LICENSE_NOT_VALID');
    expect(given.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['an organization that is not an ID', ['install', '--organization', 'acme', licenseFile], env],
    ['no organization', ['install', licenseFile], env],
    ['no trust root', ['install', '--organization', organization, licenseFile], {}],
    [
      'an option that would let it trust another root',
      ['install', '--organization', organization, '--trust-root', trustRootFile, licenseFile],
      env,
    ],
    [
      'a trust root that does not know the signer',
      ['install', '--organization', organization, licenseFile],
      { ENSEMUS_LICENSE_TRUST_ROOT_FILE: fileWith(trustRootFor([stranger])) },
    ],
  ])('exits 2 for %s, having opened nothing', async (_name, args, givenEnv) => {
    const given = standIns();
    const { code } = await run(args, { env: givenEnv, ...given });
    expect(code).toBe(CANNOT_CHECK);
    expect(given.openDatabase).not.toHaveBeenCalled();
  });

  it('lets anything else through for the entry point, having closed the connection', async () => {
    const given = standIns();
    given.services.getLicenseStatus.mockRejectedValue(new Error('database went away'));
    await expect(
      licenseCommand(['install', '--organization', organization, licenseFile], {
        env,
        now,
        out: () => undefined,
        err: () => undefined,
        ...given,
      }),
    ).rejects.toThrow('database went away');
    expect(given.close).toHaveBeenCalledOnce();
  });
});

describe('the frozen corpus', () => {
  const corpus = resolve(import.meta.dirname, '../../../tests/fixtures/license-corpus/v1');

  it.each(['license', 'pilot-license', 'maintenance', 'advisory', 'support-policy'])(
    'verifies %s with the trust root it was issued with',
    async (name) => {
      const { code } = await verify(join(corpus, `${name}.dsse.json`), join(corpus, 'trust-root.json'));
      expect(code).toBe(VERIFIED);
    },
  );
});
