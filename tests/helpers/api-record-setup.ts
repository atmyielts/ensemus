// API-12 (stack project setup file): every real public-API response a stack suite receives is checked against
// docs/specifications/openapi.yaml through contractProblems, which records the operation in the shared run record
// (ENSEMUS_API_RECORD_DIR) when the response is under 400 and matches the spec, with the test file that asked and
// whether a test was running when it asked. A call made in beforeAll or afterAll proves the operation answered as
// documented, and is recorded as setup: API-12's final check in tests/stack/api.test.ts wants each operation seen
// by at least one running test as well. Nothing here asserts or changes a response: a suite's own expectations
// are untouched, and a response that does not match the spec is simply not recorded.
import { afterAll } from 'vitest';
import { BASE } from './forms';
import { contractProblems, currentCaller } from './openapi';

const API_ROOT = new URL('/api/v1/', BASE);
const pending = new Set<Promise<void>>();
const passThrough = globalThis.fetch;

function requestOf(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input), BASE);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  return { url, method };
}

globalThis.fetch = async function recordingFetch(input, init) {
  // Who asked is read before anything is awaited: by the time a body is read, the test may have ended.
  const caller = currentCaller();
  const response = await passThrough(input, init);
  const { url, method } = requestOf(input, init);
  if (
    url.origin !== API_ROOT.origin ||
    !url.pathname.startsWith(API_ROOT.pathname) ||
    response.status >= 400
  )
    return response;
  const type = response.headers.get('content-type')?.split(';')[0]?.trim();
  // Cloned before the caller can read the body. Only a JSON body is read: a stream or a file is checked by its
  // type alone, as contractProblems documents, so nothing waits on an event stream or buffers a download.
  const copy = type === 'application/json' ? response.clone() : undefined;
  const task = (async () => {
    const text = copy ? await copy.text() : undefined;
    contractProblems(
      {
        method,
        path: `${url.pathname}${url.search}`,
        status: response.status,
        headers: response.headers,
        ...(text === undefined ? {} : { text }),
      },
      caller,
    );
  })()
    .catch(() => undefined)
    .finally(() => pending.delete(task));
  pending.add(task);
  return response;
};

// The record is appended before this file's worker can end.
afterAll(async () => {
  await Promise.all([...pending]);
});
