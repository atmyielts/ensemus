/** Reference contracts only — not compiled into an application. */
export type Classification = 'public' | 'internal' | 'confidential' | 'restricted';
export type CommercialMode = 'cloud' | 'byom' | 'sovereign';
export type ActorContext = {
  tenantId: string;
  actorId: string;
  serviceIdentityId?: string;
  delegationId?: string;
  aclVersion: number;
  traceId: string;
};
export type WorkUnitState = 'queued' | 'ready' | 'running' | 'blocked' | 'awaiting_approval' |
  'verifying' | 'completed' | 'failed' | 'cancelled';
export type AuthorizedToolProposal = {
  toolId: string;
  schemaVersion: number;
  payloadHash: string;
  input: unknown;
  classification: Classification;
  idempotencyKey: string;
};
export interface WorkRepository {
  transition(ctx: ActorContext, id: string, expectedVersion: number,
    next: WorkUnitState): Promise<{id: string; version: number}>;
}
export interface PolicyPort {
  authorizeAction(ctx: ActorContext, proposal: AuthorizedToolProposal): Promise<{
    permitted: boolean; reasonCode: string; approvalRequired: boolean;
  }>;
}
export interface InferencePort {
  generate(ctx: ActorContext, task: {
    capability: string; classification: Classification;
    allowedProfiles: string[]; maxCostUsd: number;
  }, messages: unknown): Promise<{ output: unknown; receiptId: string }>;
}
export interface ContextCompilerPort {
  compile(ctx: ActorContext, purpose: string, sourceIds: string[]): Promise<{
    evidence: {sourceId:string; content:string; classification:Classification}[];
    aclVersion: number;
  }>;
}
// Application services receive these ports by dependency injection. No Next imports.
