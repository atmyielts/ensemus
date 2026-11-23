// Hashes only: the trusted gateway calls this after adapter/output validation. Never persist a body.
import { createHash } from 'node:crypto';
import type { AdapterResult, ContextMessage } from './types';

const citationPartId =
  /^knowledge:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(S([1-9][0-9]{0,3}))$/;

/** The compiler assigns these part IDs. Only messages in the final outbound list count. */
export function presentedKnowledgeOf(messages: readonly ContextMessage[]) {
  let packageId: string | undefined;
  const ordinals = new Set<number>();
  for (const message of messages) {
    if (message.role !== 'evidence') continue;
    const match = citationPartId.exec(message.partId);
    if (!match || !message.text.startsWith(`[${match[2]}]\n`)) continue;
    if (packageId !== undefined && packageId !== match[1]) return undefined;
    packageId = match[1];
    ordinals.add(Number(match[3]));
  }
  return packageId ? { packageId, ordinals: [...ordinals].sort((a, b) => a - b) } : undefined;
}

export function mainResultHash(result: Exclude<AdapterResult, { kind: 'failure' }>) {
  const content = result.kind === 'tool_call' ? JSON.stringify(result.args ?? null) : result.text;
  if (typeof content !== 'string') throw new Error('MODEL_RESULT_INVALID');
  return {
    kind: result.kind,
    toolId: result.kind === 'tool_call' ? result.toolId : null,
    payloadHash: createHash('sha256').update(content).digest('hex'),
  };
}
