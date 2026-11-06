// Owned by the issuer slice (SOV-01, SOV-04). See docs/06-delivery/m6-slices.md and ADR-030 D3. The vendor's
// tool, and nothing that ships: lint keeps this out of the web tier and the workers, and a test checks that
// no image's build reaches it. Who holds the real signing keys is the owner's open decision, so signing is
// a port, and the only implementation so far reads a generated key from a file for rehearsal.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  advisoryDocumentSchema,
  DOCUMENT_SCHEMAS,
  licenseDocumentSchema,
  maintenanceDocumentSchema,
  supportPolicyDocumentSchema,
  type DocumentFor,
} from './documents';
import { PAYLOAD_TYPES, preAuthEncoding } from './envelope';
import {
  DOCUMENT_PURPOSES,
  parseTrustRoot,
  type DocumentPurpose,
  type TrustedKey,
  type TrustRoot,
} from './trust-root';
import { verifyDocument } from './verify';

/**
 * Signs bytes. A hardware token, a KMS or a second holder implements this once custody is decided. It has
 * to name its public key, because the issuer checks its own output before anyone can receive it.
 */
export interface DocumentSigner {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  /** True when this signer holds a generated key from a file. A real signer leaves this out. */
  readonly rehearsal?: boolean;
  sign(preAuthEncoded: Buffer): Promise<Buffer>;
}

export const ISSUER_REFUSALS = [
  'REHEARSAL_ONLY',
  'KEY_ID_INVALID',
  'KEY_UNREADABLE',
  'NO_SIGNER',
  'SIGNER_REPEATED',
  'DOCUMENT_INVALID',
  'SELF_CHECK_FAILED',
] as const;
export type IssuerRefusal = (typeof ISSUER_REFUSALS)[number];

/** Fixed text and a code, so neither a key nor a document's contents can reach a terminal or a log. */
export class IssuerRefused extends Error {
  override name = 'IssuerRefused';
  constructor(
    readonly code: IssuerRefusal,
    /** Which fields failed, by name. Never their values. */
    readonly fields: readonly string[] = [],
  ) {
    super(`The issuer refused: ${code}`);
  }
}

const KEY_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function rehearsalSigner(keyId: string, pem: string | Buffer, rehearsal: unknown): DocumentSigner {
  // The type says `true`, and JavaScript callers and a stray cast do not read types.
  if (rehearsal !== true) throw new IssuerRefused('REHEARSAL_ONLY');
  if (!KEY_ID.test(keyId)) throw new IssuerRefused('KEY_ID_INVALID');
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new IssuerRefused('KEY_UNREADABLE');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new IssuerRefused('KEY_UNREADABLE');
  return {
    keyId,
    publicKey: createPublicKey(privateKey),
    rehearsal: true,
    sign: async (bytes) => sign(null, bytes, privateKey),
  };
}

/**
 * Reads a generated key from a file. Refuses unless `rehearsal` is true, and the issuer's output and its
 * register both record that it was used. No real key is stored or used until the owner decides custody and
 * outside review has happened.
 */
export function createRehearsalFileSigner(input: {
  keyId: string;
  privateKeyPemFile: string;
  rehearsal: true;
}): DocumentSigner {
  if (input.rehearsal !== true) throw new IssuerRefused('REHEARSAL_ONLY');
  let pem: Buffer;
  try {
    pem = readFileSync(input.privateKeyPemFile);
  } catch {
    throw new IssuerRefused('KEY_UNREADABLE');
  }
  return rehearsalSigner(input.keyId, pem, input.rehearsal);
}

const failedFields = (error: z.ZodError) => [
  ...new Set(error.issues.map((issue) => issue.path.join('.') || '(top level)')),
];

