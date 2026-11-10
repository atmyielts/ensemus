// Healthy while the worker has updated its heartbeat file recently.
import { statSync } from 'node:fs';

const FRESH_MS = 30_000;
try {
  process.exit(Date.now() - statSync('/tmp/worker-alive').mtimeMs < FRESH_MS ? 0 : 1);
} catch {
  process.exit(1);
}
