// Azure OpenAI's Chat Completions on a deployment, through @ai-sdk/azure (ADR-028 FD-11). The endpoint is
// `https://<resource>.<openai|cognitiveservices>.azure.com/openai`, already checked by
// @ensemus/policy/endpoint, and holds no query. The package then adds `/deployments/<deployment>` and the
// api-version below, so the version always comes from this file and never from a stored address. The
// deployment is the profile's model ID, which the package puts into the path without encoding it, so its
// shape is checked again here. The key and base URL are always passed, because the package reads
// AZURE_API_KEY and AZURE_RESOURCE_NAME for missing ones.
//
// The package reads the `openai` provider options, so `store: false` and `parallelToolCalls: false` from
// the adapter's call options reach Azure as they reach OpenAI.
import { createAzure } from '@ai-sdk/azure';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { validModelId } from '@ensemus/domain/ai-providers';
import type { AdapterCall } from '../types';
import { ProviderCallRefused } from './refusal';

/**
 * The data-plane versions this adapter may ask for. The newest generally available one, which has tools,
 * json_schema response formats and parallel_tool_calls. Moving it is a code change and a conformance run.
 */
export const AZURE_API_VERSIONS = ['2024-10-21'] as const;
export const AZURE_API_VERSION: (typeof AZURE_API_VERSIONS)[number] = '2024-10-21';

export function azureModel(
  call: Pick<AdapterCall, 'modelId' | 'endpointUrl' | 'apiKey'>,
  fetchOnce: typeof fetch,
): LanguageModelV4 {
  const apiKey = call.apiKey?.length ? call.apiKey.toString('utf8') : '';
  if (!apiKey || !validModelId('azure_openai', call.modelId)) throw new ProviderCallRefused();
  return createAzure({
    apiKey,
    baseURL: call.endpointUrl.replace(/\/$/, ''),
    apiVersion: AZURE_API_VERSION,
    useDeploymentBasedUrls: true,
    fetch: fetchOnce,
  }).chat(call.modelId);
}