/** A root holding only these signers, needing all of them, so the check below proves every signature. */
function rootOfSigners(purpose: DocumentPurpose, signers: readonly DocumentSigner[]): TrustRoot {
  const keys = signers.map((signer): TrustedKey => {
    if (signer.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new IssuerRefused('SELF_CHECK_FAILED');
    }
    return {
      key_id: signer.keyId,
      algorithm: 'ed25519',
      public_key: signer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      purposes: [purpose],
      retired_on: null,
      compromised_on: null,
      test_only: signer.rehearsal === true,
      publicKey: signer.publicKey,
    };
  });
  const thresholds = Object.fromEntries(
    DOCUMENT_PURPOSES.map((name) => [name, signers.length]),
  ) as Record<DocumentPurpose, number>;
  return { keys, thresholds };
}

/**
 * Wraps a validated document in an envelope. Refuses a document its own schema would refuse, and signs what
 * the schema returned, so a field the schema does not know is never signed. Then it verifies its own output
 * as a customer would, because a mistake here reaches someone who may never get a correction (ADR-030).
 */
export async function issueDocument<P extends DocumentPurpose>(
  purpose: P,
  document: DocumentFor<P>,
  signers: readonly DocumentSigner[],
): Promise<string> {
  if (signers.length === 0) throw new IssuerRefused('NO_SIGNER');
  if (new Set(signers.map(({ keyId }) => keyId)).size !== signers.length) {
    throw new IssuerRefused('SIGNER_REPEATED');
  }
  const parsed = DOCUMENT_SCHEMAS[purpose].safeParse(document);
  if (!parsed.success) throw new IssuerRefused('DOCUMENT_INVALID', failedFields(parsed.error));

  const payload = Buffer.from(JSON.stringify(parsed.data));
  const payloadType = PAYLOAD_TYPES[purpose];
  const signed = preAuthEncoding(payloadType, payload);
  const envelope = JSON.stringify({
    payloadType,
    payload: payload.toString('base64'),
    signatures: await Promise.all(
      signers.map(async (signer) => ({
        keyid: signer.keyId,
        sig: (await signer.sign(signed)).toString('base64'),
      })),
    ),
  });

  if (!verifyDocument(purpose, envelope, rootOfSigners(purpose, signers)).ok) {
    throw new IssuerRefused('SELF_CHECK_FAILED');
  }
  return envelope;
}

/** One line of the issuer's append-only register. IDs, hashes and the key used, and nothing confidential. */
export type IssueRecord = {
  issued_at: string;
  purpose: DocumentPurpose;
  document_id: string;
  envelope_sha256: string;
  key_ids: readonly string[];
  rehearsal: boolean;
};

export type IssuerIo = {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer | string): Promise<void>;
  appendFile(path: string, data: string): Promise<void>;
  out(line: string): void;
  err(line: string): void;
  now(): Date;
};

const OK = 0;
const REFUSED = 1;
const BAD_INPUT = 2;

/** Stops a command with a code. Names fields, never values, since these files hold a customer's name. */
class Stop extends Error {
  constructor(
    readonly reason: string,
    readonly status: number = BAD_INPUT,
    readonly fields: readonly string[] = [],
  ) {
    super(reason);
  }
}

// Each file is read through a strict copy of the document's own rules. A missing value is an error, an
// unknown one is an error, and there is no default anywhere, because each value is the owner's decision
// (ADR-030 D5). The document schemas are loose on purpose, for readers. A person writing a file is not a
// reader, and a misspelt right must not simply vanish.
const license = licenseDocumentSchema.shape;
const [perpetualTerm, pilotTerm] = license.term.options;
const rightsFileSchema = z.strictObject({
  licensee: z.strictObject(license.licensee.shape),
  term: z.discriminatedUnion('kind', [
    z.strictObject(perpetualTerm.shape),
    z.strictObject(pilotTerm.shape),
  ]),
  licensed_release: z
    .strictObject(license.licensed_release.shape)
    .refine(({ line, version }) => version.startsWith(`${line}.`), { path: ['line'] }),
  footprint: z.strictObject(license.footprint.shape),
  components: license.components,
  update_rights: z.strictObject(license.update_rights.shape),
});

const maintenance = maintenanceDocumentSchema.shape;
const statementFileSchema = z.strictObject({
  license_id: maintenance.license_id,
  starts_on: maintenance.starts_on,
  ends_on: maintenance.ends_on,
});

