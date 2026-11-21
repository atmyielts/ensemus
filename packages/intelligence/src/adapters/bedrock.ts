// Bedrock's Converse API, through @ai-sdk/amazon-bedrock (ADR-028 FD-11), signed with SigV4 by the package
// (aws4fetch) or sent with a Bedrock API key as a bearer token. The sealed key is compact JSON in one of
// two shapes (@ensemus/domain/ai-providers), parsed here and nowhere else, and never reported.
//
// The package reads AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN,
// AWS_ENDPOINT_URL, AWS_ENDPOINT_URL_BEDROCK_RUNTIME and AWS_BEARER_TOKEN_BEDROCK for anything not given.
// So everything is given: the region is the one the checked host names, the base URL is that host, and
// the credentials come from a provider function. The API key is an empty string for a signed call rather
// than absent, because the package treats an absent one as "read AWS_BEARER_TOKEN_BEDROCK", and a token
// found there would replace the signature. The conformance suite sets every one of those variables and
// checks none of them is used.
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { parseBedrockCredential, validModelId } from '@ensemus/domain/ai-providers';
import { bedrockRegionOf } from '@ensemus/policy/endpoint';
import type { AdapterCall } from '../types';
import { ProviderCallRefused } from './refusal';

export function bedrockModel(
  call: Pick<AdapterCall, 'modelId' | 'endpointUrl' | 'apiKey'>,
  fetchOnce: typeof fetch,
): LanguageModelV4 {
  const region = bedrockRegionOf(call.endpointUrl);
  const credential = call.apiKey?.length
    ? parseBedrockCredential(call.apiKey.toString('utf8'))
    : null;
  if (!region || !credential || !validModelId('bedrock_hosted', call.modelId)) {
    throw new ProviderCallRefused();
  }
  const common = { region, baseURL: call.endpointUrl.replace(/\/$/, ''), fetch: fetchOnce };
  if (credential.kind === 'api_key') {
    return createAmazonBedrock({ ...common, apiKey: credential.apiKey }).languageModel(
      call.modelId,
    );
  }
  const { accessKeyId, secretAccessKey, sessionToken } = credential;
  return createAmazonBedrock({
    ...common,
    apiKey: '',
    credentialProvider: async () => ({
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    }),
  }).languageModel(call.modelId);
}
