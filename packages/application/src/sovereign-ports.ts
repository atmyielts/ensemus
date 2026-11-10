// Ports for the archive and for restoring (ADR-030). Later milestones own tables this one has to carry:
// agents and skills (M4), knowledge and its derivatives (M5), custom objects (M7). Each implements these at
// the final merge, and adds itself to the list in workers/workflow/src/portability-sections.ts. Until then a
// section with no implementation exports nothing, and says so in the manifest, instead of being guessed at.
import type { AppDatabase, TenantContext, Tx } from '@ensemus/database';
import type { ExportSection, ImportWarningCode } from '@ensemus/domain/portability';

/** What a section hands over for one page. `recordKind` names the part: `work_units-000001.jsonl`. */
export type ExportPage = {
  recordKind: string;
  /** Each becomes one line of JSON. A section must leave out credentials and derived data. */
  records: readonly unknown[];
  /** Where to carry on, kept in PostgreSQL by the caller. Null when this section has finished. */
  nextCursor: string | null;
  /** Records it left out on purpose, by kind. These reach the manifest, so nothing is silently absent. */
  excluded?: Readonly<Record<string, number>>;
  /** Original upload bytes only. The orchestrator reads/seals outside the tenant transaction,
   * then asks the section to recheck current read authority before recording either part. */
  originals?: readonly {
    documentId: string;
    objectKey: string;
    sha256: string;
    sizeBytes: number;
  }[];
};

export type ImportScope = {
  importId: string;
  /** Exact verified manifest profile, never inferred from a record kind or missing declaration. */
  inventoryVersion?: string;
  /** Immutable verified part selector supplied by the actual archive runner. */
  sourcePart?: { path: string; sha256: string };
  /** The membership here that stands for someone at the source. Their own once linked, or the fallback. */
  membershipFor(sourceMembershipId: string): string;
  /** Whether the source had deleted this. A section checks this before writing anything back. */
  isTombstoned(targetType: string, targetId: string): boolean;
};

export type ImportedPage = {
  applied: number;
  warnings?: Partial<Record<ImportWarningCode, number>>;
};

/**
 * One section of the archive, implemented by whoever owns its tables. A page runs in one short tenant
 * transaction, and row-level security still holds. `importPage` treats its records as hostile: it validates
 * each one, and whatever a record says, an import starts nothing and leaves nothing pending.
 */
export interface PortabilitySection {
  readonly section: ExportSection;
  confirmOriginals?(
    tx: Tx,
    context: TenantContext,
    documentIds: readonly string[],
  ): Promise<boolean>;
  exportPage(
    tx: Tx,
    context: TenantContext,
    input: { cursor: string | null; limit: number },
  ): Promise<ExportPage>;
  importPage(
    tx: Tx,
    context: TenantContext,
    scope: ImportScope,
    input: { recordKind: string; records: readonly unknown[] },
  ): Promise<ImportedPage>;
}

/** What one owner of derived or running state did after a restore or an import. Counts and codes only. */
export type RestoreRunInputCounts = {
  runs: number;
  checkpoints: number;
  observations: number;
  missingCheckpoints: number;
  legacyHistoryUnknown: number;
  unfencedTerminalRuns: number;
  uncertifiedFences: number;
  certifiedFences: number;
  unsupportedProtocols: number;
};
export type RestoreOutputWriteCounts = {
  writes: number;
  unsettledWrites: number;
  mismatchedTokens: number;
};

/** Only the actual agent-role adapter may supply this after it checked the named tenant's runs,
 * fenced current generations and queried private remaining rows. This is never inferred from metadata.
 *0214 accepts generation1 only; a new generation/protocol requires an explicit adapter update. */
export type RestoreTranscriptProof = {
  protocol: 'ai.run_inputs/v1';
  fenceGeneration: 1;
  checkedRuns: number;
  certifiedRuns: number;
  remainingPayloads: number;
};
export type ContributorReport = {
  name: string;
  checked: number;
  changed: number;
  /** Things a person has to look at. Above zero, the restore command exits non-zero. */
  needsAttention: number;
  runInputs?: RestoreRunInputCounts;
  outputWrites?: RestoreOutputWriteCounts;
};

/**
 * Something that has to catch up after a restore: agent runs and budgets (M4), search chunks and embeddings
 * rebuilt with fresh ACLs (M5). Called once per tenant, safe to repeat, and never touches a provider.
 */
export interface RestoreContributor {
  readonly name: string;
  reconcile(database: AppDatabase, context: TenantContext): Promise<ContributorReport>;
}

/**
 * Asks whether a workflow run is still open. The worker implements this, because the application has no
 * Temporal client (ADR-024 D3). Not knowing is `unknown`, which is reported and never treated as closed.
 */
export type RunProbe = (input: {
  organizationId: string;
  workUnitId: string;
  runId: string;
}) => Promise<'open' | 'closed' | 'unknown'>;
