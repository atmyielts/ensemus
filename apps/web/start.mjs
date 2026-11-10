// Container entrypoint. The build embeds a Server Action key in the image, shared by everyone who
// has that image. A per-deployment key overrides it at runtime, so starting without one is refused
// instead of silently falling back to the shared key (ADR-025 D7).
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { installNoScriptNotFound } from './no-script-not-found.mjs';

const file = process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY_FILE;
const key = file
  ? readFileSync(file, 'utf8').trim()
  : process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY;
if (!key) {
  console.error('Refusing to start: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY_FILE is not set.');
  process.exit(1);
}
process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY = key;

// A page's notFound() is a blank 404 document without JavaScript in Next.js 16.4.5. Before the
// standalone server makes its HTTP server, have that one document carry the not-found page too.
installNoScriptNotFound(http);
await import('./server.js');
