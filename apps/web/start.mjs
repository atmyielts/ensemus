// Container entrypoint. Reads the per-deployment Server Action key from a mounted secret, so the
// image itself holds no shared key (ADR-024 spike, PLAT-11), then starts the standalone server.
import { readFileSync } from 'node:fs';

const file = process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY_FILE;
if (file) process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY = readFileSync(file, 'utf8').trim();

await import('./server.js');
