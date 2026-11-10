// A parser has no credential or network. Each file gets its own heap and deadline, so a bad document
// cannot pin the knowledge worker's event loop or retain another document's memory.
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import type { ParseRunner } from '@ensemus/application/knowledge/ingest';
import { parseDocument, type ParsedDocument } from '@ensemus/knowledge/parsing';

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
          resourceLimits: {
            maxOldGenerationSizeMb: options.memoryMb ?? 256,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
        },
      );
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
      const timer = setTimeout(
        () => finish(undefined, 'PARSE_TIMEOUT'),
        options.deadlineMs ?? 15_000,
      );
      worker.once('message', (message: { parsed?: ParsedDocument }) => finish(message.parsed));
      worker.once('error', () => finish());
      worker.once('exit', () => finish());
    });
}

if (!isMainThread && (workerData as { knowledgeParse?: unknown })?.knowledgeParse === true) {
  const input = workerData as { bytes: Uint8Array; mediaType: string };
  try {
    parentPort?.postMessage({ parsed: parseDocument(input.bytes, input.mediaType) });
  } catch {
    parentPort?.postMessage({ error: 'PARSE_FAILED' });
  }
}
