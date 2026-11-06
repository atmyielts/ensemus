// Owned by the graph slice (AGENT-09). See docs/06-delivery/m7-slices.md and ADR-031 D7.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { GraphIssue, ProcessGraph, ProcessSpec } from '@ensemus/domain/process-spec';
import type { ProductPorts } from './ports';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type ProcessDraftView = {
  id: string;
  name: string;
  ownerMembershipId: string;
  classification: ProcessSpec['classification'];
  graph: ProcessGraph;
  specSha256: string | null;
  issues: readonly GraphIssue[];
  status: 'editing' | 'in_review' | 'published' | 'archived';
  version: number;
  updatedAt: Date;
};

export type ProcessSpecView = {
  id: string;
  processKey: string;
  versionNumber: number;
  name: string;
  classification: ProcessSpec['classification'];
  spec: ProcessSpec;
  specSha256: string;
  source: 'graph' | 'bundled' | 'pack';
  sourceRef: string | null;
  publishedAt: Date;
};

/** Needs `studio.author`. */
export async function createProcessDraft(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { name: string; classification: ProcessSpec['classification'] },
): Promise<ProcessDraftView> {
  throw NOT_BUILT();
}

/** For a pack, in its transaction. */
export async function createProcessDraftInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: {
    name: string;
    classification: ProcessSpec['classification'];
    graph: ProcessGraph;
  },
): Promise<{ id: string }> {
  throw NOT_BUILT();
}

export async function listProcessDrafts(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly ProcessDraftView[]> {
  throw NOT_BUILT();
}

export async function getProcessDraft(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'toolCatalog' | 'agentRegistry'>,
  _draftId: string,
): Promise<ProcessDraftView> {
  throw NOT_BUILT();
}

/** Saves the graph and recompiles it. A graph that does not compile saves, with no hash and its issues. */
export async function updateProcessDraft(
  _database: AppDatabase,
  _context: TenantContext,
  _ports: Pick<ProductPorts, 'toolCatalog' | 'agentRegistry'>,
  _input: {
    draftId: string;
    expectedVersion: number;
    name?: string;
    classification?: ProcessSpec['classification'];
    graph?: ProcessGraph;
  },
): Promise<ProcessDraftView> {
  throw NOT_BUILT();
}

/** Called by `publishApproved`, in its transaction, with a draft whose hash it has already checked. */
export async function publishProcessSpecInTx(
  _tx: Tx,
  _context: TenantContext,
  _input: {
    processKey: string;
    name: string;
    classification: ProcessSpec['classification'];
    spec: ProcessSpec;
    specSha256: string;
    source: 'graph' | 'bundled' | 'pack';
    sourceRef?: string;
  },
): Promise<{ specId: string; versionNumber: number }> {
  throw NOT_BUILT();
}

export async function listProcessSpecs(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly ProcessSpecView[]> {
  throw NOT_BUILT();
}

export async function getProcessSpec(
  _database: AppDatabase,
  _context: TenantContext,
  _specId: string,
): Promise<ProcessSpecView> {
  throw NOT_BUILT();
}
