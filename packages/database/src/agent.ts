// For agent-worker only (lint blocks this from the web tier, the base worker's code and everything else).
// This role adds to `ensemus_app` the right to read and write prompts, usage and egress decisions, and
// the sealing key lives in the same process. Nothing that runs anywhere else can open this connection.
import { openAppDatabase } from './tenant';

export { createAgentContext, withRunLookupTx, type AgentContext } from './tenant';

/** One connection role for the whole process. A model call must never hold one of these open. */
export function openAgentDatabase(url: string, options: { max?: number } = {}) {
  return openAppDatabase(url, options);
}
