// What a model returned is untrusted (FD-8). This decides only whether it is well formed and clean enough to
// hand on. Whether a proposed tool call may run is the tool gateway's decision, against its own grants. A
// validator's errors can quote the data, so a failure here is a code and nothing else.
import type { AiReasonCode } from '@ensemus/domain/ai';
import { scanForSecrets } from '@ensemus/policy';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AdapterResult, AdapterTool, Malformation } from '../types';

export type OutputSchema = { validate: ValidateFunction } | null;

/** Compiled before a call, so a schema that cannot be used stops the turn before anything is paid for. */
export function compileOutputSchema(
  schema: Record<string, unknown> | null,
): { ok: true; schema: OutputSchema } | { ok: false } {
  if (schema === null) return { ok: true, schema: null };
  try {
    const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: false });
    addFormats(ajv);
    return { ok: true, schema: { validate: ajv.compile(schema) } };
  } catch {
    return { ok: false };
  }
}

/**
 * `malformation` is set only where the answer's shape alone was wrong, which a repair turn may correct. A
 * refusal for what an answer holds (a secret, markup that fetches, a tool nobody offered) never has one,
 * so it is never offered a second try.
 */
export type OutputCheck =
  { ok: true } | { ok: false; decisionCode: AiReasonCode | null; malformation?: Malformation };

const INVALID: OutputCheck = { ok: false, decisionCode: null };
const misshapen = (malformation: Malformation): OutputCheck => ({
  ok: false,
  decisionCode: null,
  malformation,
});

function holdsSecret(text: string, canaries: readonly string[]): boolean {
  return scanForSecrets([{ id: 'output', text }], canaries).hits.length > 0;
}

/**
 * Markup that makes whatever shows it fetch an address on its own, before anyone clicks: a markdown image,
 * and the HTML elements that load. A model told by a document to "add this image" can put anything it has
 * read into the address, and the first renderer that shows the text sends it there. Ensemus shows model text
 * as text, but drafts, messages and documents leave Ensemus for places that render it. A plain link is not
 * matched: it waits for a person, who can see where it goes. Every repeat is bounded, so this stays linear.
 */
const FETCHES_ON_DISPLAY: readonly RegExp[] = [
  // ![alt](https://host/...) or ![alt](//host/...). A relative address stays on the reader's own site.
  /!\[[^\]\n]{0,2000}\]\(\s{0,8}<?\s{0,8}(?:[a-z][a-z0-9+.-]{0,20}:)?\/\//i,
  // ![alt][ref], whose address is defined somewhere else in the text.
  /!\[[^\]\n]{0,2000}\]\[[^\]\n]{0,200}\]/,
  /<\s{0,8}(?:img|image|iframe|frame|script|link|object|embed|video|audio|source|track|style)\b/i,
];

const fetchesOnDisplay = (text: string) => FETCHES_ON_DISPLAY.some((pattern) => pattern.test(text));

export function checkOutput(
  result: Exclude<AdapterResult, { kind: 'failure' }>,
  tools: readonly AdapterTool[],
  schema: OutputSchema,
  canaries: readonly string[],
): OutputCheck {
  if (result.kind === 'tool_call') {
    // A tool the model made up, or one it read about in a document. Anything else is the tool gateway's.
    if (!tools.some((tool) => tool.id === result.toolId)) {
      return { ok: false, decisionCode: 'TOOL_UNKNOWN' };
    }
    let args: string | undefined;
    try {
      args = JSON.stringify(result.args);
    } catch {
      return INVALID;
    }
    if (args !== undefined && holdsSecret(args, canaries)) {
      return { ok: false, decisionCode: 'SECRET_FOUND_IN_PAYLOAD' };
    }
    // Arguments become a message, a document or a draft somewhere that may render them.
    if (args !== undefined && fetchesOnDisplay(args)) return INVALID;
    return { ok: true };
  }

  if (typeof result.text !== 'string') return INVALID;
  if (result.text.trim().length === 0) return misshapen('empty_output');
  if (holdsSecret(result.text, canaries)) {
    return { ok: false, decisionCode: 'SECRET_FOUND_IN_PAYLOAD' };
  }
  if (fetchesOnDisplay(result.text)) return INVALID;
  if (schema) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return misshapen('output_not_json');
    }
    if (!schema.validate(parsed)) return misshapen('output_schema_mismatch');
  }
  return { ok: true };
}
