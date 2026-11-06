// What `node dist/sovereign-license.js` does (COMM-03, SOV-02). It answers with one line of JSON holding
// a standing, IDs, codes and notices, and never a licensee's name or the file itself.
//   node dist/sovereign-license.js verify <file> [--trust-root <file>]
//   node dist/sovereign-license.js install --organization <id> <file>
// verify opens no database and needs no organization, so it works on a first boot. install reads its trust
// root from ENSEMUS_LICENSE_TRUST_ROOT_FILE, the same one this deployment reads a license with, so a file
// it accepts is one the deployment can read back.
//
// The exit status says what happened to the file, and nothing else about it:
//   0  it verified. A lapsed license, a test key or a stopped clock is still 0, with a notice.
//   1  the file does not verify, or was refused for what it says.
//   2  the question could not be asked: a bad argument, no usable trust root, or a trust root that does
//      not know the file's signer, which is what a wrong trust root looks like from here.
// Anything else thrown, such as a database that cannot be reached, is left to the entry point (exit 3).
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  AppError,
  checkSignedDocument,
  getLicenseStatus,
  installSignedDocument,
  type CheckedDocument,
} from '@ensemus/application';
import { ConfigError } from '@ensemus/config';
import { loadSovereignConfig } from '@ensemus/config/sovereign';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { dayOf, licenseNotices, maintenanceStatus, type LicenseNotice } from '@ensemus/domain/license';
import { MAX_ENVELOPE_BYTES } from '@ensemus/sovereign/envelope';
import { loadTrustRootFile, type TrustRoot } from '@ensemus/sovereign/trust-root';

export const VERIFIED = 0;
export const NOT_VERIFIED = 1;
export const CANNOT_CHECK = 2;

export type LicenseCommandDeps = {
  /** Called only by `install`, and only once the file has verified. */
  openDatabase: () => { db: AppDatabase; close: () => Promise<void> };
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The real services unless a test without PostgreSQL stands in for them. */
  services?: {
    installSignedDocument: typeof installSignedDocument;
    getLicenseStatus: typeof getLicenseStatus;
  };
};

/** Stops the command before it has done anything, with a code from our own list. */
class Refused extends Error {
  constructor(
    readonly exitCode: number,
    readonly reasonCode: string,
  ) {
    super(reasonCode);
  }
}

function parseCommand(args: string[]) {
  const [command, ...rest] = args;
  try {
    if (command === 'verify') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { 'trust-root': { type: 'string' } },
      });
      const [file] = positionals;
      if (positionals.length !== 1 || !file) throw new Refused(CANNOT_CHECK, 'NOT_AN_OPTION');
      return { command, file, trustRootFile: values['trust-root'] ?? null } as const;
    }
    if (command === 'install') {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { organization: { type: 'string' } },
      });
      const [file] = positionals;
      if (positionals.length !== 1 || !file || !values.organization) {
        throw new Refused(CANNOT_CHECK, 'NOT_AN_OPTION');
      }
      return { command, file, organization: values.organization } as const;
    }
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(CANNOT_CHECK, 'NOT_AN_OPTION');
  }
  throw new Refused(CANNOT_CHECK, 'NOT_A_COMMAND');
}

function readTrustRoot(given: string | null, env: NodeJS.ProcessEnv): TrustRoot {
  let path = given;
  if (path === null) {
    try {
      path = loadSovereignConfig(env).trustRootFile;
    } catch (error) {
      if (error instanceof ConfigError) throw new Refused(CANNOT_CHECK, 'TRUST_ROOT_NOT_CONFIGURED');
      throw error;
    }
  }
  if (path === null) throw new Refused(CANNOT_CHECK, 'TRUST_ROOT_NOT_CONFIGURED');
  try {
    return loadTrustRootFile(path);
  } catch {
    // Its one error has fixed text, since the file is not ours and its contents stay out of a log.
    throw new Refused(CANNOT_CHECK, 'TRUST_ROOT_UNREADABLE');
  }
}

/** The file exactly as it is on disk, since nothing here may reformat what was signed. */
function readDocumentFile(path: string): string {
  try {
    if (statSync(path).size > MAX_ENVELOPE_BYTES) throw new Refused(NOT_VERIFIED, 'TOO_LARGE');
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(NOT_VERIFIED, 'FILE_UNREADABLE');
  }
}

