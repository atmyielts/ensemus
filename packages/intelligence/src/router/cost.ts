// What a call will cost, and did. Integers of micro-USD (FD-6). Rounded up, and worked in BigInt, because a
// budget has to over-count rather than under, and a float would break reconciliation. Rates are data, from
// the tenant's rate card: there is no price in this file.
import type { RateCardRef } from '@ensemus/application/ai-ports';
import type { AdapterTool, ContextMessage } from '../types';
import { generationInputBytes } from '../adapters';

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

/**
 * The most a call could use, for its reservation. No tokenizer here, and none is needed: a token is at least
 * a byte in everything we call, so the byte count bounds the input from above, without knowing the model.
 * That holds more than a call will spend, and the settlement gives the rest back.
 */
export function ceilingFor(input: {
  messages: readonly ContextMessage[];
  tools: readonly AdapterTool[];
  responseSchema: Record<string, unknown> | null;
  maxOutputTokens: number;
  modelId?: string;
}): { inputTokens: number; outputTokens: number } {
  const inputTokens = generationInputBytes(input);
  return { inputTokens, outputTokens: input.maxOutputTokens };
}
