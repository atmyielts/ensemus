export type SinkMode =
  | 'accept'
  | 'accept_then_silent'
  | 'refuse_recipient'
  | 'refuse_after_data'
  | 'busy'
  | 'silent_on_connect'
  | 'drop_after_data';

export type SinkMessage = {
  /** The envelope, as the relay was told it. */
  mailFrom: string;
  rcptTo: string[];
  /** The message as sent, with dot-stuffing removed. */
  raw: string;
  /** The name it logged in as, or null. The password is never kept. */
  authenticatedAs: string | null;
  tls: boolean;
};

export type SmtpSink = {
  port: number;
  messages(): SinkMessage[];
  /** Connections since it started, to show there was not a second one. */
  connections(): number;
  /** Tries at logging in, to show a credential did not go. */
  authAttempts(): number;
  setMode(mode: SinkMode): void;
  close(): Promise<void>;
};

export function createSmtpSink(options: {
  mode: SinkMode;
  host?: string;
  port?: number;
  /** A certificate turns STARTTLS on. Without one it is not offered. */
  tls?: { key: string; cert: string };
  /** Offer no way to log in. */
  noAuth?: boolean;
}): Promise<SmtpSink>;