/** Verifies the file, and turns a refusal into the exit status that says whose problem it is. */
function verifyFile(text: string, root: TrustRoot): CheckedDocument {
  const check = checkSignedDocument(text, root);
  if (check.ok) return check.checked;
  throw new Refused(check.code === 'UNKNOWN_KEY' ? CANNOT_CHECK : NOT_VERIFIED, check.code);
}

/** Fields for what was checked. IDs and codes, so a licensee's name has nowhere to go. */
function fieldsFor(checked: CheckedDocument) {
  return {
    type: checked.type,
    documentId: checked.documentId,
    ...(checked.type === 'maintenance' ? { licenseId: checked.document.license_id } : {}),
    keyIds: checked.keyIds,
    testKey: checked.testKey,
    retiredKey: checked.retiredKey,
  };
}

/**
 * What this one file says by itself. There is no database here, so whether maintenance exists is not
 * known, and saying `no_maintenance` would state something this has not looked at.
 */
function noticesForFile(checked: CheckedDocument, today: string): readonly LicenseNotice[] {
  if (checked.type !== 'license') {
    return [
      ...(checked.testKey ? (['signed_with_test_key'] as const) : []),
      ...(checked.retiredKey ? (['signed_with_retired_key'] as const) : []),
    ];
  }
  return licenseNotices({
    standing: 'licensed',
    license: checked.document,
    maintenance: maintenanceStatus([], today),
    today,
    signedWithTestKey: checked.testKey,
    signedWithRetiredKey: checked.retiredKey,
    runningReleaseCovered: null,
    seatsInUse: null,
  }).filter((notice) => notice !== 'no_maintenance');
}

export async function licenseCommand(args: string[], deps: LicenseCommandDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const out = deps.out ?? ((line) => void process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line) => void process.stderr.write(`${line}\n`));
  const services = deps.services ?? { installSignedDocument, getLicenseStatus };

  let commandName: string | undefined;
  try {
    const parsed = parseCommand(args);
    commandName = parsed.command;

    if (parsed.command === 'verify') {
      const root = readTrustRoot(parsed.trustRootFile, env);
      const checked = verifyFile(readDocumentFile(parsed.file), root);
      out(
        JSON.stringify({
          command: parsed.command,
          ok: true,
          // Only a license has a standing. A maintenance statement by itself says nothing about one.
          standing: checked.type === 'license' ? 'licensed' : null,
          ...fieldsFor(checked),
          notices: noticesForFile(checked, dayOf(now())),
        }),
      );
      return VERIFIED;
    }

    let context;
    try {
      context = createServiceContext(parsed.organization);
    } catch {
      throw new Refused(CANNOT_CHECK, 'NOT_AN_ORGANIZATION_ID');
    }
    const trustRoot = readTrustRoot(null, env);
    const envelope = readDocumentFile(parsed.file);
    const checked = verifyFile(envelope, trustRoot);

    const { db, close } = deps.openDatabase();
    try {
      const installed = await services.installSignedDocument(
        db,
        context,
        { envelope },
        { trustRoot },
      );
      const status = await services.getLicenseStatus(db, context, {
        trustRoot,
        runningRelease: null,
        now,
      });
      out(
        JSON.stringify({
          command: parsed.command,
          ok: true,
          organizationId: context.organizationId,
          recordId: installed.id,
          created: installed.created,
          standing: status.standing,
          ...fieldsFor(checked),
          maintenance: status.maintenance.status,
          notices: status.notices,
        }),
      );
      return VERIFIED;
    } finally {
      await close();
    }
  } catch (error) {
    if (error instanceof Refused) {
      err(
        JSON.stringify({
          command: commandName ?? null,
          ok: false,
          reasonCode: error.reasonCode,
        }),
      );
      return error.exitCode;
    }
    // A maintenance statement for a license not installed here. Verified, and refused, and nothing stored.
    if (error instanceof AppError && error.code === 'LICENSE_NOT_VALID') {
      err(JSON.stringify({ command: commandName ?? null, ok: false, reasonCode: error.code }));
      return NOT_VERIFIED;
    }
    throw error;
  }
}
