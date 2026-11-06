export type SecretState = {
  status: 'idle' | 'ready' | 'error';
  error?: string;
  totpURI?: string;
  secret?: string;
  backupCodes?: readonly string[];
};
