// The customer's own tool: makes the pair an export, a backup or a diagnostic bundle is sealed to. The public
// half is printed, to give to whoever seals. The private half goes to a file only this user can read, and is
// never printed, since a terminal's scrollback is not somewhere it should ever live. Runs with only Node, so
// nobody needs us or our image to make a key or to keep using one (ADR-030 D6, D7).
//   node recipient-key.mjs --out <file>
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  exportRecipientPublicKey,
  generateRecipientKeyPair,
  recipientKeyId,
} from '@ensemus/sovereign/sealed';

const OWNER_ONLY = 0o600;

export type ToolIo = { out(line: string): void; err(line: string): void };

/** Writes the private key, and returns only what is safe to show. Never replaces a key already there. */
export async function writeRecipientKey(path: string) {
  const { publicKey, privateKey } = generateRecipientKeyPair();
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await writeFile(path, pem, { flag: 'wx', mode: OWNER_ONLY });
  return { publicKey: exportRecipientPublicKey(publicKey), keyId: recipientKeyId(publicKey) };
}

export async function recipientKeyCommand(args: readonly string[], io: ToolIo): Promise<number> {
  let out: string | undefined;
  try {
    out = parseArgs({ args: [...args], options: { out: { type: 'string' } } }).values.out;
  } catch {
    io.err('NOT_AN_OPTION');
    return 2;
  }
  if (!out) {
    io.err('OUT_REQUIRED: name the file for the private key with --out');
    return 2;
  }
  try {
    const { publicKey, keyId } = await writeRecipientKey(out);
    io.out(`public key: ${publicKey}`);
    io.out(`key id: ${keyId}`);
    io.out('The private key is in the file you named. It is not printed, and only you can open');
    io.out('what is sealed to this key: if that file is lost, so is what was sealed to it.');
    if (process.platform === 'win32') {
      io.out('Windows does not apply file modes, so keep that file in a folder only you can read.');
    }
    return 0;
  } catch (error) {
    io.err(
      (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'OUT_EXISTS: this tool never replaces a key'
        : 'OUT_NOT_WRITTEN',
    );
    return 1;
  }
}

// Only when run directly, because a test imports this file. A bundle's own path is what Node was told to run.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await recipientKeyCommand(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
