// A plain ustar archive, so a customer can open an export with the tar they already have (ADR-030 D7).
// Small on purpose: regular files only, names up to 100 bytes, and sizes that fit the octal field. The
// reader treats its input as hostile. It refuses anything else, and it never touches a file system, so a
// name in an archive can only ever be a string that a caller checks against its own allowlist.
const BLOCK = 512;
const MAX_NAME_BYTES = 100;
/** What eleven octal digits can say. */
export const MAX_TAR_ENTRY_BYTES = 8 * 1024 * 1024 * 1024 - 1;

const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0');

/** The 512-byte header for one file. `mtimeSeconds` is the caller's, so an archive can be repeatable. */
export function tarHeader(path: string, size: number, mtimeSeconds = 0): Buffer {
  const name = Buffer.from(path, 'utf8');
  if (name.length === 0 || name.length > MAX_NAME_BYTES) throw new Error('Name does not fit');
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TAR_ENTRY_BYTES) {
    throw new Error('Size does not fit');
  }
  const header = Buffer.alloc(BLOCK);
  name.copy(header, 0);
  header.write(octal(0o600, 8), 100, 'ascii');
  header.write(octal(0, 8), 108, 'ascii');
  header.write(octal(0, 8), 116, 'ascii');
  header.write(octal(size, 12), 124, 'ascii');
  header.write(octal(mtimeSeconds, 12), 136, 'ascii');
  header.fill(' ', 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${octal(checksum, 7)}\0 `, 148, 'ascii');
  return header;
}

/** Zeros that bring a file's bytes up to a whole block. */
export const tarPadding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
/** Two empty blocks end an archive. */
export const tarEnd = () => Buffer.alloc(BLOCK * 2);

export class TarRefused extends Error {
  override name = 'TarRefused';
  constructor() {
    super('Not an archive this reader accepts');
  }
}

export type TarEntry = { path: string; offset: number; size: number };

/** Reads bytes at an offset. Lets the reader walk a large file without holding it. */
export type ReadAt = (offset: number, length: number) => Promise<Buffer>;

function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function parseOctal(text: string): number {
  const digits = text.trim();
  if (!/^[0-7]{1,11}$/.test(digits)) throw new TarRefused();
  return Number.parseInt(digits, 8);
}

/**
 * Walks an archive and yields where each file's bytes are. Refuses a bad checksum, anything that is not a
 * regular file, an entry past the end, and an archive with no end marker, since that means it was cut off.
 */
export async function* readTarEntries(read: ReadAt, totalBytes: number): AsyncGenerator<TarEntry> {
  let offset = 0;
  while (offset + BLOCK <= totalBytes) {
    const header = await read(offset, BLOCK);
    if (header.length !== BLOCK) throw new TarRefused();
    if (header.every((byte) => byte === 0)) return;

    const stored = parseOctal(field(header, 148, 8));
    const copy = Buffer.from(header);
    copy.fill(' ', 148, 156);
    if (copy.reduce((sum, byte) => sum + byte, 0) !== stored) throw new TarRefused();
    if (field(header, 257, 5) !== 'ustar') throw new TarRefused();
    const type = header[156];
    if (type !== 0x30 && type !== 0) throw new TarRefused();
    // A prefix field joins onto the name in ways a caller would not see. This format never writes one.
    if (field(header, 345, 155) !== '') throw new TarRefused();

    const path = field(header, 0, 100);
    const size = parseOctal(field(header, 124, 12));
    const start = offset + BLOCK;
    if (start + size > totalBytes) throw new TarRefused();
    yield { path, offset: start, size };
    offset = start + size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  throw new TarRefused();
}