const advisory = advisoryDocumentSchema.shape;
const advisoryFileSchema = z.strictObject({
  advisory_id: advisory.advisory_id,
  severity: advisory.severity,
  title: advisory.title,
  summary: advisory.summary,
  affected_versions: advisory.affected_versions,
  fixed_in_versions: advisory.fixed_in_versions,
});

const policy = supportPolicyDocumentSchema.shape;
const policyFileSchema = z.strictObject({
  branches: z.array(z.strictObject(policy.branches.element.shape)).max(256),
  security_patches_after_lapse_grant: policy.security_patches_after_lapse_grant,
});

async function readChecked<S extends z.ZodType>(
  io: IssuerIo,
  path: string,
  schema: S,
): Promise<z.infer<S>> {
  let text: string;
  try {
    text = (await io.readFile(path)).toString('utf8');
  } catch {
    throw new Stop('INPUT_UNREADABLE');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Stop('INPUT_NOT_JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Stop('INPUT_INVALID', BAD_INPUT, [
      ...failedFields(parsed.error),
      // A field that should not be there is named by the parser in `keys`, not in `path`.
      ...parsed.error.issues.flatMap((issue) => ('keys' in issue ? issue.keys : [])),
    ]);
  }
  return parsed.data;
}

function readOptions<const O extends Record<string, { type: 'string' | 'boolean' }>>(
  args: readonly string[],
  options: O,
) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch {
    // Also how `--test-only false`, or anything else not on this list, gets its answer.
    throw new Stop('NOT_AN_OPTION');
  }
}

const required = (value: string | undefined, name: string) => {
  if (!value) throw new Stop(`${name}_REQUIRED`);
  return value;
};

const ISSUING_OPTIONS = {
  signer: { type: 'string', multiple: true },
  rehearsal: { type: 'boolean' },
  out: { type: 'string' },
  register: { type: 'string' },
} as const;

type IssuingValues = {
  signer?: string[] | undefined;
  rehearsal?: boolean | undefined;
  out?: string | undefined;
  register?: string | undefined;
};

/** `--signer <key id>=<private key file>`, as many as the threshold needs. */
async function readSigners(io: IssuerIo, values: IssuingValues) {
  // Asked for by name each time, so nobody can issue a rehearsal document by accident of a script.
  if (values.rehearsal !== true) throw new Stop('REHEARSAL_ONLY');
  const given = values.signer ?? [];
  if (given.length === 0) throw new Stop('SIGNER_REQUIRED');
  return Promise.all(
    given.map(async (entry) => {
      const split = entry.indexOf('=');
      if (split < 1) throw new Stop('SIGNER_NOT_ID_AND_FILE');
      let pem: Buffer;
      try {
        pem = await io.readFile(entry.slice(split + 1));
      } catch {
        throw new Stop('KEY_UNREADABLE');
      }
      return rehearsalSigner(entry.slice(0, split), pem, true);
    }),
  );
}

/** Signs, records, then writes. A line with no file is harmless, and a file with no line is not. */
async function issueAndRecord<P extends DocumentPurpose>(
  io: IssuerIo,
  purpose: P,
  document: DocumentFor<P>,
  documentId: string,
  values: IssuingValues,
) {
  const out = required(values.out, 'OUT');
  const register = required(values.register, 'REGISTER');
  const signers = await readSigners(io, values);
  const envelope = await issueDocument(purpose, document, signers);
  const record: IssueRecord = {
    issued_at: (document as { issued_at: string }).issued_at,
    purpose,
    document_id: documentId,
    envelope_sha256: createHash('sha256').update(envelope).digest('hex'),
    key_ids: signers.map(({ keyId }) => keyId),
    rehearsal: signers.some(({ rehearsal }) => rehearsal === true),
  };
  try {
    await io.appendFile(register, `${JSON.stringify(record)}\n`);
  } catch {
    throw new Stop('REGISTER_NOT_WRITTEN', REFUSED);
  }
  try {
    await io.writeFile(out, envelope);
  } catch {
    throw new Stop('OUTPUT_NOT_WRITTEN', REFUSED);
  }
  io.out(
    `Issued ${purpose} ${documentId}, sha256 ${record.envelope_sha256}, keys ${record.key_ids.join(',')}, rehearsal.`,
  );
  return OK;
}

