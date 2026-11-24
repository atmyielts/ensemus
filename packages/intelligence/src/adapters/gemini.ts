// Gemini's generateContent and embedding calls, through @ai-sdk/google (ADR-028 FD-11). The key and the base
// URL are always passed, because the package reads GOOGLE_GENERATIVE_AI_API_KEY for a missing key. The
// model ID goes into the request path, so it has to have the shape @ensemus/domain/ai-providers allows.
//
// Gemini has no setting that limits a turn to one function call, so a response with several is refused by
// the adapter's result check. A response that asks to be continued would need a second request, which the
// adapter's one-request fetch refuses, so it ends as `endpoint_refused` and is counted as billed.
import { createGoogle } from '@ai-sdk/google';
import type { EmbeddingModelV4, LanguageModelV4 } from '@ai-sdk/provider';
import { validModelId } from '@ensemus/domain/ai-providers';
import type { AdapterCall } from '../types';
import { ProviderCallRefused } from './refusal';

type GeminiCall = Pick<AdapterCall, 'modelId' | 'endpointUrl' | 'apiKey'>;

function providerFor(call: GeminiCall, fetchOnce: typeof fetch) {
  const apiKey = call.apiKey?.length ? call.apiKey.toString('utf8') : '';
  if (!apiKey || !validModelId('gemini_hosted', call.modelId)) throw new ProviderCallRefused();
  return createGoogle({ apiKey, baseURL: call.endpointUrl, fetch: fetchOnce });
}

/** An answer the package parsed with no candidate in it. Carries no text, like every error here. */
class NoCandidate extends Error {
  override name = 'NoCandidate';
  constructor() {
    super('GEMINI_NO_CANDIDATE');
  }
}

/**
 * Every field of Gemini's answer is optional to the package, so a body with no candidate at all parses
 * and reads as an unfinished answer. It is not one: nothing was answered, so it is refused as malformed,
 * by throwing after the request, which the adapter reads as a bad body with a 2xx status.
 */
export function geminiModel(call: GeminiCall, fetchOnce: typeof fetch): LanguageModelV4 {
  const inner = providerFor(call, fetchOnce).chat(call.modelId);
  return {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    doGenerate: async (options) => {
      const result = await inner.doGenerate(options);
      const body = result.response?.body as { candidates?: unknown } | null | undefined;
      if (!Array.isArray(body?.candidates) || body.candidates.length < 1) throw new NoCandidate();
      return result;
    },
    doStream: (options) => inner.doStream(options),
  };
}

/** One text uses embedContent and more use batchEmbedContents, whose answers come back in input order. */
export function geminiEmbeddingModel(call: GeminiCall, fetchOnce: typeof fetch): EmbeddingModelV4 {
  return providerFor(call, fetchOnce).embeddingModel(call.modelId);
}
