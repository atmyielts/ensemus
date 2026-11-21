import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestBundle, generateTestKey } from '@ensemus/skills/testing';

const root = resolve(import.meta.dirname, '../..');
const tool = join(root, 'packages/skills/scripts/skill-tool.ts');
const folders: string[] = [];
const temp = () => {
  const folder = mkdtempSync(join(tmpdir(), 'ensemus-skill-tool-'));
  folders.push(folder);
  return folder;
};
const run = (...args: string[]) =>
  spawnSync(process.execPath, ['--experimental-strip-types', tool, ...args], {
    encoding: 'utf8',
    cwd: root,
    timeout: 20_000,
  });
afterEach(() => {
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith('ensemus-skill-tool-')
    )
      throw new Error('Refused unexpected cleanup path');
    rmSync(folder, { recursive: true, force: true });
  }
});
function source(folder: string) {
  const built = buildTestBundle({ key: generateTestKey() });
  const skill = join(folder, 'skill');
  mkdirSync(skill);
  for (const file of built.bundle.files) {
    mkdirSync(dirname(join(skill, file.path)), { recursive: true });
    writeFileSync(join(skill, file.path), Buffer.from(file.content_base64, 'base64'));
  }
  writeFileSync(join(skill, 'manifest.json'), JSON.stringify(built.bundle.manifest));
  return { skill, manifest: built.bundle.manifest };
}
describe('publisher tool on the publisher machine', () => {
  it('generates a local key, packs files and independently verifies the resulting bundle', () => {
    const folder = temp(),
      keys = join(folder, 'keys'),
      { skill } = source(folder);
    const generated = run('keygen', keys);
    expect(generated.status, generated.stderr).toBe(0);
    const privatePem = readFileSync(join(keys, 'private-key.pem'), 'utf8');
    const publicKey = JSON.parse(readFileSync(join(keys, 'public-key.json'), 'utf8')) as {
      public_key_base64: string;
      key_id: string;
    };
    expect(generated.stdout).toContain(publicKey.key_id);
    expect(generated.stdout + generated.stderr).not.toContain(privatePem);
    const out = join(folder, 'bundle.json');
    const packed = run('pack', skill, '--key', join(keys, 'private-key.pem'), '--out', out);
    expect(packed.status, packed.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    const verified = run('verify', out, '--public-key', publicKey.public_key_base64);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain('VERIFIED');
    expect(
      run('verify', out, '--public-key', generateTestKey().publicKey.toString('base64')).status,
    ).toBe(2);
    expect(run('keygen', keys).status).toBe(2);
    expect(readFileSync(join(keys, 'private-key.pem'), 'utf8')).toBe(privatePem);
    expect(run('pack', skill, '--key', join(keys, 'private-key.pem'), '--out', out).status).toBe(2);
  }, 60_000);
  it('refuses a parent path and directory symlink before copying any external file into a bundle', () => {
    const folder = temp(),
      { skill, manifest } = source(folder),
      keys = join(folder, 'keys');
    expect(run('keygen', keys).status).toBe(0);
    const outside = join(folder, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'GENERATED-DO-NOT-PACK');
    const out = join(folder, 'bundle.json');
    for (const path of ['../outside/secret.txt', 'link/secret.txt']) {
      if (path.startsWith('link'))
        symlinkSync(
          outside,
          join(skill, 'link'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      writeFileSync(
        join(skill, 'manifest.json'),
        JSON.stringify({
          ...manifest,
          files: [...manifest.files, { path, sha256: 'a'.repeat(64), size_bytes: 21 }],
        }),
      );
      const result = run('pack', skill, '--key', join(keys, 'private-key.pem'), '--out', out);
      expect(result.status).toBe(2);
      expect(existsSync(out)).toBe(false);
      expect(result.stdout + result.stderr).not.toContain('GENERATED-DO-NOT-PACK');
    }
  }, 60_000);
});
