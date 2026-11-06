// FOUND-07, ADR-037 D4: how a release manifest gets signed. A real signer is a command, so the private
// key never enters this process, whatever holds it. With no signer named, a throwaway key signs, and the
// manifest says so where verify-release.mjs will refuse it as a release.
//
// M6's build-bundle.mjs follows this file on the throwaway key, and verify-release.mjs repeats the marker
// because it ships alone. Keep the marker text exactly as it is.
import { spawnSync } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

export const THROWAWAY_MARKER = 'THROWAWAY-TEST-KEY-NOT-FOR-DISTRIBUTION';
/** What a manifest signed through a command says. It names no custody, because that is undecided. */
export const COMMAND_SIGNER_MARKER = 'ENSEMUS-RELEASE-KEY';

// Long enough for someone to touch a hardware key, and short enough that CI does not sit on a hang.
const SIGNER_TIMEOUT_MS = 120_000;
const ED25519_SIGNATURE_BYTES = 64;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The SHA-256, in hex, of the key's SPKI DER bytes, so how the PEM is written cannot change it. */
export function keyIdOf(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/** A new key for one run. It is discarded when the script ends, so it can never sign anything else. */
export function createThrowawaySigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return Object.freeze({
    marker: THROWAWAY_MARKER,
    publicKeyPem,
    keyId: keyIdOf(publicKeyPem),
    sign: (bytes) => signBytes(null, bytes, privateKey).toString('base64'),
  });
}

/**
 * Reads a public key an operator named, and returns it re-encoded. Whatever is returned goes in the
 * release folder, and createPublicKey would happily accept a private key, so one named by mistake has
 * to stop here. None of these messages repeat the text they were given, because it may be that key.
 */
function publicKeyPemFrom(text) {
  if (/PRIVATE KEY/.test(text)) {
    throw new Error('The release public key is a private key. Name the public key instead.');
  }
  let key;
  try {
    key = createPublicKey(text);
  } catch {
    throw new Error('The release public key could not be read as a public key in PEM form.');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('The release public key must be an Ed25519 key, which is what verifiers check.');
  }
  return key.export({ type: 'spki', format: 'pem' });
}

/**
 * Runs `command` with the bytes to sign on standard input, and takes a base64 Ed25519 signature from
 * standard output. It takes no arguments and no shell, so it has to be an executable a system can start
 * directly: on Windows an .exe, because Node will not start a .cmd without a shell.
 *
 * What the command prints is never repeated, and its stderr is not inherited, because a signer that
 * fails may well print what it was unlocking with. So a failure here says little, on purpose.
 */
export function createCommandSigner({ command, publicKeyPem, timeoutMs = SIGNER_TIMEOUT_MS }) {
  const pem = publicKeyPemFrom(publicKeyPem);
  return Object.freeze({
    marker: COMMAND_SIGNER_MARKER,
    publicKeyPem: pem,
    keyId: keyIdOf(pem),
    sign(bytes) {
      const result = spawnSync(command, [], {
        input: bytes,
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.error) throw new Error(`The release signer did not run: ${result.error.code}.`);
      if (result.status !== 0) {
        throw new Error(`The release signer exited with status ${result.status ?? result.signal}.`);
      }
      const text = result.stdout.toString('utf8').trim();
      const signature = BASE64.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0);
      if (signature.length !== ED25519_SIGNATURE_BYTES) {
        throw new Error('The release signer did not return a base64 Ed25519 signature.');
      }
      return signature.toString('base64');
    },
  });
}

/**
 * A command signer when both settings are present, and null when neither is, which is the caller's cue
 * for a marked throwaway. One alone is a mistake. Falling back to a throwaway there would turn a typing
 * slip in a real release into a test release that fails only at the end, if anyone is checking.
 */
export function signerFromEnv(env) {
  const command = env.ENSEMUS_RELEASE_SIGNER_COMMAND;
  const keyFile = env.ENSEMUS_RELEASE_PUBLIC_KEY_FILE;
  if (!command && !keyFile) return null;
  if (!keyFile) {
    throw new Error(
      'ENSEMUS_RELEASE_SIGNER_COMMAND needs ENSEMUS_RELEASE_PUBLIC_KEY_FILE as well. Set both or neither.',
    );
  }
  if (!command) {
    throw new Error(
      'ENSEMUS_RELEASE_PUBLIC_KEY_FILE needs ENSEMUS_RELEASE_SIGNER_COMMAND as well. Set both or neither.',
    );
  }
  let publicKeyPem;
  try {
    publicKeyPem = readFileSync(keyFile, 'utf8');
  } catch {
    throw new Error('The file named by ENSEMUS_RELEASE_PUBLIC_KEY_FILE could not be read.');
  }
  return createCommandSigner({ command, publicKeyPem });
}

/**
 * Adds how the manifest is signed, serializes it and signs those bytes. It proves the signature against
 * the public key before returning, so a signer holding the wrong key fails here, before anything of the
 * release is written, and not on an operator's machine.
 */
export function signManifest(manifest, signer) {
  if (keyIdOf(signer.publicKeyPem) !== signer.keyId) {
    throw new Error('The signer key ID is not the ID of its public key.');
  }
  const signed = { ...manifest, signing: signer.marker, signing_key_id: signer.keyId };
  const bytes = Buffer.from(`${JSON.stringify(signed, null, 2)}\n`);
  const signature = signer.sign(bytes);
  const verified = verifyBytes(
    null,
    bytes,
    createPublicKey(signer.publicKeyPem),
    Buffer.from(signature, 'base64'),
  );
  if (!verified) {
    throw new Error('The manifest signature does not verify against the release public key.');
  }
  return { bytes, signature };
}

/** Only a throwaway may ask for the test OK. A real release is checked with no flag at all. */
export function verifierFlags(signer) {
  return signer.marker === THROWAWAY_MARKER ? ['--allow-test-key'] : [];
}
