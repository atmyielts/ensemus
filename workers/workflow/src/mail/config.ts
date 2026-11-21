// The mail worker's settings. Each is named in compose.yaml, and a missing or malformed one stops the
// worker at start with the setting's name and never its value, rather than failing each message later.
import { readFileSync } from 'node:fs';
import { ConfigError, readSecret } from '@ensemus/config';

/** A DNS name with a letter in its last label, so an IP address cannot pass as a certificate name. */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z][A-Za-z0-9-]{0,62}$/;
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/;
const GATEWAY = /^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})):(\d{1,5})$/;

export type MailConfig = {
  gateway: { host: string; port: number };
  tls: { mode: 'none' } | { mode: 'required'; servername: string; ca?: string };
  fromAddress: string;
  fromName: string;
  username: string;
  /** Read once, from the mounted file. Lent to the SMTP client for the login alone. */
  password: Buffer;
  messageIdDomain: string;
  publicUrl: string;
};

const required = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required setting ${name}`);
  return value;
};

export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const gateway = GATEWAY.exec(required(env, 'ENSEMUS_MAIL_GATEWAY'));
  const port = Number(gateway?.[2]);
  if (!gateway?.[1] || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new ConfigError('Invalid setting ENSEMUS_MAIL_GATEWAY');

  let publicUrl: URL;
  try {
    publicUrl = new URL(required(env, 'ENSEMUS_PUBLIC_URL'));
  } catch {
    throw new ConfigError('Invalid setting ENSEMUS_PUBLIC_URL');
  }
  if (!['https:', 'http:'].includes(publicUrl.protocol) || publicUrl.pathname !== '/')
    throw new ConfigError('Invalid setting ENSEMUS_PUBLIC_URL');

  const fromAddress = required(env, 'ENSEMUS_MAIL_FROM_ADDRESS');
  if (!ADDRESS.test(fromAddress))
    throw new ConfigError('Invalid setting ENSEMUS_MAIL_FROM_ADDRESS');
  const fromName = env.ENSEMUS_MAIL_FROM_NAME?.trim() || 'Ensemus';
  if (/[\r\n\0\v\f]/.test(fromName) || fromName.length > 80)
    throw new ConfigError('Invalid setting ENSEMUS_MAIL_FROM_NAME');
  const username = env.ENSEMUS_MAIL_USERNAME?.trim() || fromAddress;
  if (/[\r\n\0\v\f]/.test(username) || username.length > 254)
    throw new ConfigError('Invalid setting ENSEMUS_MAIL_USERNAME');

  const messageIdDomain = env.ENSEMUS_MAIL_MESSAGE_ID_DOMAIN?.trim() || publicUrl.hostname;
  if (!HOSTNAME.test(messageIdDomain))
    throw new ConfigError('Invalid setting ENSEMUS_MAIL_MESSAGE_ID_DOMAIN');

  // `none` is for a relay on a trusted site network, and the test overlay's local mailbox, only.
  const tlsMode = env.ENSEMUS_MAIL_TLS?.trim() || 'required';
  if (tlsMode !== 'required' && tlsMode !== 'none')
    throw new ConfigError('Invalid setting ENSEMUS_MAIL_TLS');
  let tls: MailConfig['tls'] = { mode: 'none' };
  if (tlsMode === 'required') {
    const servername = required(env, 'ENSEMUS_MAIL_TLS_SERVER_NAME');
    if (!HOSTNAME.test(servername))
      throw new ConfigError('Invalid setting ENSEMUS_MAIL_TLS_SERVER_NAME');
    const caFile = env.ENSEMUS_MAIL_CA_FILE?.trim();
    tls = {
      mode: 'required',
      servername,
      ...(caFile ? { ca: readFileSync(caFile, 'utf8') } : {}),
    };
  }

  return {
    gateway: { host: gateway[1], port },
    tls,
    fromAddress,
    fromName,
    username,
    password: Buffer.from(readSecret('ENSEMUS_MAIL_PASSWORD', env), 'utf8'),
    messageIdDomain,
    publicUrl: publicUrl.origin,
  };
}
