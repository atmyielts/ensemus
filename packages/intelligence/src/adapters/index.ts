// Owned by the transport slice (MODEL-02). See docs/06-delivery/m4-slices.md and ADR-028 FD-11. Calls a
// provider package's `doGenerate` once, through the call's guarded fetch. `ai` core is not used: lint
// bans it, because it retries by default and can resolve a bare model string to a hosted gateway.
//
// What comes back is untrusted, and an SDK error can quote the whole prompt or the key. So this file reads
// provider errors only to choose a code, returns nothing from them, and never logs at all.
import { createHash } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  type JSONSchema7,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import { isHostedProviderKind } from '@ensemus/domain/ai';
import { EndpointRefused, EndpointUnreachable, ResponseTooLarge } from '../net/errors';
import type {
  AdapterCall,
  AdapterFailure,
  AdapterResult,
  AdapterTool,
  AdapterUsage,
  ContextMessage,
  ModelAdapter,
} from '../types';

type Failure = Extract<AdapterResult, { kind: 'failure' }>;

const failed = (
  failure: AdapterFailure,
  mayHaveBilled: boolean,
  usage: AdapterUsage = null,
): Failure => ({ kind: 'failure', failure, mayHaveBilled, usage });

/** What the call did on the wire, which decides whether a provider could have billed for it. */
export type WireState = { requested: boolean; status: number | null };

/**
 * Every provider's package reads its own environment variables for a missing key or address, so a key is
 * always passed explicitly (or the call refused) and the base URL is always the verified endpoint. A key
 * becomes a string here because a header can only be one: see the lifetime note in ../credentials.ts.
 */
function modelFor(call: AdapterCall, fetchOnce: typeof fetch): LanguageModelV4 {
  const apiKey = call.apiKey?.toString('utf8');
  const baseURL = call.endpointUrl;
  switch (call.providerKind) {
    case 'openai_hosted':
      // Chat Completions and not Responses: it stores nothing by default, and keeps no conversation on
      // the provider's side, so `store: false` below is a second statement and not the only one.
      return createOpenAI({ baseURL, fetch: fetchOnce, ...(apiKey ? { apiKey } : {}) }).chat(
        call.modelId,
      );
    case 'anthropic_hosted':
      return createAnthropic({ baseURL, fetch: fetchOnce, ...(apiKey ? { apiKey } : {}) }).messages(
        call.modelId,
      );
    case 'openai_compatible':
    case 'local_openai_compatible':
      return createOpenAICompatible({
        name: 'compatible',
        baseURL,
        fetch: fetchOnce,
        // Sends the schema to the server. A server that cannot honour one has to say so, and otherwise
        // the output check catches it: the package's fallback is a looser mode with only a warning.
        supportsStructuredOutputs: true,
        ...(apiKey ? { apiKey } : {}),
      }).chatModel(call.modelId);
  }
}

/**
 * Evidence and tool output are data, whatever they say, and only `policy` reaches the system role (FD-17).
 * The boundary is a digest of the whole prompt, so a document cannot contain the marker that would close
 * its own section: it would have to include its own hash. It is stable for a given prompt, so a run can
 * be reproduced.
 */
function promptOf(messages: readonly ContextMessage[]): LanguageModelV4CallOptions['prompt'] {
  const digest = createHash('sha256');
  for (const message of messages) digest.update(message.role).update('\0').update(message.text);
  const boundary = digest.digest('hex').slice(0, 32);

  const system = messages
    .filter((message) => message.role === 'policy')
    .map((message) => message.text)
    .join('\n\n');
  const parts = messages
    .filter((message) => message.role !== 'policy')
    .map((message) => ({
      type: 'text' as const,
      text:
        message.role === 'task'
          ? message.text
          : `<${message.role} boundary="${boundary}">\n${message.text}\n</${message.role} boundary="${boundary}">`,
    }));
  return [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    { role: 'user' as const, content: parts },
  ];
}

/** Tool IDs have dots, which no provider's tool names allow. Decoded by table, never by pattern. */
function wireNames(tools: readonly AdapterTool[]) {
  const toWire = new Map<string, string>();
  const toId = new Map<string, string>();
  tools.forEach((tool, index) => {
    const base = tool.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56);
    const name = toId.has(base) ? `${base}_${index}` : base;
    toWire.set(tool.id, name);
    toId.set(name, tool.id);
  });
  return { toWire, toId };
}

