// Owned by the meetings-derivation slice (EXP-03). See docs/06-delivery/m11a-slices.md and ADR-033 D6. Only IDs and
// enums go in or out: the notes stay in PostgreSQL and in this worker's memory, and a model's words stop here.
import type { MeetingEgressGate, MeetingModelGateway } from '@ensemus/application';
import type { AppDatabase } from '@ensemus/database';
import type { MeetingDerivationInput, MeetingDerivationOutcome } from './schemas';

export type MeetingDerivationDeps = {
  database: AppDatabase;
  /** M4's model call. `noMeetingModel` until that lands, so a run ends MODEL_UNAVAILABLE and says so. */
  model: MeetingModelGateway;
  /** M4's egress decision. `denyAllMeetingEgress` until that lands, so nothing leaves. */
  egress: MeetingEgressGate;
};

export function createMeetingDerivationActivities(_deps: MeetingDerivationDeps) {
  return {
    /** Rechecks, asks the gate, calls the model once and stores what it said, all in this one Activity. */
    async runMeetingDerivation(_input: MeetingDerivationInput): Promise<MeetingDerivationOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
    /** Ends a run whose Activity never finished, so a person is told. Safe to retry. */
    async stopInterruptedDerivation(
      _input: MeetingDerivationInput,
    ): Promise<MeetingDerivationOutcome> {
      throw new Error('NOT_IMPLEMENTED');
    },
  };
}
export type MeetingDerivationActivities = ReturnType<typeof createMeetingDerivationActivities>;
