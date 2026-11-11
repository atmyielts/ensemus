// A parser has no credential or network. Each file gets its own heap and deadline, so a bad document
// cannot pin the knowledge worker's event loop or retain another document's memory (ADR-029 D4 and its
// addendum). Inside the thread, the ways out a parser library could reach for are closed before it loads:
// fetch, WebSocket and the console, so neither a request nor a document's words can leave by them.
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import type { ParseRunner } from '@ensemus/application/knowledge/ingest';
import { TEXT_MEDIA_TYPES } from '@ensemus/domain/knowledge';
import type { ParsedDocument } from '@ensemus/knowledge/parsing';

/** Text is quick to read. A PDF or Office file of the same size can take far longer, legitimately. */
const TEXT_DEADLINE_MS = 15_000;
const CONTAINER_DEADLINE_MS = 60_000;

export function createParseRunner(
  options: { deadlineMs?: number; memoryMb?: number } = {},
): ParseRunner {
  return (bytes, mediaType) =>
    new Promise<ParsedDocument>((resolve, reject) => {
      const copy = Uint8Array.from(bytes);
      const worker = new Worker(
        new URL(
          import.meta.url.endsWith('.ts') ? './parse-thread.ts' : './parse-thread.js',
          import.meta.url,
        ),
        {
          workerData: { knowledgeParse: true, bytes: copy, mediaType },
          transferList: [copy.buffer],
          // The thread's own output is dropped: a library's warning can quote a document.
          stdout: true,
          stderr: true,
          resourceLimits: {
            maxOldGenerationSizeMb: options.memoryMb ?? 320,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
        },
      );
      worker.stdout.resume();
      worker.stderr.resume();
      let done = false;
      const finish = (result?: ParsedDocument, code?: 'PARSE_FAILED' | 'PARSE_TIMEOUT') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void worker.terminate();
        if (result) resolve(result);
        else
          reject(
            Object.assign(new Error(code ?? 'PARSE_FAILED'), { code: code ?? 'PARSE_FAILED' }),
          );
      };
      const deadline =
        options.deadlineMs ??
        ((TEXT_MEDIA_TYPES as readonly string[]).includes(mediaType)
          ? TEXT_DEADLINE_MS
          : CONTAINER_DEADLINE_MS);
      const timer = setTimeout(() => finish(undefined, 'PARSE_TIMEOUT'), deadline);
      worker.once('message', (message: { parsed?: ParsedDocument }) => finish(message.parsed));
      worker.once('error', () => finish());
      worker.once('exit', () => finish());
    });
}

/** Closes what a parser could use to reach out or to print. Runs before any parser is loaded. */
export function closeThreadExits(scope: typeof globalThis = globalThis) {
  // A function, not an arrow, so `new WebSocket(...)` meets this refusal rather than a TypeError.
  const refuse = function refuse(): never {
    throw new Error('NETWORK_REFUSED');
  };
  Object.defineProperty(scope, 'fetch', {
    value: () => Promise.reject(new Error('NETWORK_REFUSED')),
    configurable: false,
    writable: false,
  });
  for (const name of ['WebSocket', 'EventSource', 'XMLHttpRequest'] as const) {
    Object.defineProperty(scope, name, { value: refuse, configurable: false, writable: false });
  }
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    scope.console[method] = () => {};
  }
}

if (!isMainThread && (workerData as { knowledgeParse?: unknown })?.knowledgeParse === true) {
  const input = workerData as { bytes: Uint8Array; mediaType: string };
  closeThreadExits();
  // Loaded only after the exits are closed, so nothing a parser does at import time can use them.
  import('@ensemus/knowledge/parsing')
    .then(({ parseDocument }) => parseDocument(input.bytes, input.mediaType))
    .then(
      (parsed) => parentPort?.postMessage({ parsed }),
      () => parentPort?.postMessage({ error: 'PARSE_FAILED' }),
    );
}
