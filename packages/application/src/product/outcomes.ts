// Owned by the composer-onboarding slice (UX-20). See docs/06-delivery/m7-slices.md and ADR-031 D5.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { OutcomePreview } from '@ensemus/domain/outcome-composer';

const NOT_BUILT = () => new Error('NOT_IMPLEMENTED');

export type OutcomeDraftView = {
  id: string;
  objective: string;
  preview: OutcomePreview;
  previewSha256: string;
  status: 'draft' | 'authorized' | 'discarded';
  workUnitId: string | null;
  version: number;
  updatedAt: Date;
};

/** Needs `work.create`. Reads the sentence and stores the preview. It starts nothing and emits nothing. */
export async function composeOutcome(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { objective: string; today: string },
): Promise<OutcomeDraftView> {
  throw NOT_BUILT();
}

/** Only its author. Anyone else gets not found. */
export async function getOutcomeDraft(
  _database: AppDatabase,
  _context: TenantContext,
  _draftId: string,
): Promise<OutcomeDraftView> {
  throw NOT_BUILT();
}

export async function listMyOutcomeDrafts(
  _database: AppDatabase,
  _context: TenantContext,
): Promise<readonly OutcomeDraftView[]> {
  throw NOT_BUILT();
}

/** A person's corrections to the preview. A changed preview means a new hash. */
export async function reviseOutcomeDraft(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { draftId: string; expectedVersion: number; preview: OutcomePreview },
): Promise<OutcomeDraftView> {
  throw NOT_BUILT();
}

/**
 * The only way anything happens. Takes the hash the person was looking at, and refuses if the preview has
 * changed since. Makes one Work Unit through the normal path, with its checks, and runs nothing: starting
 * an agent or a process is a separate decision on the Work Unit's own page.
 */
export async function authorizeOutcome(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { draftId: string; expectedVersion: number; previewSha256: string },
): Promise<{ workUnitId: string }> {
  throw NOT_BUILT();
}

export async function discardOutcome(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { draftId: string; expectedVersion: number },
): Promise<void> {
  throw NOT_BUILT();
}