function callOptions(
  call: Pick<AdapterCall, 'messages' | 'tools' | 'responseSchema' | 'maxOutputTokens'>,
  toWire: ReadonlyMap<string, string>,
  abortSignal: AbortSignal,
): LanguageModelV4CallOptions {
  const hasTools = call.tools.length > 0;
  return {
    prompt: promptOf(call.messages),
    maxOutputTokens: call.maxOutputTokens,
    abortSignal,
    ...(call.responseSchema
      ? {
          responseFormat: {
            type: 'json' as const,
            schema: call.responseSchema as JSONSchema7,
          },
        }
      : {}),
    ...(hasTools
      ? {
          toolChoice: { type: 'auto' as const },
          tools: call.tools.map((tool) => ({
            type: 'function' as const,
            name: toWire.get(tool.id) ?? tool.id,
            description: tool.description,
            inputSchema: tool.parameters as JSONSchema7,
          })),
        }
      : {}),
    // One tool per turn, since a result has room for one and a run decides what follows each. Sent to
    // the providers that take the setting, and a response with several is refused in any case.
    providerOptions: {
      openai: { store: false, ...(hasTools ? { parallelToolCalls: false } : {}) },
      ...(hasTools ? { anthropic: { disableParallelToolUse: true } } : {}),
    },
  };
}

/** Count the actual provider-neutral SDK input, including data-role fences, function names/schema,
 * response format and role/envelope fields. Never reserve from message text alone. */
export function generationInputBytes(
  input: Pick<AdapterCall, 'messages' | 'tools' | 'responseSchema' | 'maxOutputTokens'> & {
    modelId?: string;
  },
): number {
  return Buffer.byteLength(
    JSON.stringify({
      model: input.modelId ?? '',
      ...callOptions(input, wireNames(input.tools).toWire, new AbortController().signal),
    }),
    'utf8',
  );
}

/** Full trusted SDK request identity. Keep separate from the historical message-only audit hash and
 * the unchanged token-envelope serialization. No key, guarded fetch or cancellation object is stored. */
export function generationRequestHash(
  input: Pick<
    AdapterCall,
    | 'providerKind'
    | 'endpointUrl'
    | 'modelId'
    | 'messages'
    | 'tools'
    | 'responseSchema'
    | 'maxOutputTokens'
    | 'timeoutMs'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        protocol: 'sdk-main-v1',
        providerKind: input.providerKind,
        endpointUrl: input.endpointUrl,
        model: input.modelId,
        timeoutMs: input.timeoutMs,
        toolVersions: input.tools.map(({ id, version }) => ({ id, version })),
        ...callOptions(input, wireNames(input.tools).toWire, new AbortController().signal),
      }),
    )
    .digest('hex');
}

function usageOf(result: LanguageModelV4GenerateResult): AdapterUsage {
  const input = result.usage?.inputTokens?.total;
  const output = result.usage?.outputTokens?.total;
  const counts = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  // Null means unknown, and the ledger treats it that way. A guess here would understate spending.
  return counts(input) && counts(output) ? { inputTokens: input, outputTokens: output } : null;
}

/** A feature that was asked for and is not being honoured. The call happened, so it may have billed. */
function droppedARequirement(result: LanguageModelV4GenerateResult): boolean {
  return (result.warnings ?? []).some(
    (warning) =>
      warning.type === 'unsupported' &&
      /^(responseFormat|toolChoice|tools?\b|maxOutputTokens)/.test(warning.feature),
  );
}

function resultOf(
  call: AdapterCall,
  result: LanguageModelV4GenerateResult,
  toId: ReadonlyMap<string, string>,
): AdapterResult {
  const usage = usageOf(result);
  if (droppedARequirement(result)) return failed('bad_request', true, usage);

  // Anything cut off is not an answer: a truncated JSON document or tool call could still parse.
  switch (result.finishReason?.unified) {
    case 'stop':
    case 'tool-calls':
      break;
    case 'error':
      return failed('server_error', true, usage);
    default:
      // Includes `length`, `content-filter`, `interrupted` and `other`: completeness is unconfirmed.
      return failed('partial_response', true, usage);
  }

  const toolCalls = result.content.flatMap((part) => (part.type === 'tool-call' ? [part] : []));
  if (toolCalls.length > 1) return failed('malformed_response', true, usage);
  const toolCall = toolCalls[0];
  if (toolCall) {
    // A name outside the list has no ID to report. The model's own text never becomes one, since a tool
    // ID is the kind of value that ends up in a log line or a label.
    const toolId = toId.get(toolCall.toolName);
    if (!toolId || toolCall.providerExecuted) return failed('malformed_response', true, usage);
    try {
      const args: unknown = JSON.parse(toolCall.input);
      // Every tool takes an object. What is in it is the tool gateway's to check, and it trusts nothing.
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return failed('malformed_response', true, usage);
      }
      return { kind: 'tool_call', toolId, args, usage };
    } catch {
      return failed('malformed_response', true, usage);
    }
  }

  const text = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  if (!text) return failed('malformed_response', true, usage);
  if (call.responseSchema) {
    // Parsed here so a broken document is this adapter's failure. The gateway checks it meets the schema.
    try {
      JSON.parse(text);
    } catch {
      return failed('malformed_response', true, usage);
    }
  }
  return { kind: 'final', text, usage };
}

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current != null && !chain.includes(current) && chain.length < 16) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** Read to choose a code, and dropped. Provider wording changes, so a miss falls back to bad_request. */
function saysContextTooLong(responseBody: string | undefined): boolean {
  if (!responseBody) return false;
  return /context_length_exceeded|maximum context length|context window|prompt is too long|input is too long|too many (input )?tokens/i.test(
    responseBody,
  );
}

