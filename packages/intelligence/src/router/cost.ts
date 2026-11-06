// What a call will cost, and did. Integers of micro-USD (FD-6). Rounded up, and worked in BigInt, because a
// budget has to over-count rather than under, and a float would break reconciliation. Rates are data, from
// the tenant's rate card: there is no price in this file.
import type { RateCardRef } from '@ensemus/application/ai-ports';
import type { AdapterTool, ContextMessage } from '../types';

const MILLION = 1_000_000n;

/** The cost of a number of tokens at a rate per million, rounded up. */
export function tokensToMicros(tokens: number, microsPerMtok: number): number {
  const exact = BigInt(Math.max(0, Math.ceil(tokens))) * BigInt(microsPerMtok);
  return Number((exact + MILLION - 1n) / MILLION);
}

export type CallCost = { inputMicros: number; outputMicros: number; totalMicros: number };

export function costOf(
  usage: { inputTokens: number; outputTokens: number },
  rate: RateCardRef,
): CallCost {
  const inputMicros = tokensToMicros(usage.inputTokens, rate.inputMicrosPerMtok);
  const outputMicros = tokensToMicros(usage.outputTokens, rate.outputMicrosPerMtok);
  return { inputMicros, outputMicros, totalMicros: inputMicros + outputMicros };
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
}): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  for (const message of input.messages) inputTokens += Buffer.byteLength(message.text, 'utf8');
  if (input.tools.length > 0) inputTokens += Buffer.byteLength(JSON.stringify(input.tools), 'utf8');
  if (input.responseSchema) {
    inputTokens += Buffer.byteLength(JSON.stringify(input.responseSchema), 'utf8');
  }
  return { inputTokens, outputTokens: input.maxOutputTokens };
}
