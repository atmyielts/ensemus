// Container entrypoint. The build embeds a Server Action key in the image, shared by everyone who
// has that image. A per-deployment key overrides it at runtime, so starting without one is refused
// instead of silently falling back to the shared key (ADR-025 D7).
import { readFileSync } from 'node:fs';

const file = process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY_FILE;
const key = file
  ? readFileSync(file, 'utf8').trim()
  : process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
if (!key) {
  console.error('Refusing to start: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY_FILE is not set.');
  process.exit(1);
}
process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY = key;

await import('./server.js');
