// A test SMTP relay, in this process or in the stack. See fixtures/smtp-sink.mjs for what each mode does.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import {
  createSmtpSink,
  type SinkMessage,
  type SinkMode,
  type SmtpSink,
} from './fixtures/smtp-sink.mjs';

export type { SinkMessage, SinkMode } from './fixtures/smtp-sink.mjs';
export type StartedSink = SmtpSink;

/** A relay inside this test process, listening on a free local port. */
export function startSmtpSink(options: {
  mode: SinkMode;
  tls?: { key: string; cert: string };
  noAuth?: boolean;
}): Promise<StartedSink> {
  return createSmtpSink(options);
}

/**
 * The `smtp-sink` service in compose.test.yaml, through its control port. Its SMTP port is on the
 * `outbound` network only, where the gateway reaches it.
 */
export function stackSmtpSink(
  controlUrl = `http://127.0.0.1:${process.env.ENSEMUS_TEST_SMTP_CONTROL_PORT ?? '58025'}`,
) {
  return {
    messages: async (): Promise<SinkMessage[]> =>
      (await (await fetch(`${controlUrl}/messages`)).json()) as SinkMessage[],
    /** `received` and `connections` only ever go up, for the life of the container. */
    stats: async (): Promise<{ received: number; connections: number }> =>
      (await (await fetch(`${controlUrl}/stats`)).json()) as {
        received: number;
        connections: number;
      },
    setMode: async (mode: SinkMode): Promise<void> => {
      const response = await fetch(`${controlUrl}/mode`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      if (!response.ok) throw new Error(`Sink refused mode ${mode}`);
    },
  };
}

// A little DER, so that a real TLS test needs no openssl binary, no new dependency and no key in the
// repository: each certificate here lives for one test run.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : body.length < 0x100
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
const utcTime = (date: Date) =>
  der(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
const commonName = (name: string) =>
  sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from(name)))));
const ECDSA_WITH_SHA256 = sequence(oid('2a8648ce3d040302'));

const pem = (label: string, data: Buffer) =>
  `-----BEGIN ${label}-----\n${data.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n`;

/** A self-signed certificate for one DNS name, usable as its own trust anchor in a test. */
export function generateTestCertificate(name: string): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Date.now();
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.concat([Buffer.from([1]), randomBytes(15)])),
    ECDSA_WITH_SHA256,
    commonName(name),
    sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    commonName(name),
    publicKey.export({ type: 'spki', format: 'der' }),
    der(
      0xa3,
      sequence(
        // Subject alternative name, which is where a modern client looks for the name.
        sequence(oid('551d11'), der(0x04, sequence(der(0x82, Buffer.from(name))))),
        // Marks it a CA, because a test hands it to the client as the issuer it trusts.
        sequence(
          oid('551d13'),
          der(0x01, Buffer.from([0xff])),
          der(0x04, sequence(der(0x01, Buffer.from([0xff])))),
        ),
      ),
    ),
  );
  const signature = sign(
    'sha256',
    tbs,
    createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })),
  );
  const certificate = sequence(
    tbs,
    ECDSA_WITH_SHA256,
    der(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem('CERTIFICATE', certificate),
  };
}
