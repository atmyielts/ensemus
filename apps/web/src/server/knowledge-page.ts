import 'server-only';
import { AppError } from '@ensemus/application';
import { notFound } from 'next/navigation';

/** Detail IDs and denied reads share one page response. This never turns an unknown failure into
 * empty success, and the underlying service remains responsible for fresh access checks. */
export async function knowledgeOrNotFound<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (
      error instanceof AppError &&
      ['NOT_FOUND', 'INVALID_INPUT', 'FORBIDDEN'].includes(error.code)
    )
      notFound();
    throw error;
  }
}
