// The command with its sources in the test (SOV-06). tests/integration/diagnostics.test.ts runs `collect` on
// real PostgreSQL, where the content really exists, and it is written and unverified until that can run. Here
// the canaries are in the places a command could pick them up from: the environment, a secret file, and what
// a failing source throws. No value below is real, and no key is anything but generated.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diagnosticReportSchema,
  openTransfer,
  renderReviewText,
  reportSha256,
  sealForTransfer,
  serializeReport,
} from '@ensemus/sovereign/diagnostics';
import {
  exportRecipientPublicKey,
  generateRecipientKeyPair,
  recipientKeyId,
} from '@ensemus/sovereign/sealed';
import { createLogger } from '@ensemus/telemetry';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTIC_CONFIGURATION_NAMES,
  diagnosticsCommand,
  schemaVersionFor,
  type DatabaseFacts,
  type DiagnosticSources,
} from './diagnostics-command';

const folder = mkdtempSync(join(tmpdir(), 'diagnostics-command-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const newFolder = () => join(folder, randomUUID());

const CANARIES = {
  title: 'CANARY-WORK-TITLE-7f3a',
  fileName: 'CANARY-FILE-NAME-7f3a.pdf',
  email: 'canary-member-7f3a@example.invalid',
  tenant: 'CANARY-TENANT-NAME-7f3a',
  secret: 'CANARY-SECRET-VALUE-7f3a',
  config: 'CANARY-CONFIG-VALUE-7f3a',
};

const facts: DatabaseFacts = {
  tenants: 2,
  outbox: { queued: 3, dead: 1, oldestSeconds: 40 },
  ledger: { queued: 0, dead: 0 },
  lastMigrationAt: 1_000,
  deadEvents: [{ eventType: 'work.execution_requested', count: 1 }],
};

const sources = (overrides: Partial<DiagnosticSources> = {}): DiagnosticSources => ({
  database: async () => facts,
  temporalReachable: async () => true,
  objectStoreReachable: async () => true,
  release: async () => ({
    version: '2.0.1',
    images: [{ name: 'worker', digest: `sha256:${'a'.repeat(64)}` }],
  }),
  shippedMigrations: async () => [
    { tag: '0001_first', when: 500 },
    { tag: '0002_second', when: 1_000 },
  ],
  ...overrides,
});

function harness(given: Partial<DiagnosticSources> = {}, env: NodeJS.ProcessEnv = {}) {
  const logged: string[] = [];
  const said: string[] = [];
  const opened = vi.fn(async () => sources(given));
  return {
    logged,
    said,
    opened,
    deps: {
      sources: opened,
      env,
      now: () => new Date('2027-05-01T10:00:00.000Z'),
      log: createLogger('diagnostics', (line) => logged.push(line)),
      say: (line: string) => said.push(line),
    },
  };
}

const reasons = (logged: readonly string[]) =>
  logged.map((line) => (JSON.parse(line) as { reasonCode?: string }).reasonCode).filter(Boolean);

describe('the settings a report may name', () => {
  it('names no secret and no file', () => {
    for (const name of DIAGNOSTIC_CONFIGURATION_NAMES) {
      expect(name).not.toMatch(/_FILE$|SECRET|PASSWORD|TOKEN|CREDENTIAL|_KEY|ACCESS|DATABASE_URL/);
    }
  });

  it('leaves off the address that would say who the customer is', () => {
    expect(DIAGNOSTIC_CONFIGURATION_NAMES as readonly string[]).not.toContain('ENSEMUS_PUBLIC_URL');
  });

  it('fits the schema', () => {
    expect(DIAGNOSTIC_CONFIGURATION_NAMES.length).toBeLessThanOrEqual(256);
  });
});

describe('which migration a report names', () => {
  const shipped = [
    { tag: '0001_first', when: 500 },
    { tag: '0002_second', when: 1_000 },
  ];

  it('names what the database ran when it can read that', () => {
    expect(schemaVersionFor(500, shipped)).toBe('0001_first');
  });

  it('marks what the image ships as just that, when it cannot', () => {
    expect(schemaVersionFor(null, shipped)).toBe('image:0002_second');
    // A database ahead of this image, which is worth seeing rather than hiding.
    expect(schemaVersionFor(9_999, shipped)).toBe('image:0002_second');
    expect(schemaVersionFor(null, [])).toBe('unknown');
  });
});

describe('collect', () => {
  it('writes a report and its review, from what the sources said', async () => {
    const out = newFolder();
    const { deps, said } = harness({}, { TEMPORAL_NAMESPACE: 'default' });
    expect(await diagnosticsCommand(['collect', '--out', out], deps)).toBe(0);

    const text = readFileSync(join(out, 'report.json'), 'utf8');
    const report = diagnosticReportSchema.parse(JSON.parse(text));
    expect(text).toBe(serializeReport(report));
    expect(report).toMatchObject({
      generated_at: '2027-05-01T10:00:00.000Z',
      release_version: '2.0.1',
      images: [{ name: 'worker' }],
      database: { schema_version: '0002_second', reachable: true, tenants: 2 },
      temporal: { reachable: true },
      object_store: { reachable: true },
      outbox: { queued: 3, dead: 1, oldest_seconds: 40 },
      ledger: { queued: 0, dead: 0 },
      error_codes: [{ code: 'outbox.dead:work.execution_requested', count: 1 }],
    });
    expect(readFileSync(join(out, 'review.txt'), 'utf8')).toBe(renderReviewText(report));
    expect(said.join('\n')).toContain('Nothing has left this machine');
  });

  it('names settings with a hash, says which are unset, and never shows a value', async () => {
    const out = newFolder();
    const { deps } = harness({}, { TEMPORAL_NAMESPACE: CANARIES.config });
    await diagnosticsCommand(['collect', '--out', out], deps);
    const report = diagnosticReportSchema.parse(
      JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')),
    );
    expect(report.configuration.map(({ name }) => name)).toEqual([
      ...DIAGNOSTIC_CONFIGURATION_NAMES,
    ]);
    const entry = (name: string) => report.configuration.find((item) => item.name === name);
    expect(entry('TEMPORAL_NAMESPACE')?.sha256).toBe(reportSha256(CANARIES.config));
    expect(entry('ENSEMUS_MODE')?.sha256).toBeNull();
  });

  it('holds no canary from the environment or a secret file, and does not open that file', async () => {
    const out = newFolder();
    const secretFile = join(folder, `${randomUUID()}.secret`);
    writeFileSync(secretFile, CANARIES.secret);
    const { deps, logged, said } = harness(
      {},
      {
        // Everything a command could be tempted by. Only the two named settings are on the list.
        TEMPORAL_NAMESPACE: CANARIES.config,
        OBJECT_STORAGE_BUCKET: CANARIES.config,
        ENSEMUS_PUBLIC_URL: `https://${CANARIES.tenant}.example.invalid`,
        DATABASE_URL_DISPATCHER: `postgres://user:${CANARIES.secret}@host/db`,
        OBJECT_STORAGE_SECRET_KEY: CANARIES.secret,
        DATABASE_URL_DISPATCHER_FILE: secretFile,
        TEMPORAL_CODEC_KEY_FILE: secretFile,
        ENSEMUS_LICENSE_TRUST_ROOT_FILE: secretFile,
      },
    );
    expect(await diagnosticsCommand(['collect', '--out', out], deps)).toBe(0);

    const everything = [
      readFileSync(join(out, 'report.json'), 'utf8'),
      readFileSync(join(out, 'review.txt'), 'utf8'),
      logged.join('\n'),
      said.join('\n'),
    ].join('\n');
    for (const canary of Object.values(CANARIES)) expect(everything).not.toContain(canary);
    expect(everything).not.toContain(secretFile);
    for (const name of ['_FILE', 'DATABASE_URL', 'SECRET_KEY', 'PUBLIC_URL']) {
      expect(everything).not.toContain(name);
    }
  });

  it('keeps what a failing source says out of everything, and reports it as not reachable', async () => {
    const out = newFolder();
    // A database error quotes SQL and parameters, which is how content leaks through a log.
    const leaky = (text: string) => async (): Promise<never> => {
      throw Object.assign(new Error(text), { query: text, parameters: [text], detail: text });
    };
    const { deps, logged, said } = harness({
      database: leaky(
        `update work set title='${CANARIES.title}', file='${CANARIES.fileName}', email='${CANARIES.email}', name='${CANARIES.tenant}'`,
      ),
      temporalReachable: leaky(CANARIES.secret),
      objectStoreReachable: leaky(`bad key ${CANARIES.secret}`),
      release: leaky(CANARIES.config),
      shippedMigrations: leaky(CANARIES.config),
    });
    expect(await diagnosticsCommand(['collect', '--out', out], deps)).toBe(0);

    const report = diagnosticReportSchema.parse(
      JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')),
    );
    expect(report).toMatchObject({
      release_version: 'unknown',
      images: [],
      database: { schema_version: 'unknown', reachable: false, tenants: 0 },
      temporal: { reachable: false },
      object_store: { reachable: false },
      outbox: { queued: 0, dead: 0, oldest_seconds: 0 },
    });
    const everything = [
      readFileSync(join(out, 'report.json'), 'utf8'),
      readFileSync(join(out, 'review.txt'), 'utf8'),
      logged.join('\n'),
      said.join('\n'),
    ].join('\n');
    for (const canary of Object.values(CANARIES)) expect(everything).not.toContain(canary);
    expect(readFileSync(join(out, 'review.txt'), 'utf8')).toContain('did not answer');
  });

  it.each([
    [
      'a sentence as an event type',
      { deadEvents: [{ eventType: `${CANARIES.title} went`, count: 1 }] },
    ],
    ['an address as an event type', { deadEvents: [{ eventType: CANARIES.email, count: 1 }] }],
    ['a count that is not one', { tenants: -1 }],
    ['a fraction of a queue', { outbox: { queued: 0.5, dead: 0, oldestSeconds: 0 } }],
  ])('stops on %s, trims nothing and writes nothing', async (_label, change) => {
    const out = newFolder();
    const { deps, logged, said } = harness({
      database: async () => ({ ...facts, ...change }) as DatabaseFacts,
    });
    expect(await diagnosticsCommand(['collect', '--out', out], deps)).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(reasons(logged)).toContain('VALUE_REFUSED');
    const text = logged.join('\n') + said.join('\n');
    expect(text).not.toContain(CANARIES.title);
    expect(text).not.toContain(CANARIES.email);
  });

  it('stops on a release with text in it', async () => {
    const out = newFolder();
    const { deps } = harness({
      release: async () => ({ version: `${CANARIES.tenant} build`, images: [] }),
    });
    expect(await diagnosticsCommand(['collect', '--out', out], deps)).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('will not replace a report someone may already have read', async () => {
    const out = newFolder();
    const first = harness();
    expect(await diagnosticsCommand(['collect', '--out', out], first.deps)).toBe(0);
    const before = readFileSync(join(out, 'report.json'), 'utf8');

    const second = harness({ database: async () => ({ ...facts, tenants: 99 }) });
    expect(await diagnosticsCommand(['collect', '--out', out], second.deps)).toBe(2);
    expect(reasons(second.logged)).toContain('OUT_EXISTS');
    expect(readFileSync(join(out, 'report.json'), 'utf8')).toBe(before);
  });

  it('needs somewhere to write', async () => {
    const { deps, logged, opened } = harness();
    expect(await diagnosticsCommand(['collect'], deps)).toBe(2);
    expect(reasons(logged)).toEqual(['OUT_REQUIRED']);
    expect(opened).not.toHaveBeenCalled();
  });
});

describe('seal', () => {
  const recipient = () => {
    const { publicKey, privateKey } = generateRecipientKeyPair();
    return { publicKey, privateKey, base64: exportRecipientPublicKey(publicKey) };
  };

  async function collected() {
    const out = newFolder();
    await diagnosticsCommand(['collect', '--out', out], harness().deps);
    return join(out, 'report.json');
  }

  it('seals those exact bytes with the approval inside, and only writes a file', async () => {
    const reportFile = await collected();
    const to = recipient();
    const { deps, said, logged, opened } = harness();
    const status = await diagnosticsCommand(
      ['seal', '--report', reportFile, '--recipient', to.base64, '--approved-by', CANARIES.email],
      deps,
    );
    expect(status).toBe(0);
    expect(opened).not.toHaveBeenCalled();

    const result = openTransfer(readFileSync(`${reportFile}.sealed`), to.privateKey);
    if (!result.ok) throw new Error(result.code);
    expect(result.reportText).toBe(readFileSync(reportFile, 'utf8'));
    expect(result.approval).toEqual({
      approved_by: CANARIES.email,
      approved_at: '2027-05-01T10:00:00.000Z',
      report_sha256: reportSha256(result.reportText),
      recipient_key_id: recipientKeyId(to.publicKey),
    });
    expect(said.join('\n')).toContain('Nothing has been sent');
    // Their name goes in the sealed file, to the person they chose, and nowhere else.
    expect(logged.join('\n') + said.join('\n')).not.toContain(CANARIES.email);
  });

  it.each([
    ['no name at all', [], 'APPROVAL_MISSING'],
    ['an empty name', ['--approved-by', ''], 'APPROVAL_MISSING'],
    ['a blank name', ['--approved-by', '   '], 'APPROVAL_MISSING'],
  ])('refuses with %s, and writes nothing', async (_label, extra, code) => {
    const reportFile = await collected();
    const { deps, logged } = harness();
    const status = await diagnosticsCommand(
      ['seal', '--report', reportFile, '--recipient', recipient().base64, ...extra],
      deps,
    );
    expect(status).toBe(2);
    expect(reasons(logged)).toEqual([code]);
    expect(existsSync(`${reportFile}.sealed`)).toBe(false);
  });

  it('refuses a name too long to be one, as no approval', async () => {
    const reportFile = await collected();
    const { deps, logged } = harness();
    const status = await diagnosticsCommand(
      [
        'seal',
        '--report',
        reportFile,
        '--recipient',
        recipient().base64,
        '--approved-by',
        'x'.repeat(201),
      ],
      deps,
    );
    expect(status).toBe(1);
    expect(reasons(logged)).toEqual(['APPROVAL_MISSING']);
  });

  it.each([
    ['a field added', (text: string) => text.replace('{', '{\n  "tenant_name": "Acme",')],
    ['a value changed to text', (text: string) => text.replace('2.0.1', 'Acme build')],
    ['the same report respaced', (text: string) => `${text}\n\n`],
  ])('refuses a report with %s', async (_label, change) => {
    const reportFile = await collected();
    writeFileSync(reportFile, change(readFileSync(reportFile, 'utf8')));
    const { deps, logged } = harness();
    const status = await diagnosticsCommand(
      ['seal', '--report', reportFile, '--recipient', recipient().base64, '--approved-by', 'Name'],
      deps,
    );
    expect(status).toBe(1);
    expect(reasons(logged)).toEqual(['REPORT_REFUSED']);
    expect(existsSync(`${reportFile}.sealed`)).toBe(false);
  });

  it('refuses a recipient that is not a sealing key', async () => {
    const reportFile = await collected();
    const { deps, logged } = harness();
    const status = await diagnosticsCommand(
      ['seal', '--report', reportFile, '--recipient', 'not-a-key', '--approved-by', 'Name'],
      deps,
    );
    expect(status).toBe(2);
    expect(reasons(logged)).toEqual(['RECIPIENT_REFUSED']);
  });

  it('refuses a report that cannot be read, or no report, or no recipient', async () => {
    const missing = harness();
    expect(
      await diagnosticsCommand(
        [
          'seal',
          '--report',
          join(folder, 'gone'),
          '--recipient',
          recipient().base64,
          '--approved-by',
          'N',
        ],
        missing.deps,
      ),
    ).toBe(2);
    expect(reasons(missing.logged)).toEqual(['REPORT_UNREADABLE']);

    const noReport = harness();
    await diagnosticsCommand(['seal', '--recipient', 'x', '--approved-by', 'N'], noReport.deps);
    expect(reasons(noReport.logged)).toEqual(['REPORT_REQUIRED']);

    const noRecipient = harness();
    await diagnosticsCommand(['seal', '--report', 'x', '--approved-by', 'N'], noRecipient.deps);
    expect(reasons(noRecipient.logged)).toEqual(['RECIPIENT_REQUIRED']);
  });

  it('will not replace a transfer already written', async () => {
    const reportFile = await collected();
    writeFileSync(`${reportFile}.sealed`, 'kept');
    const { deps, logged } = harness();
    const status = await diagnosticsCommand(
      ['seal', '--report', reportFile, '--recipient', recipient().base64, '--approved-by', 'Name'],
      deps,
    );
    expect(status).toBe(2);
    expect(reasons(logged)).toEqual(['OUT_EXISTS']);
    expect(readFileSync(`${reportFile}.sealed`, 'utf8')).toBe('kept');
  });

  it('an approval of one report cannot seal another, or for someone else', () => {
    const [first, second] = [recipient(), recipient()];
    const text = serializeReport(
      diagnosticReportSchema.parse({
        format: 'ensemus.diagnostics',
        format_version: 1,
        generated_at: '2027-05-01T10:00:00.000Z',
        release_version: '2.0.1',
        images: [],
        database: { schema_version: 'unknown', reachable: false, tenants: 0 },
        temporal: { reachable: false },
        object_store: { reachable: false },
        outbox: { queued: 0, dead: 0, oldest_seconds: 0 },
        ledger: { queued: 0, dead: 0 },
        configuration: [],
        error_codes: [],
      }),
    );
    const approval = {
      approved_by: 'Name',
      approved_at: '2027-05-01T10:00:00.000Z',
      report_sha256: reportSha256(text),
      recipient_key_id: recipientKeyId(first.publicKey),
    };
    const other = text.replace('2.0.1', '2.0.2');
    expect(
      sealForTransfer({ reportText: other, approval, recipientPublicKey: first.base64 }),
    ).toEqual({ ok: false, code: 'APPROVAL_FOR_ANOTHER_REPORT' });
    expect(
      sealForTransfer({ reportText: text, approval, recipientPublicKey: second.base64 }),
    ).toEqual({ ok: false, code: 'APPROVAL_FOR_ANOTHER_RECIPIENT' });
    expect(
      sealForTransfer({ reportText: text, approval: null, recipientPublicKey: first.base64 }),
    ).toEqual({ ok: false, code: 'APPROVAL_MISSING' });
  });
});

describe('the command line', () => {
  it.each([
    ['nothing', []],
    ['an unknown command', ['send']],
    ['an upload option', ['collect', '--out', 'x', '--upload-to', 'y']],
    ['a stray argument', ['collect', 'somewhere']],
  ])('refuses %s with exit 2 and asks no source', async (_label, args) => {
    const { deps, opened } = harness();
    expect(await diagnosticsCommand(args, deps)).toBe(2);
    expect(opened).not.toHaveBeenCalled();
  });

  it('has no command that sends', () => {
    const source = readFileSync(new URL('./diagnostics-command.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/fetch\(|node:https?|node:net|createConnection|upload/i);
    const entry = readFileSync(new URL('./diagnostics-export.ts', import.meta.url), 'utf8');
    expect(entry).not.toMatch(/fetch\(|node:https?|node:net|\.put\(/);
  });

  it('leaves nothing but its own output in the folder', async () => {
    const out = newFolder();
    await diagnosticsCommand(['collect', '--out', out], harness().deps);
    expect(readdirSync(out).sort()).toEqual(['report.json', 'review.txt']);
  });
});
