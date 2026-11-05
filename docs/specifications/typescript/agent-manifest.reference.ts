/** Illustrative Zod-like manifest shape; actual schema in JSON Schema example. */
export type AgentManifest = {
  id: string; version: number;
  objective: string;
  model: { capability: string; quality: 'economy'|'balanced'|'high' };
  allowedKnowledgeScopes: string[];
  skillVersions: { id: string; version: number }[];
  toolGrants: string[];
  maxModelTurns: number;
  maxToolCalls: number;
  maxCostUsd: number;
  timeoutSeconds: number;
  outputSchemaId: string;
};
// Validation, immutable publish version, tenant-owned grants and policy engine
// always sit outside user-editable descriptions/prompts.
