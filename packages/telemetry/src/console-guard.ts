// Frameworks report uncaught errors through console.error, whole, and an ORM error's message is its
// SQL and its parameters. The allowlist in createLogger only covers code that calls it, so this closes
// the other door: console.error and console.warn keep an error code and a digest, and nothing else.
import { errorCode, type Logger } from './index';

const SAFE_DIGEST = /^[A-Za-z0-9@_-]{1,64}$/;

function digestOf(error: Error): string | undefined {
  const digest = (error as Error & { digest?: unknown }).digest;
  return typeof digest === 'string' && SAFE_DIGEST.test(digest) ? digest : undefined;
}

type ConsoleLike = { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

/** Replaces console.error and console.warn in this process. Returns how to put them back. */
export function installConsoleGuard(log: Logger, target: ConsoleLike = console) {
  const { error: originalError, warn: originalWarn } = target;
  const fieldsOf = (args: unknown[]) => {
    const error = args.find((arg): arg is Error => arg instanceof Error);
    if (!error) return {};
    const digest = digestOf(error);
    return { errorCode: errorCode(error), ...(digest ? { reasonCode: digest } : {}) };
  };
  target.error = (...args: unknown[]) => log.error('console.error', fieldsOf(args));
  target.warn = (...args: unknown[]) => log.warn('console.warn', fieldsOf(args));
  return () => {
    target.error = originalError;
    target.warn = originalWarn;
  };
}
