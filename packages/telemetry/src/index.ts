// Default telemetry carries identifiers, counts and codes, never content (ADR-013). Fields are an
// allowlist: anything unknown is dropped, so a new field cannot leak by being forgotten here.

const SAFE_FIELDS = new Set([
  'service',
  'release',
  'requestId',
  'correlationId',
  'causationId',
  'organizationId',
  'userId',
  'membershipId',
  'workUnitId',
  'runId',
  'stepId',
  'probeId',
  // M7 (ADR-031). IDs and codes only, like the rest.
  'simulationId',
  'processRunId',
  'migrationId',
  'installationId',
  'packKey',
  'workflowId',
  'taskQueue',
  'status',
  'step',
  'attempt',
  'durationMs',
  'errorCode',
  'reasonCode',
  'count',
  // Counts from the tombstone ledger (ADR-026).
  'queued',
  'dead',
  'oldestSeconds',
  'entries',
  'tombstonesAdded',
  'artifactsRemoved',
  'bytesRemoved',
  'organizationsMissing',
  'invalid',
  'unconfirmed',
  'failed',
  // IDs and a type, which an operator needs in order to decide about one entry (ADR-026).
  'ledgerEntry',
  // Governed AI (ADR-028). Identifiers, counters and codes. Never a prompt, an answer or a URL.
  'agentRunId',
  'modelProfileId',
  'decisionCode',
  'stopCode',
  'inputTokens',
  'outputTokens',
  'costMicros',
  // IDs and counts from company knowledge (ADR-029). Never a title, a query or a passage.
  'sourceId',
  'documentId',
  'answerId',
  'factId',
  'spaceId',
  'purgeJobId',
  'chunks',
  'embeddings',
  'closed',
]);

// Safe values are short and machine-shaped. Free text is refused even under a safe field name.
const SAFE_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;

export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;

function sanitize(fields: Fields): { kept: Fields; dropped: number } {
  const kept: Fields = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    const safe =
      SAFE_FIELDS.has(key) &&
      (typeof value === 'number' ||
        typeof value === 'boolean' ||
        (typeof value === 'string' && SAFE_VALUE.test(value)));
    if (safe) kept[key] = value;
    else dropped += 1;
  }
  return { kept, dropped };
}

/**
 * Reduces an error to a code. Messages are never logged: ORM errors quote SQL and parameters, and
 * provider errors can quote prompts.
 */
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && SAFE_VALUE.test(code)) return code;
    const cause = (error as { cause?: unknown }).cause;
    if (cause) return errorCode(cause);
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && SAFE_VALUE.test(name)) return name;
  }
  return 'UNKNOWN_ERROR';
}

export function createLogger(
  service: string,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
) {
  const emit = (level: Level, event: string, fields: Fields = {}) => {
    const { kept, dropped } = sanitize(fields);
    write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        service,
        event: SAFE_VALUE.test(event) ? event : 'invalid_event_name',
        ...kept,
        ...(dropped ? { droppedFields: dropped } : {}),
      }),
    );
  };
  return {
    debug: (event: string, fields?: Fields) => emit('debug', event, fields),
    info: (event: string, fields?: Fields) => emit('info', event, fields),
    warn: (event: string, fields?: Fields) => emit('warn', event, fields),
    error: (event: string, fields?: Fields) => emit('error', event, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;
