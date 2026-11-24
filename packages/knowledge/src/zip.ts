// A ZIP reader for Office documents (ADR-029 D4 addendum), over Node's own zlib and nothing else. It reads
// the central directory, refuses what an Office file never needs (encryption, ZIP64, multiple disks,
// methods other than stored and deflate, duplicate or escaping names), and inflates one named entry at a
// time with a hard output ceiling, so a bomb stops at its declared size instead of at the heap's.
import { crc32, inflateRawSync } from 'node:zlib';

export type ZipLimits = {
  /** Entries in the central directory. An Office file has dozens; thousands is not a document. */
  maxEntries: number;
  /** Uncompressed bytes of any one entry. */
  maxEntryBytes: number;
  /** Uncompressed bytes actually inflated across every read of this archive. */
  maxTotalBytes: number;
  /** Uncompressed to compressed, for any entry over 64 KiB. */
  maxRatio: number;
};

export const OFFICE_ZIP_LIMITS: ZipLimits = {
  maxEntries: 4_000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxRatio: 200,
};

/** Why an archive was refused. Codes only: a file's own words never reach a log or a row. */
// No parameter properties: the parse thread loads this file with Node's type stripping in tests.
export class ZipRefused extends Error {
  readonly code: 'TOO_LARGE' | 'MALFORMED_DOCUMENT' | 'ENCRYPTED_DOCUMENT';
  constructor(code: 'TOO_LARGE' | 'MALFORMED_DOCUMENT' | 'ENCRYPTED_DOCUMENT') {
    super(code);
    this.code = code;
    this.name = 'ZipRefused';
  }
}

type Entry = {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

export type ZipArchive = {
  readonly names: readonly string[];
  has(name: string): boolean;
  /** The entry's bytes, or null when there is no such entry. Throws ZipRefused past any limit. */
  read(name: string): Uint8Array | null;
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;

export function openZip(bytes: Uint8Array, limits: ZipLimits = OFFICE_ZIP_LIMITS): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const malformed = () => new ZipRefused('MALFORMED_DOCUMENT');
  const u16 = (at: number) => {
    if (at < 0 || at + 2 > bytes.length) throw malformed();
    return view.getUint16(at, true);
  };
  const u32 = (at: number) => {
    if (at < 0 || at + 4 > bytes.length) throw malformed();
    return view.getUint32(at, true);
  };

  // The end record is the last 22 bytes plus a comment of at most 65,535. Exactly one reading must fit.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (u32(at) === EOCD && at + 22 + u16(at + 20) === bytes.length) {
      end = at;
      break;
    }
  }
  if (end < 0) throw malformed();
  if (end >= 20 && u32(end - 20) === ZIP64_LOCATOR) throw malformed();
  const disk = u16(end + 4),
    directoryDisk = u16(end + 6),
    onDisk = u16(end + 8),
    total = u16(end + 10),
    directorySize = u32(end + 12),
    directoryOffset = u32(end + 16);
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== total) throw malformed();
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw malformed();
  if (total > limits.maxEntries) throw new ZipRefused('TOO_LARGE');
  if (directoryOffset + directorySize > end) throw malformed();

  const entries = new Map<string, Entry>();
  let declared = 0;
  let at = directoryOffset;
  for (let index = 0; index < total; index += 1) {
    if (u32(at) !== CENTRAL) throw malformed();
    const flags = u16(at + 8),
      method = u16(at + 10),
      crc = u32(at + 16),
      compressedSize = u32(at + 20),
      size = u32(at + 24),
      nameLength = u16(at + 28),
      extraLength = u16(at + 30),
      commentLength = u16(at + 32),
      localOffset = u32(at + 42);
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > directoryOffset + directorySize) throw malformed();
    const name = decodeName(bytes.subarray(at + 46, nameEnd), flags);
    // Bit 0 is traditional encryption, bit 6 strong encryption, bit 13 an encrypted directory.
    if (flags & 0x0001 || flags & 0x0040 || flags & 0x2000)
      throw new ZipRefused('ENCRYPTED_DOCUMENT');
    if (method !== 0 && method !== 8) throw malformed();
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw malformed();
    if (!name || name.includes('\0') || name.includes('\\') || entries.has(name)) throw malformed();
    if (name.startsWith('/') || name.split('/').some((part) => part === '..')) throw malformed();
    if (method === 0 && compressedSize !== size) throw malformed();
    if (size > limits.maxEntryBytes) throw new ZipRefused('TOO_LARGE');
    if (size > 65_536 && size > Math.max(1, compressedSize) * limits.maxRatio)
      throw new ZipRefused('TOO_LARGE');
    declared += size;
    if (localOffset >= directoryOffset) throw malformed();
    entries.set(name, { name, flags, method, crc, compressedSize, size, localOffset });
    at = nameEnd + extraLength + commentLength;
  }
  if (at !== directoryOffset + directorySize) throw malformed();
  // A declared total is a promise the bytes can break; `inflated` below is what is actually held to.
  if (declared > limits.maxTotalBytes * 4) throw new ZipRefused('TOO_LARGE');

  let inflated = 0;
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (inflated + entry.size > limits.maxTotalBytes) throw new ZipRefused('TOO_LARGE');
      const local = entry.localOffset;
      if (u32(local) !== LOCAL) throw malformed();
      const localNameLength = u16(local + 26),
        localExtraLength = u16(local + 28);
      const localName = decodeName(
        bytes.subarray(local + 30, local + 30 + localNameLength),
        entry.flags,
      );
      // The two headers must name the same thing, or a reader and a scanner could see different files.
      if (localName !== entry.name || u16(local + 8) !== entry.method) throw malformed();
      const start = local + 30 + localNameLength + localExtraLength;
      const stop = start + entry.compressedSize;
      if (stop > directoryOffset) throw malformed();
      const data = bytes.subarray(start, stop);
      let output: Uint8Array;
      if (entry.method === 0) output = data;
      else {
        try {
          // Refuses to produce one byte past what the directory declared.
          output = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
        } catch (error) {
          throw (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
            ? new ZipRefused('TOO_LARGE')
            : malformed();
        }
      }
      if (output.length !== entry.size || crc32(output) !== entry.crc) throw malformed();
      inflated += output.length;
      return output;
    },
  };
}

function decodeName(bytes: Uint8Array, flags: number): string {
  // Bit 11 says UTF-8. Otherwise the name is code page 437, which agrees with ASCII for Office parts.
  if (flags & 0x0800) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ZipRefused('MALFORMED_DOCUMENT');
    }
  }
  return Buffer.from(bytes).toString('latin1');
}
