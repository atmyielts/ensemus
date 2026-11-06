// Ports for M11A (ADR-033). Other milestones own what sits behind these and are being written at the same time,
// so each one names exactly what this needs and the final merge plugs the real thing in. Until then, nothing
// behind a port pretends: the shipped default for each is to refuse, and fakes live with the tests.
import type { Classification } from '@ensemus/domain/policy';
import type { DerivationPurpose } from '@ensemus/domain/meeting';
import type {
  DepartmentPack,
  PackFinding,
} from '@ensemus/domain/department-pack';

/**
 * M4's egress decision (docs/04-security/02-secrets-and-egress.md §4), checked before notes reach a model.
 * This port is the deny-by-default half of it: without a real gate, nothing leaves.
 */
export type MeetingEgressRequest = {
  organizationId: string;
  purpose: DerivationPurpose;
  classification: Classification;
  /** The model profile the approval names. */
  modelProfileId: string;
};

export type MeetingEgressDecision =
  | { allowed: true; auditRef: string }
  | { allowed: false; code: 'EGRESS_DENIED' };

export interface MeetingEgressGate {
  decide(request: MeetingEgressRequest): Promise<MeetingEgressDecision>;
}

/** What ships until M4's gate is plugged in. Say no to everything, so a missing wire fails closed. */
export const denyAllMeetingEgress: MeetingEgressGate = {
  decide: async () => ({ allowed: false, code: 'EGRESS_DENIED' }),
};

/**
 * M4's governed model call. The notes go in as data, inside whatever separation M4 gives untrusted text, and
 * what comes back is parsed against @ensemus/contracts/meetings before anything reads it. The participants
 * are given by position only, and with no names, so the model never handles an ID.
 */
export type MeetingModelRequest = {
  organizationId: string;
  runId: string;
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
 * M5's knowledge pipeline (KNOW-01). Notes join retrieval through this only after consent, and leave it when
 * consent goes. `removeMeeting` must take away every chunk, embedding, cache and summary it holds for that
 * meeting, as the deletion sequence requires.
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

/**
 * AGENT-14's pack format, from M7. M11A's packs are written against @ensemus/domain/department-pack, which is
 * the catalog's pack format as data, and this is how they reach the real installer. The final merge
 * implements it with an adapter in M7's terms. If M7's rules go further, a pack has to pass both.
 */
export interface DepartmentPackFormat {
  /** M7's own review rules, on top of checkDepartmentPack. */
  review(pack: DepartmentPack): Promise<readonly PackFinding[]>;
  /** M7's upgrade and rollback rules, on top of checkPackUpgrade. */
  reviewUpgrade(from: DepartmentPack, to: DepartmentPack): Promise<readonly PackFinding[]>;
}
