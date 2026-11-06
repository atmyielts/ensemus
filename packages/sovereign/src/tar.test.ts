import { describe, expect, it } from 'vitest';
import { readTarEntries, tarEnd, tarHeader, tarPadding, TarRefused, type TarEntry } from './tar';

const archive = (files: readonly [string, Buffer][]) =>
  Buffer.concat([
    ...files.flatMap(([name, body]) => [
      tarHeader(name, body.length),
      body,
      tarPadding(body.length),
    ]),
    tarEnd(),
  ]);

async function read(bytes: Buffer) {
  const found: TarEntry[] = [];
  const reader = async (offset: number, length: number) => bytes.subarray(offset, offset + length);
  for await (const entry of readTarEntries(reader, bytes.length)) found.push(entry);
  return found;
}

describe('tar', () => {
  it('reads back what it wrote, at the right offsets', async () => {
    const first = Buffer.from('first file');
    const second = Buffer.alloc(1024, 7);
    const bytes = archive([
      ['work/a-000001.jsonl.sealed', first],
      ['manifest.json.sealed', second],
    ]);
    const [a, b, ...rest] = await read(bytes);
    expect(rest).toEqual([]);
    expect(a?.path).toBe('work/a-000001.jsonl.sealed');
    expect(bytes.subarray(a?.offset ?? 0, (a?.offset ?? 0) + (a?.size ?? 0)).equals(first)).toBe(
      true,
    );
    expect(b?.size).toBe(1024);
  });

  it('handles an empty archive and an empty file', async () => {
    expect(await read(tarEnd())).toEqual([]);
    expect(await read(archive([['x', Buffer.alloc(0)]]))).toHaveLength(1);
  });

  it('refuses a cut-off archive, since a lost end marker can mean lost parts', async () => {
    const bytes = archive([['x', Buffer.alloc(600, 1)]]);
    await expect(read(bytes.subarray(0, bytes.length - 1024))).rejects.toThrow(TarRefused);
    await expect(read(bytes.subarray(0, 700))).rejects.toThrow(TarRefused);
  });

  it('refuses a bad checksum', async () => {
    const bytes = archive([['x', Buffer.from('y')]]);
    bytes[0] = 0x7a;
    await expect(read(bytes)).rejects.toThrow(TarRefused);
  });

  const withType = (type: string) => {
    const bytes = archive([['x', Buffer.from('y')]]);
    bytes.write(type, 156, 'ascii');
    bytes.fill(' ', 148, 156);
    const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    bytes.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return bytes;
  };

  it.each([
    ['a symbolic link', '2'],
    ['a hard link', '1'],
    ['a directory', '5'],
    ['a pax header', 'x'],
  ])('refuses %s', async (_, type) => {
    await expect(read(withType(type))).rejects.toThrow(TarRefused);
  });

  it('refuses a size that runs past the end', async () => {
    const bytes = archive([['x', Buffer.from('y')]]);
    bytes.write('77777777777\0', 124, 'ascii');
    bytes.fill(' ', 148, 156);
    const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    bytes.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    await expect(read(bytes)).rejects.toThrow(TarRefused);
  });

  it('will not write a name or a size that does not fit', () => {
    expect(() => tarHeader('x'.repeat(101), 1)).toThrow();
    expect(() => tarHeader('', 1)).toThrow();
    expect(() => tarHeader('x', -1)).toThrow();
  });
});
