// Native rerank, on the provider's own `/rerank` endpoint: Cohere's v2 shape and Voyage's v1 shape. Direct
// fetch (ADR-028 FD-11 allows it where no package fits), one request through the call's guarded fetch, the
// key lent for the call only, and no provider text out: a failure is a code, as in ./adapters.
//
// Both answer a list of (index, relevance_score) rows. A row is trusted for nothing: an index out of range,
// a repeated one, a score that is not a finite number, or a count other than the one asked for refuses the
// whole answer, so a broken ranking can never reorder evidence.
import { isRerankOnlyKind, validModelId } from '@ensemus/domain/ai-providers';
import { failureOf, type WireState } from './adapters';
import type { AdapterCall, AdapterResult, AdapterUsage } from './types';

export type RerankAdapterCall = Pick<
  AdapterCall,
  'providerKind' | 'modelId' | 'endpointUrl' | 'fetch' | 'apiKey' | 'timeoutMs'
> & {
  query: string;
  documents: readonly string[];
};

export type RerankAdapterResult =
  /** Document indexes, most relevant first. Every document is ranked exactly once. */
  | { kind: 'ranked'; order: readonly number[]; usage: AdapterUsage }
  | Extract<AdapterResult, { kind: 'failure' }>;

export interface RerankAdapter {
  rerank(call: RerankAdapterCall, signal: AbortSignal): Promise<RerankAdapterResult>;
}

/** The same bound the knowledge gateway puts on a rerank, so this adapter never sends more. */
const MAX_DOCUMENTS = 1000;

const failed = (
  failure: Extract<AdapterResult, { kind: 'failure' }>['failure'],
  mayHaveBilled: boolean,
  usage: AdapterUsage = null,
): RerankAdapterResult => ({ kind: 'failure', failure, mayHaveBilled, usage });

/**
 * The request body for each wire shape. Every document is asked for, so a short answer is a broken one.
 * Voyage is told not to truncate, so a document too long for it is refused rather than ranked on a part.
 * Cohere has no such switch: it ranks on each document's first 4096 tokens, which its API documents.
 */
function bodyFor(call: RerankAdapterCall): Record<string, unknown> {
  return call.providerKind === 'voyage_hosted'
    ? {
        model: call.modelId,
        query: call.query,
        documents: call.documents,
        top_k: call.documents.length,
        truncation: false,
      }
    : {
        model: call.modelId,
        query: call.query,
        documents: call.documents,
        top_n: call.documents.length,
      };
}

/** Indexes by falling score, ties by index, or null if any row is not a real ranking of these documents. */
export function rankedOrder(rows: unknown, count: number): readonly number[] | null {
  if (!Array.isArray(rows) || rows.length !== count) return null;
  const seen = new Set<number>();
  const scored: { index: number; score: number }[] = [];
  for (const row of rows as unknown[]) {
    if (typeof row !== 'object' || row === null) return null;
    const { index, relevance_score: score } = row as { index?: unknown; relevance_score?: unknown };
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= count ||
      seen.has(index) ||
      typeof score !== 'number' ||
      !Number.isFinite(score)
    ) {
      return null;
    }
    seen.add(index);
    scored.push({ index, score });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.index);
}

/** Voyage reports tokens. Cohere reports search units, which are not tokens, so its usage is unknown. */
function usageOf(
  kind: RerankAdapterCall['providerKind'],
  body: Record<string, unknown>,
): AdapterUsage {
  if (kind !== 'voyage_hosted') return null;
  const tokens = (body.usage as { total_tokens?: unknown } | undefined)?.total_tokens;
  return typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0
    ? { inputTokens: tokens, outputTokens: 0 }
    : null;
}

function rowsOf(kind: RerankAdapterCall['providerKind'], body: Record<string, unknown>): unknown {
  return kind === 'voyage_hosted' ? body.data : body.results;
}

export function createRerankAdapter(): RerankAdapter {
  return {
    async rerank(call, signal) {
      if (signal.aborted) return failed('cancelled', false);
      if (
        !isRerankOnlyKind(call.providerKind) ||
        !validModelId(call.providerKind, call.modelId) ||
        typeof call.query !== 'string' ||
        !call.query ||
        call.documents.length < 1 ||
        call.documents.length > MAX_DOCUMENTS ||
        call.documents.some((value) => typeof value !== 'string' || !value)
      ) {
        return failed('bad_request', false);
      }
      // Both kinds are hosted: no lent key means no call, and never a key from anywhere else.
      if (!call.apiKey?.length) return failed('auth_failed', false);

      const wire: WireState = { requested: false, status: null };
      const controller = new AbortController();
      const stop = () => controller.abort();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, call.timeoutMs);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      const aborted = new Promise<null>((resolve) => {
        if (controller.signal.aborted) resolve(null);
        else controller.signal.addEventListener('abort', () => resolve(null), { once: true });
      });

      const work = (async (): Promise<RerankAdapterResult> => {
        // The header is a string, as for every adapter: see the lifetime note in ./credentials.ts.
        const authorization = `Bearer ${call.apiKey!.toString('utf8')}`;
        wire.requested = true;
        const response = await call.fetch(`${call.endpointUrl.replace(/\/$/, '')}/rerank`, {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(bodyFor(call)),
          redirect: 'error',
          signal: controller.signal,
        });
        wire.status = response.status;
        // Read whatever the status, so the connection is finished with, and then dropped unread on an
        // error: provider error text never leaves this function.
        const text = await response.text();
        if (response.status < 200 || response.status >= 300) return failureOf(null, wire);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return failed('malformed_response', true);
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          return failed('malformed_response', true);
        }
        const fields = body as Record<string, unknown>;
        const usage = usageOf(call.providerKind, fields);
        const order = rankedOrder(rowsOf(call.providerKind, fields), call.documents.length);
        return order ? { kind: 'ranked', order, usage } : failed('malformed_response', true, usage);
      })();
      work.catch(() => undefined);
      try {
        const result = await Promise.race([work, aborted]);
        if (result === null || controller.signal.aborted) {
          return failed(timedOut ? 'timeout' : 'cancelled', wire.requested);
        }
        return result;
      } catch (error) {
        return controller.signal.aborted
          ? failed(timedOut ? 'timeout' : 'cancelled', wire.requested)
          : failureOf(error, wire);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      }
    },
  };
}
