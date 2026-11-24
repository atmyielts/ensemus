// Ports for M11A (ADR-033 D8). M4 and M5 own what sits behind these and are not on this branch, so each port names
// exactly what this needs, and the final merge implements it over their code. Until then nothing behind a port
// pretends: the shipped default for each is to refuse, and fakes live with the tests.
import type { Classification } from '@ensemus/domain/policy';
import type { DerivationPurpose } from '@ensemus/domain/meeting';

/**
 * The egress decision (docs/04-security/02-secrets-and-egress.md §4), checked before notes reach a model. The final
 * merge implements it over M4's `decideEgress` and its `governance.egress_decisions` log, for the one model profile
 * the approval names, as M5's `KnowledgeModelPort.route` does for knowledge. A deny contacts nobody and unseals
 * nothing. Without a real gate, nothing leaves.
 */
export type MeetingEgressRequest = {
  organizationId: string;
  purpose: DerivationPurpose;
  classification: Classification;
  /** The model profile the approval names, from M4's `ProfileStore`. */
  modelProfileId: string;
};

export type MeetingEgressDecision =
  { allowed: true; auditRef: string } | { allowed: false; code: 'EGRESS_DENIED' };

export interface MeetingEgressGate {
  decide(request: MeetingEgressRequest): Promise<MeetingEgressDecision>;
}

/** What ships until M4's gate is plugged in. Say no to everything, so a missing wire fails closed. */
export const denyAllMeetingEgress: MeetingEgressGate = {
  decide: async () => ({ allowed: false, code: 'EGRESS_DENIED' }),
};

/**
 * The governed model call. The final merge implements it over M4's router and adapters, as M5's
 * `KnowledgeModelPort.answer` does, with the instructions in M4's `policy` role and the notes in `evidence`, so a
 * note cannot speak as the system. What comes back is parsed against @ensemus/contracts/meetings before anything
 * reads it. The participants are given by position only, with no names, so the model never handles an ID.
 */
export type MeetingModelRequest = {
  organizationId: string;
  runId: string;
  temporalRunId: string;
  notesSha256: string;
  purpose: DerivationPurpose;
  modelProfileId: string;
  classification: Classification;
  notes: string;
  participantCount: number;
  signal: AbortSignal;
};

export type MeetingModelAnswer = {
  /** Which deployment answered. An ID, for the egress record. */
  modelRef: string;
  inputTokens: number;
  outputTokens: number;
  /** Unparsed. The caller parses it, and refuses the run if it does not fit. */
  output: unknown;
};

/** Thrown with a fixed code. A model's own words are never in it. */
export class MeetingModelUnavailable extends Error {
  override name = 'MeetingModelUnavailable';
  constructor(readonly code: 'MODEL_UNAVAILABLE' | 'MODEL_TIMEOUT') {
    super(code);
  }
}

/** A fresh check stopped processing before any provider call. */
export class MeetingModelRefused extends Error {
  override name = 'MeetingModelRefused';
  constructor(readonly code: import('@ensemus/domain/meeting').MeetingStopCode) {
    super(code);
  }
}

export interface MeetingModelGateway {
  derive(request: MeetingModelRequest): Promise<MeetingModelAnswer>;
}

/** What ships until M4's gateway is plugged in. A run ends MODEL_UNAVAILABLE, and says so on the page. */
export const noMeetingModel: MeetingModelGateway = {
  derive: async () => {
    throw new MeetingModelUnavailable('MODEL_UNAVAILABLE');
  },
};

/**
 * M5's knowledge pipeline (KNOW-01). Notes join retrieval through this only after consent, and leave it when consent
 * goes. The final merge implements it over M5's sources: `addNotes` registers the notes as a source of its own, and
 * `removeMeeting` is `deleteSource`, whose purge takes away chunks, embeddings, facts and answers (ADR-029 D3).
 */
export interface MeetingKnowledgeIndex {
  addNotes(input: {
    organizationId: string;
    meetingId: string;
    notesId: string;
    classification: Classification;
  }): Promise<void>;
  removeMeeting(input: { organizationId: string; meetingId: string }): Promise<void>;
}

/** What ships until M5 is plugged in: notes are not indexed, which is true, and removal has nothing to do. */
export const noMeetingKnowledgeIndex: MeetingKnowledgeIndex = {
  addNotes: async () => undefined,
  removeMeeting: async () => undefined,
};
