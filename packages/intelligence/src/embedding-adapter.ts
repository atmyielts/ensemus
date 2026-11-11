// Native embeddings use the provider's actual embedding endpoint. No core SDK retries, generation
// fallback, environment credential lookup or provider error text crosses this boundary.
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { kindServesPurpose } from '@ensemus/domain/ai-providers';
import { validEmbedding } from '@ensemus/domain/knowledge-models';
import { failureOf, type WireState } from './adapters';
import { geminiEmbeddingModel } from './adapters/gemini';
import { EndpointRefused } from './net/errors';
import type { AdapterCall, AdapterResult, AdapterUsage } from './types';

export type EmbeddingAdapterCall = Pick<
  AdapterCall,
  'providerKind' | 'modelId' | 'endpointUrl' | 'fetch' | 'apiKey' | 'timeoutMs'
> & {
  inputs: readonly string[];
  dimension: number;
};
export type EmbeddingAdapterResult =
  | { kind: 'embedded'; vectors: readonly (readonly number[])[]; usage: AdapterUsage }
  | Extract<AdapterResult, { kind: 'failure' }>;
export interface EmbeddingAdapter {
  embed(call: EmbeddingAdapterCall, signal: AbortSignal): Promise<EmbeddingAdapterResult>;
}
const failed = (
  failure: Extract<AdapterResult, { kind: 'failure' }>['failure'],
  mayHaveBilled: boolean,
  usage: AdapterUsage = null,
): EmbeddingAdapterResult => ({ kind: 'failure', failure, mayHaveBilled, usage });

/** The pinned protocol requires explicit indices, so shuffled provider rows cannot attach to another chunk. */
export function indexedEmbeddings(
  body: unknown,
  count: number,
  dimension: number,
): readonly (readonly number[])[] | null {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('data' in body) ||
    !Array.isArray(body.data) ||
    body.data.length !== count
  )
    return null;
  const vectors: (readonly number[] | undefined)[] = new Array(count);
  for (const row of body.data as unknown[]) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('index' in row) ||
      !('embedding' in row) ||
      typeof row.index !== 'number' ||
      !Number.isSafeInteger(row.index) ||
      row.index < 0 ||
      row.index >= count ||
      vectors[row.index] !== undefined ||
      !validEmbedding(row.embedding, dimension)
    )
      return null;
    vectors[row.index] = row.embedding;
  }
  return vectors.every((vector) => vector !== undefined)
    ? (vectors as readonly (readonly number[])[])
    : null;
}

/**
 * Gemini's protocol has no index on a row: embedContent answers one vector, and batchEmbedContents answers
 * one per request in request order. So the count has to match exactly, and every vector has the size asked
 * for, or nothing is taken.
 */
export function orderedEmbeddings(
  vectors: unknown,
  count: number,
  dimension: number,
): readonly (readonly number[])[] | null {
  return Array.isArray(vectors) &&
    vectors.length === count &&
    vectors.every((vector) => validEmbedding(vector, dimension))
    ? (vectors as readonly (readonly number[])[])
    : null;
}

export function createEmbeddingAdapter(): EmbeddingAdapter {
  return {
    async embed(call, signal) {
      if (signal.aborted) return failed('cancelled', false);
      if (
        !kindServesPurpose(call.providerKind, 'embed') ||
        !Number.isInteger(call.dimension) ||
        call.dimension < 1 ||
        call.dimension > 8192 ||
        call.inputs.length < 1 ||
        call.inputs.length > 128 ||
        call.inputs.some((value) => typeof value !== 'string' || !value)
      )
        return failed('bad_request', false);
      if (call.providerKind !== 'local_openai_compatible' && !call.apiKey?.length)
        return failed('auth_failed', false);
      const wire: WireState = { requested: false, status: null };
      const once: typeof fetch = async (input, init) => {
        if (wire.requested) throw new EndpointRefused({ afterRequest: true });
        wire.requested = true;
        const response = await call.fetch(input, init);
        wire.status = response.status;
        return response;
      };
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
      try {
        const options = {
          baseURL: call.endpointUrl,
          fetch: once,
          ...(call.apiKey?.length ? { apiKey: call.apiKey.toString('utf8') } : {}),
        };
        const gemini = call.providerKind === 'gemini_hosted';
        const model = gemini
          ? geminiEmbeddingModel(call, once)
          : call.providerKind === 'openai_hosted'
            ? createOpenAI(options).embeddingModel(call.modelId)
            : createOpenAICompatible({ ...options, name: 'compatible' }).embeddingModel(
                call.modelId,
              );
        const work = Promise.resolve(
          model.doEmbed({
            values: [...call.inputs],
            dimensions: call.dimension,
            abortSignal: controller.signal,
          }),
        );
        work.catch(() => undefined);
        const result = await Promise.race([work, aborted]);
        if (result === null || controller.signal.aborted)
          return failed(timedOut ? 'timeout' : 'cancelled', wire.requested);
        const tokens = result.usage?.tokens;
        const usage =
          typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0
            ? { inputTokens: tokens, outputTokens: 0 }
            : null;
        const vectors = gemini
          ? orderedEmbeddings(result.embeddings, call.inputs.length, call.dimension)
          : indexedEmbeddings(result.response?.body, call.inputs.length, call.dimension);
        if (!vectors || result.warnings.some((warning) => warning.type === 'unsupported'))
          return failed('malformed_response', true, usage);
        return { kind: 'embedded', vectors, usage };
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
