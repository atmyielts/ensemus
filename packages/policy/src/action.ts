// What a tool may do, independent of any model (SEC-01). Deny wins over require_approval, which wins over
// allow. The manifest in code decides whether a tool exists and whether it asks a person, so nothing an agent's
// spec says or a caller passes can turn an approval off. A grant is an exact name: no wildcard can widen one.
import { CLASSIFICATIONS, type AiClassification, type AiReasonCode } from '@ensemus/domain/ai';
import { FORBIDDEN_TOOL_PREFIXES, toolManifest } from '@ensemus/domain/ai-tools';
import type { ActionDecision, ActionInput } from './types';

const deny = (reasonCode: AiReasonCode): ActionDecision => ({ decision: 'deny', reasonCode });

function isKnown(input: ActionInput): boolean {
  if (typeof input !== 'object' || input === null) return false;
  if (typeof input.toolId !== 'string' || input.toolId.length === 0) return false;
  if (!CLASSIFICATIONS.includes(input.dataClass as AiClassification)) return false;
  if (typeof input.destructive !== 'boolean' || typeof input.requiresApproval !== 'boolean') {
    return false;
  }
  return [input.allow, input.deny, input.delegated].every((list) => Array.isArray(list));
}

export function decideAction(input: ActionInput): ActionDecision {
  if (!isKnown(input)) return deny('UNKNOWN_INPUT');

  // Refusals first, in the order that names the most useful reason.
  if (FORBIDDEN_TOOL_PREFIXES.some((prefix) => input.toolId.startsWith(prefix))) {
    return deny('TOOL_UNKNOWN');
  }
  if (input.deny.includes(input.toolId)) return deny('TOOL_DENIED_BY_SPEC');
  if (input.destructive) return deny('DESTRUCTIVE_DENIED');

  const manifest = toolManifest(input.toolId);
  if (!manifest || input.toolClass === null) return deny('TOOL_UNKNOWN');
  // The caller read this from somewhere. If it disagrees with the code, one of them is wrong.
  if (input.toolClass !== manifest.class) return deny('UNKNOWN_INPUT');

  // A tool has to be on both lists: the version's grants, and the scopes this run was given.
  if (!input.allow.includes(input.toolId) || !input.delegated.includes(input.toolId)) {
    return deny('TOOL_NOT_GRANTED');
  }

  // The outside-provider rule of the egress matrix, applied to the one tool class that sends data out.
  if (manifest.class === 'external_write' && input.dataClass === 'restricted') {
    return deny('CLASS_DENIED');
  }

  if (manifest.requiresApproval || input.requiresApproval || manifest.class === 'external_write') {
    return { decision: 'require_approval', reasonCode: 'APPROVAL_REQUIRED' };
  }
  return { decision: 'allow', reasonCode: 'ALLOWED' };
}
