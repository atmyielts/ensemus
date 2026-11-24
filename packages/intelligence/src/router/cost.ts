// What a call will cost, and did. Integers of micro-USD (FD-6). Rounded up, and worked in BigInt, because a
// budget has to over-count rather than under, and a float would break reconciliation. Rates are data, from
// the tenant's rate card: there is no price in this file.
import type { RateCardRef } from '@ensemus/application/ai-ports';
import type { ProviderKind } from '@ensemus/domain/ai';
import { countTokens as countCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { countTokens as countO200k } from 'gpt-tokenizer/encoding/o200k_base';
import type { AdapterTool, ContextMessage } from '../types';
import { generationInputBytes, generationInputText } from '../adapters';

const MILLION = 1_000_000n;

/** The cost of a number of tokens at a rate per million, rounded up. */
export function tokensToMicros(tokens: number, microsPerMtok: number): number {
  if (![tokens, microsPerMtok].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new RangeError('Invalid model money input');
  const exact = BigInt(tokens) * BigInt(microsPerMtok),
    rounded = (exact + MILLION - 1n) / MILLION;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Model cost is not exact');
  return Number(rounded);
}

export type CallCost = { inputMicros: number; outputMicros: number; totalMicros: number };

export function costOf(
  usage: { inputTokens: number; outputTokens: number },
  rate: RateCardRef,
): CallCost {
  const inputMicros = tokensToMicros(usage.inputTokens, rate.inputMicrosPerMtok);
  const outputMicros = tokensToMicros(usage.outputTokens, rate.outputMicrosPerMtok);
  const total = BigInt(inputMicros) + BigInt(outputMicros);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Model cost is not exact');
  return { inputMicros, outputMicros, totalMicros: Number(total) };
}

// --- Counting tokens.
//
// A reservation holds the most a call could cost, and the settlement gives the rest back. Counting each
// UTF-8 byte as a token made that bound safe and about four times too high for English, so a run that fit
// its budget was refused. Now the bound comes from a real tokenizer, with a margin that keeps it above what
// the provider will bill:
//
// - OpenAI's own models use a public encoding (o200k_base or cl100k_base), so the count is exact. It is
//   taken over the whole serialized request, JSON keys and escapes included, which already counts more
//   than the provider's chat template bills. A further 5% and a fixed allowance cover the template's own
//   few tokens per message and the way tool definitions are rendered on their side.
// - Every other provider (Anthropic, Gemini, Bedrock's families, and anything OpenAI-compatible) has no
//   public tokenizer we can run. Their estimate is half again the o200k count, plus half a token for every
//   byte outside ASCII, because the smaller vocabularies some of them use split non-Latin text much more
//   finely than o200k does. For English that is about 2.7 bytes a token; for Chinese it is over two and a
//   half tokens a character, more than a byte-fallback vocabulary has been seen to spend on common text.
//
// Nothing is ever counted above one token a byte. That stays the provable bound, since every encoding we
// call spends at least one byte on a token, and it is what a provider's reported usage is held to.

/** Spare tokens added to every count, for a chat template's framing and the reply's priming. */
const FIXED_ALLOWANCE = 64;
/** OpenAI's own encodings are exact, so only the template's rendering needs a margin. */
const EXACT_MARGIN = 1.05;
/** For providers without a public tokenizer, how far beyond o200k their tokenizers have been seen to go. */
const ESTIMATE_MARGIN = 1.5;
/** For the same providers, added per byte outside ASCII, where small vocabularies fall back to bytes. */
const NON_ASCII_ALLOWANCE = 0.5;

/** Special-token strings in a document are text like any other, never a control token. */
const AS_TEXT = { disallowedSpecial: new Set<string>() };

export type TokenEncoding = 'o200k_base' | 'cl100k_base';

/**
 * The encoding an OpenAI model uses, from its ID, or null where it is not certain. An Azure deployment is
 * named by its owner and could be any model, so only `openai_hosted` gets an exact count.
 */
export function encodingFor(providerKind: ProviderKind | undefined, modelId: string | undefined) {
  if (providerKind !== 'openai_hosted' || !modelId) return null;
  const id = modelId.toLowerCase();
  if (/^(gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o1|o3|o4|gpt-oss|codex)/.test(id)) {
    return 'o200k_base' as const;
  }
  if (/^(gpt-4|gpt-3\.5)/.test(id)) return 'cl100k_base' as const;
  return null;
}

/** Bytes outside ASCII, counted without copying the text. */
function nonAsciiBytes(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) continue;
    // A surrogate pair is four bytes in UTF-8, two for each half; anything else up to three.
    count += code >= 0xd800 && code <= 0xdfff ? 2 : code < 0x800 ? 2 : 3;
  }
  return count;
}

/** How many tokens a text is, for one provider, as an upper bound. Never above its byte length. */
export function countInputTokens(
  text: string,
  target: { providerKind?: ProviderKind; modelId?: string } = {},
): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  const encoding = encodingFor(target.providerKind, target.modelId);
  let estimate: number;
  if (encoding === 'o200k_base') {
    estimate = Math.ceil(countO200k(text, AS_TEXT) * EXACT_MARGIN) + FIXED_ALLOWANCE;
  } else if (encoding === 'cl100k_base') {
    estimate = Math.ceil(countCl100k(text, AS_TEXT) * EXACT_MARGIN) + FIXED_ALLOWANCE;
  } else {
    estimate =
      Math.ceil(countO200k(text, AS_TEXT) * ESTIMATE_MARGIN) +
      Math.ceil(nonAsciiBytes(text) * NON_ASCII_ALLOWANCE) +
      FIXED_ALLOWANCE;
  }
  return Math.min(bytes, estimate);
}

type CeilingInput = {
  messages: readonly ContextMessage[];
  tools: readonly AdapterTool[];
  responseSchema: Record<string, unknown> | null;
  maxOutputTokens: number;
  modelId?: string;
  /** Which provider will read it. Without one, the estimate for providers with no public tokenizer. */
  providerKind?: ProviderKind;
};

/**
 * The most a call could use, for its reservation and for the profile's input limit. The input is counted
 * over exactly what the adapter serializes, tool definitions and response schema included.
 */
export function ceilingFor(input: CeilingInput): { inputTokens: number; outputTokens: number } {
  const inputTokens = countInputTokens(generationInputText(input), input);
  return { inputTokens, outputTokens: input.maxOutputTokens };
}

/**
 * The provable bound: one token a byte. A provider reporting more input than this is not believed, and its
 * answer is charged and refused. Between the ceiling and this bound, the real figure is charged as reported.
 */
export function inputTokenBound(input: CeilingInput): number {
  return generationInputBytes(input);
}
