#!/usr/bin/env -S node --experimental-strip-types
// Publisher-machine tool (EXP-04). Never imported by a server or worker; never reads a key implicitly.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { skillManifestSchema, skillPathSchema, type SkillBundle } from '@ensemus/contracts/skills';
import { SKILL_BUNDLE_MAX_BYTES, SKILL_BUNDLE_MAX_FILES } from '@ensemus/domain/skill';
import { manifestDigest, parseSkillBundle } from '@ensemus/skills/bundle';
import { isValidPublicKey, keyIdOf, verifySkillSignature } from '@ensemus/skills/signature';
import { signSkillDigest } from '@ensemus/skills/sign';

class Refusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
function refuse(code: string): never {
  throw new Refusal(code);
}
const decoder = new TextDecoder('utf-8', { fatal: true });
function readBounded(path: string, maximum: number): Buffer {
  if (!lstatSync(path).isFile()) refuse('FILE_NOT_REGULAR');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) refuse('BUNDLE_TOO_LARGE');
    const bytes = Buffer.alloc(maximum + 1);
    let total = 0;
    while (total <= maximum) {
      const count = readSync(fd, bytes, total, bytes.length - total, null);
      if (!count) return bytes.subarray(0, total);
      total += count;
      if (total > maximum) refuse('BUNDLE_TOO_LARGE');
    }
    return refuse('BUNDLE_TOO_LARGE');
  } finally {
    closeSync(fd);
  }
}
function packageFile(root: string, name: string): string {
  if (!skillPathSchema.safeParse(name).success) refuse('PATH_UNSAFE');
  let path = root;
  for (const part of name.split('/')) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) refuse('PATH_UNSAFE');
  }
  const resolved = realpathSync(path),
    rel = relative(root, resolved);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) refuse('PATH_UNSAFE');
  return resolved;
}
function keygen(directory: string) {
  const root = resolve(directory),
    privatePath = join(root, 'private-key.pem'),
    publicPath = join(root, 'public-key.json');
  if (existsSync(privatePath) || existsSync(publicPath)) refuse('OUTPUT_EXISTS');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = generateKeyPairSync('ed25519');
  const raw = key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  writeFileSync(privatePath, key.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    flag: 'wx',
    mode: 0o600,
  });
  const key_id = keyIdOf(raw);
  writeFileSync(
    publicPath,
    JSON.stringify({ key_id, public_key_base64: raw.toString('base64') }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return { code: 'KEY_GENERATED', key_id };
}
function pack(directory: string, keyPath: string, output: string) {
  if (existsSync(output)) refuse('OUTPUT_EXISTS');
  const root = realpathSync(resolve(directory));
  const value: unknown = JSON.parse(
    decoder.decode(readBounded(packageFile(root, 'manifest.json'), SKILL_BUNDLE_MAX_BYTES)),
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('MANIFEST_INVALID');
  const manifest = skillManifestSchema.safeParse(value);
  if (!manifest.success || manifest.data.files.length > SKILL_BUNDLE_MAX_FILES)
    refuse('MANIFEST_INVALID');
  const files: SkillBundle['files'] = [];
  let total = 0;
  for (const declared of manifest.data.files) {
    const bytes = readBounded(packageFile(root, declared.path), SKILL_BUNDLE_MAX_BYTES - total);
    total += bytes.length;
    declared.size_bytes = bytes.length;
    declared.sha256 = createHash('sha256').update(bytes).digest('hex');
    files.push({ path: declared.path, content_base64: bytes.toString('base64') });
  }
  const privateKeyPem = decoder.decode(readBounded(resolve(keyPath), 16_384));
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') refuse('SKILL_SIGNER_KEY_INVALID');
  const publicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);
  const digest = manifestDigest(manifest.data);
  const bundle: SkillBundle = {
    format: 'ensemus.skill.bundle.v1',
    manifest: manifest.data,
    files,
    signature: {
      algorithm: 'ed25519',
      key_id: keyIdOf(publicKey),
      value_base64: signSkillDigest({ digest, privateKeyPem }).toString('base64'),
    },
  };
  const bytes = Buffer.from(JSON.stringify(bundle));
  const checked = parseSkillBundle(bytes);
  if (!checked.ok) refuse(checked.code);
  writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
  return { code: 'PACKED', digest, name: manifest.data.name, version: manifest.data.version };
}
function verify(file: string, publicKeyBase64: string) {
  const key = Buffer.from(publicKeyBase64, 'base64');
  if (!isValidPublicKey(key) || key.toString('base64') !== publicKeyBase64)
    refuse('SKILL_SIGNER_KEY_INVALID');
  const checked = parseSkillBundle(readBounded(resolve(file), SKILL_BUNDLE_MAX_BYTES));
  if (!checked.ok) refuse(checked.code);
  const { parsed } = checked;
  if (
    parsed.bundle.signature.key_id !== keyIdOf(key) ||
    !verifySkillSignature({
      digest: parsed.digest,
      publicKey: key,
      signature: Buffer.from(parsed.bundle.signature.value_base64, 'base64'),
    })
  )
    refuse('SIGNATURE_INVALID');
  return {
    code: 'VERIFIED',
    digest: parsed.digest,
    name: parsed.manifest.name,
    version: parsed.manifest.version,
  };
}
try {
  const args = process.argv.slice(2);
  let result: Record<string, string>;
  if (args[0] === 'keygen' && args.length === 2) result = keygen(args[1]!);
  else if (args[0] === 'pack' && args.length === 6 && args[2] === '--key' && args[4] === '--out')
    result = pack(args[1]!, args[3]!, args[5]!);
  else if (args[0] === 'verify' && args.length === 4 && args[2] === '--public-key')
    result = verify(args[1]!, args[3]!);
  else refuse('INVALID_ARGUMENTS');
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  // Native errors may contain paths or key material. Emit fixed refusal codes only.
  process.stderr.write(
    JSON.stringify({ code: error instanceof Refusal ? error.code : 'SKILL_TOOL_REFUSED' }) + '\n',
  );
  process.exitCode = 2;
}
