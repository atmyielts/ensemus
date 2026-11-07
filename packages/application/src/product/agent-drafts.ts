// Owned by the studio slice (AGENT-08). See docs/06-delivery/m7-slices.md and ADR-031 D5, D6.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { AgentDraftAnswers, DraftAssessment } from '@ensemus/domain/agent-draft';
import type { ProductPorts } from './ports';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type AgentDraftView = {
  id: string;
  name: string;
  ownerMembershipId: string;
  agentDefinitionId: string | null;
  answers: AgentDraftAnswers;
  specSha256: string | null;
  status: 'editing' | 'in_review' | 'published' | 'archived';
  fromPackInstallationId: string | null;
  version: number;
  updatedAt: Date;
};

/** Needs `studio.author`. A draft can act on nothing, so writing one takes no MFA. */
export async function createAgentDraft(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'toolCatalog' | 'agentRegistry'>,
  _input: { name: string; answers: AgentDraftAnswers; agentDefinitionId?: string },
): Promise<AgentDraftView> {
  throw NOT_BUILT();
}

/** For a pack, in its transaction. Same checks, and the row records which installation made it. */
export async function createAgentDraftInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: { name: string; answers: AgentDraftAnswers; fromPackInstallationId: string },
): Promise<{ id: string }> {
  throw NOT_BUILT();
}

export async function listAgentDrafts(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { status?: AgentDraftView['status'] } = {},
): Promise<readonly AgentDraftView[]> {
  throw NOT_BUILT();
}

export async function getAgentDraft(
  _database: AppDatabase,
  _context: TenantContext,
  _draftId: string,
): Promise<AgentDraftView> {
  throw NOT_BUILT();
}

/** Any change clears the hash's standing: earlier simulations and reviews bind the old hash and lapse. */
export async function updateAgentDraft(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'toolCatalog' | 'agentRegistry'>,
  _input: { draftId: string; expectedVersion: number; name?: string; answers?: AgentDraftAnswers },
): Promise<AgentDraftView> {
  throw NOT_BUILT();
}

export async function archiveAgentDraft(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { draftId: string; expectedVersion: number },
): Promise<void> {
  throw NOT_BUILT();
}

/** The issues and the risk list for the page, without saving anything. */
export async function assessAgentDraft(
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'toolCatalog' | 'agentRegistry'>,
  _answers: AgentDraftAnswers,
): Promise<DraftAssessment> {
  throw NOT_BUILT();
}
