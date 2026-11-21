// Owned by the meetings-derivation slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D6. A person
// asks, the worker rechecks everything right before the provider sees anything, and what comes back is stored
// as a model's guess, or thrown away if someone said no in the meantime.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { DerivationPurpose, DerivationStatus, MeetingStopCode } from '@ensemus/domain/meeting';
import type { Classification } from '@ensemus/domain/policy';
import type { MeetingModelAnswer } from './expansion-ports';

export type DerivationRunView = {
  id: string;
  meetingId: string;
  purpose: DerivationPurpose;
  status: DerivationStatus;
  statusCode: MeetingStopCode | null;
  requestedByMembershipId: string;
  createdAt: Date;
  finishedAt: Date | null;
};

/**
 * The organizer asks for one version of the notes to go to one approved provider for one purpose. Emits
 * MEETING_DERIVATION_REQUESTED. CONSENT_INCOMPLETE and PROVIDER_NOT_APPROVED are refusals here as well as in
 * the trigger, so a person hears the reason. A service context is refused, so nothing runs by itself.
 */
export function requestMeetingDerivation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { meetingId: string; purpose: DerivationPurpose; providerApprovalId: string },
): Promise<DerivationRunView> {
  throw new Error('NOT_IMPLEMENTED');
}

export function listMeetingDerivations(
  _database: AppDatabase,
  _context: TenantContext,
  _meetingId: string,
): Promise<readonly DerivationRunView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Everything a provider call takes. Lives only in the worker's memory and never crosses Temporal. */
export type PreparedDerivation = {
  runId: string;
  meetingId: string;
  purpose: DerivationPurpose;
  classification: Classification;
  modelProfileId: string;
  notes: string;
  notesSha256: string;
  /** Members by position, as the model is told to refer to them. Outsiders hold a place and no ID. */
  participants: readonly (string | null)[];
};

export type BeginDerivation =
  | { kind: 'go'; prepared: PreparedDerivation }
  /** Already finished, by an earlier try of this Activity. Nothing to do and nothing to contact. */
  | { kind: 'done'; status: DerivationStatus }
  | { kind: 'stopped'; code: MeetingStopCode };

/**
 * Service context. Under the meeting's lock, runs checkBeforeDerivation and moves the run to `running`, and if
 * anything has changed, moves it to `refused` with the code instead. This is the last thing before notes leave.
 */
export function beginMeetingDerivation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { derivationRunId: string; temporalRunId: string },
): Promise<BeginDerivation> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Service context. Parses the output against @ensemus/contracts/meetings and stores it, or refuses the run with
 * MODEL_OUTPUT_INVALID. Items start `proposed`, and tell the organizer and participants. If the run is no
 * longer `running`, because consent went while the model was thinking, the answer is dropped and this returns
 * `dropped`. Nothing is kept of it.
 */
export function finishMeetingDerivation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { derivationRunId: string; answer: MeetingModelAnswer },
): Promise<{ status: DerivationStatus | 'dropped'; items: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function stopMeetingDerivation(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { derivationRunId: string; code: MeetingStopCode; to: 'failed' | 'refused' },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
