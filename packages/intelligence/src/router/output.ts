// What a model returned is untrusted (FD-8). This decides only whether it is well formed and clean enough to
// hand on. Whether a proposed tool call may run is the tool gateway's decision, against its own grants. A
// validator's errors can quote the data, so a failure here is a code and nothing else.
import type { AiReasonCode } from '@ensemus/domain/ai';
import { scanForSecrets } from '@ensemus/policy';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AdapterResult, AdapterTool } from '../types';

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

export type OutputCheck = { ok: true } | { ok: false; decisionCode: AiReasonCode | null };

const INVALID: OutputCheck = { ok: false, decisionCode: null };

function holdsSecret(text: string, canaries: readonly string[]): boolean {
  return scanForSecrets([{ id: 'output', text }], canaries).hits.length > 0;
}

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
    return { ok: true };
  }

  if (typeof result.text !== 'string' || result.text.trim().length === 0) return INVALID;
  if (holdsSecret(result.text, canaries)) {
    return { ok: false, decisionCode: 'SECRET_FOUND_IN_PAYLOAD' };
  }
  if (schema) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return INVALID;
    }
    if (!schema.validate(parsed)) return INVALID;
  }
  return { ok: true };
}