async function keygenCommand(args: readonly string[], io: IssuerIo) {
  const { values } = readOptions(args, {
    'key-id': { type: 'string' },
    purposes: { type: 'string' },
    out: { type: 'string' },
    'trust-root-out': { type: 'string' },
  });
  const keyId = required(values['key-id'], 'KEY_ID');
  if (!KEY_ID.test(keyId)) throw new Stop('KEY_ID_INVALID');
  const out = required(values.out, 'OUT');
  // No default: which kinds of document one key may sign is what the outside review looks at (ADR-030 D3).
  const purposes = required(values.purposes, 'PURPOSES').split(',');
  if (purposes.some((purpose) => !(DOCUMENT_PURPOSES as readonly string[]).includes(purpose))) {
    throw new Stop('PURPOSE_UNKNOWN');
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const entry = {
    key_id: keyId,
    algorithm: 'ed25519',
    public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    purposes: [...new Set(purposes)],
    retired_on: null,
    compromised_on: null,
    // A literal, and no option reaches it. Taking it away needs the custody decision and a new signer.
    test_only: true,
  };
  try {
    await io.writeFile(out, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  } catch {
    throw new Stop('OUTPUT_NOT_WRITTEN', REFUSED);
  }
  if (values['trust-root-out']) {
    const root = { format: 'ensemus.trust_root', format_version: 1, keys: [entry], thresholds: {} };
    try {
      await io.writeFile(values['trust-root-out'], `${JSON.stringify(root, null, 2)}\n`);
    } catch {
      throw new Stop('OUTPUT_NOT_WRITTEN', REFUSED);
    }
  }
  io.out(JSON.stringify(entry));
  return OK;
}

async function licenseCommand(args: readonly string[], io: IssuerIo) {
  const { values } = readOptions(args, { ...ISSUING_OPTIONS, rights: { type: 'string' } });
  const rights = await readChecked(io, required(values.rights, 'RIGHTS'), rightsFileSchema);
  const licenseId = randomUUID();
  return issueAndRecord(
    io,
    'license',
    {
      format: 'ensemus.license',
      format_version: 1,
      license_id: licenseId,
      issued_at: io.now().toISOString(),
      edition: 'sovereign',
      ...rights,
    },
    licenseId,
    values,
  );
}

async function maintenanceCommand(args: readonly string[], io: IssuerIo) {
  const { values } = readOptions(args, { ...ISSUING_OPTIONS, statement: { type: 'string' } });
  const statement = await readChecked(
    io,
    required(values.statement, 'STATEMENT'),
    statementFileSchema,
  );
  const maintenanceId = randomUUID();
  return issueAndRecord(
    io,
    'maintenance',
    {
      format: 'ensemus.maintenance',
      format_version: 1,
      maintenance_id: maintenanceId,
      issued_at: io.now().toISOString(),
      ...statement,
    },
    maintenanceId,
    values,
  );
}

async function advisoryCommand(args: readonly string[], io: IssuerIo) {
  const { values } = readOptions(args, { ...ISSUING_OPTIONS, advisory: { type: 'string' } });
  const notice = await readChecked(io, required(values.advisory, 'ADVISORY'), advisoryFileSchema);
  return issueAndRecord(
    io,
    'advisory',
    {
      format: 'ensemus.advisory',
      format_version: 1,
      issued_at: io.now().toISOString(),
      ...notice,
    },
    notice.advisory_id,
    values,
  );
}

async function supportPolicyCommand(args: readonly string[], io: IssuerIo) {
  const { values } = readOptions(args, { ...ISSUING_OPTIONS, policy: { type: 'string' } });
  const stated = await readChecked(io, required(values.policy, 'POLICY'), policyFileSchema);
  const policyId = randomUUID();
  return issueAndRecord(
    io,
    'support_policy',
    {
      format: 'ensemus.support_policy',
      format_version: 1,
      policy_id: policyId,
      issued_at: io.now().toISOString(),
      ...stated,
    },
    policyId,
    values,
  );
}

const PURPOSE_OF_TYPE = new Map<string, DocumentPurpose>(
  DOCUMENT_PURPOSES.map((purpose) => [PAYLOAD_TYPES[purpose], purpose]),
);

/** The IDs a person needs in order to find a document in the register. Never a licensee's name. */
function documentIdOf(document: Record<string, unknown>): string {
  // A maintenance statement also names its license, so its own ID has to be looked for first.
  for (const field of ['maintenance_id', 'license_id', 'advisory_id', 'policy_id', 'bundle_id']) {
    const value = document[field];
    if (typeof value === 'string') return value;
  }
  return 'no-id';
}

async function verifyCommand(args: readonly string[], io: IssuerIo) {
  const { values, positionals } = readOptions(args, { 'trust-root': { type: 'string' } });
  const [file, ...rest] = positionals;
  if (!file || rest.length > 0) throw new Stop('FILE_REQUIRED');

  let rootText: string;
  try {
    rootText = (await io.readFile(required(values['trust-root'], 'TRUST_ROOT'))).toString('utf8');
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop('TRUST_ROOT_UNREADABLE');
  }
  let root: TrustRoot;
  try {
    root = parseTrustRoot(rootText);
  } catch {
    throw new Stop('TRUST_ROOT_UNREADABLE');
  }
  let text: string;
  try {
    text = (await io.readFile(file)).toString('utf8');
  } catch {
    throw new Stop('INPUT_UNREADABLE');
  }

  let payloadType: unknown;
  try {
    payloadType = (JSON.parse(text) as { payloadType?: unknown }).payloadType;
  } catch {
    throw new Stop('MALFORMED', REFUSED);
  }
  const purpose = typeof payloadType === 'string' ? PURPOSE_OF_TYPE.get(payloadType) : undefined;
  if (!purpose) throw new Stop('WRONG_TYPE', REFUSED);

  const verdict = verifyDocument(purpose, text, root);
  if (!verdict.ok) throw new Stop(verdict.code, REFUSED);
  io.out(
    `Verified ${purpose} ${documentIdOf(verdict.document as Record<string, unknown>)}, keys ${verdict.keyIds.join(',')}, test key ${String(verdict.testKey)}, retired key ${String(verdict.retiredKey)}.`,
  );
  return OK;
}

const COMMANDS: Record<string, (args: readonly string[], io: IssuerIo) => Promise<number>> = {
  keygen: keygenCommand,
  license: licenseCommand,
  maintenance: maintenanceCommand,
  advisory: advisoryCommand,
  'support-policy': supportPolicyCommand,
  verify: verifyCommand,
};

/**
 * The command line: `keygen`, `license`, `maintenance`, `advisory`, `support-policy`, `verify`. Takes its
 * rights and policy from a file with no defaults, so nothing here chooses what the owner decides. Returns
 * an exit status, and takes its file and console access as arguments so a test can run it whole.
 */
export async function runIssuerCommand(argv: readonly string[], io: IssuerIo): Promise<number> {
  const [name, ...args] = argv;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!command || !Object.hasOwn(COMMANDS, name as string)) {
    io.err(`COMMAND_UNKNOWN: use one of ${Object.keys(COMMANDS).join(', ')}`);
    return BAD_INPUT;
  }
  try {
    return await command(args, io);
  } catch (error) {
    if (error instanceof Stop) {
      io.err(error.fields.length ? `${error.reason}: ${error.fields.join(', ')}` : error.reason);
      return error.status;
    }
    if (error instanceof IssuerRefused) {
      io.err(error.fields.length ? `${error.code}: ${error.fields.join(', ')}` : error.code);
      return error.code === 'SELF_CHECK_FAILED' ? REFUSED : BAD_INPUT;
    }
    io.err('ISSUER_FAILED');
    return REFUSED;
  }
}