function failureForStatus(status: number, responseBody: string | undefined): AdapterFailure {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 413) return 'context_too_long';
  if (status >= 500) return 'server_error';
  return saysContextTooLong(responseBody) ? 'context_too_long' : 'bad_request';
}

/** Connection errors from before a byte of the request could have reached a provider. */
const NEVER_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'EPROTO',
]);

const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

export function failureOf(error: unknown, wire: WireState): Failure {
  const chain = causes(error);
  const refused = chain.find((item) => item instanceof EndpointRefused);
  if (refused instanceof EndpointRefused) {
    return failed('endpoint_refused', refused.afterRequest);
  }
  if (chain.some((item) => item instanceof EndpointUnreachable)) {
    return failed('connect_failed', false);
  }
  if (chain.some((item) => item instanceof ResponseTooLarge)) {
    return failed('malformed_response', true);
  }

  const status = wire.status;
  if (status !== null && status >= 300) {
    const apiError = chain.find((item) => APICallError.isInstance(item));
    const body = APICallError.isInstance(apiError) ? apiError.responseBody : undefined;
    return failed(failureForStatus(status, body), true);
  }
  if (status !== null) {
    // An answer had started. A broken connection is a partial answer, and anything else is one that
    // arrived whole and made no sense: bad JSON, or a shape the package's schema refused.
    const cutOff = chain.some((item) => {
      const code = codeOf(item);
      return (
        (code !== null && /^(UND_ERR_|ECONNRESET|EPIPE|ETIMEDOUT)/.test(code)) ||
        (item as { message?: unknown } | null)?.message === 'terminated'
      );
    });
    return failed(cutOff ? 'partial_response' : 'malformed_response', true);
  }

  // No answer at all.
  if (!wire.requested) return failed('bad_request', false);
  const codes = chain.map(codeOf);
  if (codes.some((code) => code === 'UND_ERR_HEADERS_TIMEOUT')) return failed('timeout', true);
  if (codes.some((code) => code !== null && NEVER_SENT.has(code))) {
    return failed('connect_failed', false);
  }
  if (codes.some((code) => code !== null && /^(ECONNRESET|EPIPE|UND_ERR_SOCKET)/.test(code))) {
    return failed('connect_failed', true);
  }
  return failed('unknown', true);
}

class Adapter implements ModelAdapter {
  async generate(call: AdapterCall, signal: AbortSignal): Promise<AdapterResult> {
    if (signal.aborted) return failed('cancelled', false);
    // A package falls back to its own environment variable with no key, so a hosted call without a
    // lent key stops here and can never go out with whatever this process has lying around.
    if (isHostedProviderKind(call.providerKind) && !call.apiKey?.length) {
      return failed('auth_failed', false);
    }
    if (!call.messages.some((message) => message.role !== 'policy')) {
      return failed('bad_request', false);
    }

    const wire: WireState = { requested: false, status: null };
    const fetchOnce: typeof fetch = async (input, init) => {
      // No package retries inside doGenerate today. This holds "one call" through an upgrade: a second
      // request fails rather than spending again.
      if (wire.requested) throw new EndpointRefused({ afterRequest: true });
      wire.requested = true;
      const response = await call.fetch(input, init);
      wire.status = response.status;
      return response;
    };

    const controller = new AbortController();
    let timedOut = false;
    const stop = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, call.timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    const aborted = new Promise<'aborted'>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });

    const { toWire, toId } = wireNames(call.tools);
    try {
      // A fresh instance per call, so nothing holding the key outlives it, and exactly one doGenerate.
      const model = modelFor(call, fetchOnce);
      const generating = Promise.resolve(
        model.doGenerate(callOptions(call, toWire, controller.signal)),
      );
      // Whatever the package does with its signal, a cancel or timeout returns now. A late rejection
      // from the abandoned call has nothing left to do.
      generating.catch(() => undefined);
      const outcome = await Promise.race([generating, aborted]);
      if (outcome === 'aborted' || controller.signal.aborted) {
        return failed(timedOut ? 'timeout' : 'cancelled', wire.requested);
      }
      return resultOf(call, outcome, toId);
    } catch (error) {
      if (controller.signal.aborted) {
        return failed(timedOut ? 'timeout' : 'cancelled', wire.requested);
      }
      return failureOf(error, wire);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
  }
}

/** A fresh provider instance per call, so this holds nothing between calls. */
export function createModelAdapter(): ModelAdapter {
  return new Adapter();
}
