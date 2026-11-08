// Hashes only: the trusted gateway calls this after adapter/output validation. Never persist a body.
import { createHash } from 'node:crypto';
import type { AdapterResult } from './types';

export function mainResultHash(result: Exclude<AdapterResult, { kind: 'failure' }>) {
  const content = result.kind === 'tool_call' ? JSON.stringify(result.args ?? null) : result.text;
  if (typeof content !== 'string') throw new Error('MODEL_RESULT_INVALID');
  return {
    kind: result.kind,
    toolId: result.kind === 'tool_call' ? result.toolId : null,
    payloadHash: createHash('sha256').update(content).digest('hex'),
  };
}
