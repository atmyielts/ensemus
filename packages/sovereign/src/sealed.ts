// Encrypting something so only the holder of one private key can open it (ADR-030 D6). Used for export
// parts, backups and diagnostic bundles. X25519 to agree a key, HKDF-SHA256 to derive it and AES-256-GCM to
// seal, all from Node's crypto, in the same shape as HPKE's base mode. The code that seals holds only a
// public key, so a worker that wrote an archive cannot read it back. NEEDS OUTSIDE REVIEW (ADR-030).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

const MAGIC = Buffer.from('ensemus.sealed/v1\n');
const INFO = Buffer.from('ensemus.sealed/v1');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 4096;

export class SealedRefused extends Error {
  override name = 'SealedRefused';
  constructor(readonly code: 'NOT_SEALED' | 'WRONG_KEY_OR_DAMAGED') {
    super('The sealed object could not be opened');
  }
}

/** A short name for a public key, safe to store and show. A hash, so it reveals nothing about the key. */
export function recipientKeyId(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 32);
}

/** Reads a recipient's public key from what they gave us: SPKI DER, base64. Throws on anything else. */
export function parseRecipientPublicKey(base64: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(base64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (key.asymmetricKeyType !== 'x25519') throw new Error('Not an X25519 public key');
  return key;
}

export const exportRecipientPublicKey = (key: KeyObject) =>
  key.export({ type: 'spki', format: 'der' }).toString('base64');

export const parseRecipientPrivateKey = (pem: string) => {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'x25519') throw new Error('Not an X25519 private key');
  return key;
};

/** For the customer's own tool. Whoever runs this keeps the private key, and Ensemus never sees it. */
export function generateRecipientKeyPair() {
  return generateKeyPairSync('x25519');
}

function deriveKey(shared: Buffer, ephemeralDer: Buffer, recipientDer: Buffer) {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephemeralDer, recipientDer]), INFO, 32),
  );
}

const derOf = (key: KeyObject) => key.export({ type: 'spki', format: 'der' });

/**
 * Seals one object in memory. A new key is agreed for every call, so a nonce can never repeat under the
 * same key however many parts an archive has. `MAX_PART_PLAINTEXT_BYTES` bounds what callers hold.
 */
export function seal(plaintext: Buffer, recipient: KeyObject): Buffer {
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralDer = derOf(ephemeral.publicKey);
  const recipientDer = derOf(recipient);
  const key = deriveKey(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }),
    ephemeralDer,
    recipientDer,
  );
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.from(
    JSON.stringify({
      recipient_key_id: recipientKeyId(recipient),
      ephemeral_public_key: ephemeralDer.toString('base64'),
      nonce: nonce.toString('base64'),
    }),
  );
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  // The header is authenticated, so changing which key or nonce it names breaks the seal.
  cipher.setAAD(Buffer.concat([MAGIC, header]));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const length = Buffer.alloc(HEADER_LENGTH_BYTES);
  length.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, length, header, body, cipher.getAuthTag()]);
}

/** Opens one object, or throws one fixed error. Nothing is returned unless all of it authenticated. */
export function open(sealed: Buffer, recipientPrivateKey: KeyObject): Buffer {
  const start = MAGIC.length + HEADER_LENGTH_BYTES;
  if (sealed.length < start + TAG_BYTES || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new SealedRefused('NOT_SEALED');
  }
  const headerLength = sealed.readUInt32BE(MAGIC.length);
  if (headerLength > MAX_HEADER_BYTES || sealed.length < start + headerLength + TAG_BYTES) {
    throw new SealedRefused('NOT_SEALED');
  }
  const header = sealed.subarray(start, start + headerLength);
  try {
    const fields = JSON.parse(header.toString('utf8')) as {
      ephemeral_public_key: string;
      nonce: string;
    };
    const ephemeralDer = Buffer.from(fields.ephemeral_public_key, 'base64');
    const ephemeral = createPublicKey({ key: ephemeralDer, format: 'der', type: 'spki' });
    const recipientDer = derOf(createPublicKey(recipientPrivateKey));
    const key = deriveKey(
      diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephemeral }),
      ephemeralDer,
      recipientDer,
    );
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(fields.nonce, 'base64'));
    decipher.setAAD(Buffer.concat([MAGIC, header]));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(start + headerLength, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new SealedRefused('WRONG_KEY_OR_DAMAGED');
  }
}

/** The recipient a sealed object says it is for, so a tool can tell someone they hold the wrong key. */
export function sealedRecipientId(sealed: Buffer): string | null {
  const start = MAGIC.length + HEADER_LENGTH_BYTES;
  if (sealed.length < start || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const headerLength = sealed.readUInt32BE(MAGIC.length);
  if (headerLength > MAX_HEADER_BYTES || sealed.length < start + headerLength) return null;
  try {
    const id = (
      JSON.parse(sealed.subarray(start, start + headerLength).toString('utf8')) as {
        recipient_key_id?: unknown;
      }
    ).recipient_key_id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}
