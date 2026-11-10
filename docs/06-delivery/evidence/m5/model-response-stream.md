# Model response stream interoperability

The new browser conformance fixture imports the actual synthetic Knowledge qualification gateway. This exposed a type incompatibility between Undici's Node readable stream and the global DOM `TransformStream`/`Response` when both environments' types are present.

`cappedModelResponse` now reads the upstream reader into the runtime's own `ReadableStream<Uint8Array>` without casts. It preserves status, status text, headers and null-body handling; it normalizes byte views without copying, reads only in response to downstream demand (zero high-water mark), forwards downstream cancellation, propagates upstream read/abort errors and cancels at the existing 32 MiB technical cap. There is no new provider retry, default, price, egress capability or credential change.

Actual source verification: the combined focused maxWorkers=1 batch passed **179 tests / 4 files**, including all guard tests and new no-read-ahead/cancel, streaming overflow/cancel, read-error/reader-release and real-socket after-headers abort cases. Scoped format/lint (zero warnings), `git diff --check`, intelligence types, integration-test types and browser-test types passed. The initial browser type failure is resolved without weakening the fixture or suppressing diagnostics.

These are local synthetic-stream/loopback-socket checks. No external model, database, browser run, Docker build or production provider was used.
