// By default the Temporal SDK logs activity errors with their full message and stack, which can
// quote prompts or documents. This keeps only an error code and a component name (ADR-013).
import type { Logger as TemporalLogger, LogLevel, LogMetadata } from '@temporalio/common';
import { errorCode, type Logger } from '@ensemus/telemetry';

export function createTemporalLogger(log: Logger): TemporalLogger {
  const emit = (level: LogLevel, _message: string, meta?: LogMetadata) => {
    if (level === 'TRACE' || level === 'DEBUG') return;
    const component = typeof meta?.sdkComponent === 'string' ? meta.sdkComponent : 'sdk';
    const fields = meta?.error ? { errorCode: errorCode(meta.error) } : {};
    const event = `temporal.${component}`;
    if (level === 'ERROR') log.error(event, fields);
    else if (level === 'WARN') log.warn(event, fields);
    else if (level === 'INFO') log.info(event, fields);
  };
  return {
    log: emit,
    trace: (message, meta) => emit('TRACE', message, meta),
    debug: (message, meta) => emit('DEBUG', message, meta),
    info: (message, meta) => emit('INFO', message, meta),
    warn: (message, meta) => emit('WARN', message, meta),
    error: (message, meta) => emit('ERROR', message, meta),
  };
}
