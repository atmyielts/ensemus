// Doubles for every port the router and the gateway use, shared by their two test files. Nothing outside a test
// imports this. Every double writes to one log, so a test can assert the exact order things happened in.
import type {
  AgentContext,
  EgressLog,
  EgressRecord,
  Entitlements,
  EntitlementResult,
  HaltCheck,
  Headroom,
  LedgerEntry,
  ProfileStore,
  RateCardRef,
  Reservation,
  ReservationRequest,
  RoutableProfile,
  TurnStore,
  Tx,
  UsageLedger,
} from '@ensemus/application/ai-ports';
import { randomBytes } from 'node:crypto';
import { RecordingLender } from '../testing/recording-lender';
import { ScriptedModelAdapter, type ScriptStep } from '../testing/scripted-adapter';
import type {
  AdapterCall,
  AdapterResult,
  CompiledTurn,
  ContextMessage,
  EndpointGuard,
  InferenceTask,
  ProfileKeyRef,
  StepRef,
  VerifiedEndpoint,
} from '../types';

export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const agentContext = (organizationId = ORG_A, runId = RUN_ID) =>
  ({
    organizationId,
    userId: 'user-1',
    membershipId: 'membership-1',
    role: 'owner',
    actorType: 'agent',
    agentRunId: runId,
  }) as unknown as AgentContext;

export const step: StepRef = {
  runId: RUN_ID,
  stepId: 'step-1',
  stepNumber: 3,
  attempt: 1,
  workUnitId: 'work-1',
  agentVersionId: 'version-1',
};

/** The customer's own model, behind an outside API, approved for what a default profile takes. */
export const byomProfile = (overrides: Partial<RoutableProfile> = {}): RoutableProfile => ({
  id: 'byom',
  version: 1,
  providerKind: 'openai_compatible',
  modelId: 'test-model',
  alias: 'a-byom',
  endpointUrl: 'https://byom.example.invalid/v1',
  secretRef: 'secret-byom',
  billingOwner: 'customer',
  destination: 'customer_byom_public_api',
  region: 'eu',
  capabilities: ['text', 'tools', 'structured_output'],
  limits: { maxInputTokens: 4096, maxOutputTokens: 512 },
  allowedClasses: ['public', 'internal'],
  allowedPurposes: ['reason', 'compose'],
  retentionBasis: 'contract_recorded',
  contractRef: 'contract-record-1',
  fallbackProfileIds: [],
  crossBillingApproved: false,
  status: 'active',
  ...overrides,
});

/** A model on Ensemus's bill. */
export const managedProfile = (overrides: Partial<RoutableProfile> = {}): RoutableProfile =>
  byomProfile({
    id: 'managed',
    alias: 'z-managed',
    endpointUrl: 'https://managed.example.invalid/v1',
    secretRef: 'secret-managed',
    billingOwner: 'ensemus',
    destination: 'ensemus_cloud_managed_model',
    ...overrides,
  });

/** A model the customer runs themselves, with no key. */
export const localProfile = (overrides: Partial<RoutableProfile> = {}): RoutableProfile =>
  byomProfile({
    id: 'local',
    alias: 'm-local',
    providerKind: 'local_openai_compatible',
    endpointUrl: 'http://model.example.invalid:8000/v1',
    secretRef: null,
    destination: 'customer_private_inference',
    retentionBasis: 'self_hosted',
    contractRef: null,
    ...overrides,
  });

/** A rate made up for the test. It is the test's own figure: there are no prices in this codebase. */
export const rateCard = (
  profileId: string,
  rates = { inputMicrosPerMtok: 1_000_000, outputMicrosPerMtok: 2_000_000 },
): RateCardRef => ({ id: `rate-${profileId}`, version: 1, source: 'tenant_estimate', ...rates });

export const task = (overrides: Partial<InferenceTask> = {}): InferenceTask => ({
  runId: RUN_ID,
  purpose: 'reason',
  quality: 'balanced',
  required: ['text'],
  classification: 'public',
  requiredRegion: null,
  allowFallback: true,
  pinned: null,
  ...overrides,
});

export const message = (overrides: Partial<ContextMessage> = {}): ContextMessage => ({
  role: 'task',
  partId: 'part-1',
  text: 'Summarise the work.',
  classification: 'public',
  ...overrides,
});

export const REQUEST_HASH = 'a'.repeat(64);

export const compiled = (overrides: Partial<CompiledTurn> = {}): CompiledTurn => ({
  messages: [message()],
  tools: [],
  responseSchema: null,
  task: task(),
  requestHash: REQUEST_HASH,
  maxOutputTokens: 200,
  timeoutMs: 1_000,
  ...overrides,
});

export class FakeProfileStore implements ProfileStore {
  readonly #log: string[];
  /** Per tenant, as RLS would have it. A profile of another tenant is simply not there. */
  readonly byOrg = new Map<string, RoutableProfile[]>();
  readonly rates = new Map<string, RateCardRef>();

  constructor(log: string[], profiles: readonly RoutableProfile[], organizationId = ORG_A) {
    this.#log = log;
    this.set(profiles, organizationId);
  }

  set(profiles: readonly RoutableProfile[], organizationId = ORG_A) {
    this.byOrg.set(organizationId, [...profiles]);
    for (const profile of profiles) {
      if (!this.rates.has(profile.id)) this.rates.set(profile.id, rateCard(profile.id));
    }
  }

  async listCandidates(context: AgentContext) {
    this.#log.push('profiles.listCandidates');
    return this.byOrg.get(context.organizationId) ?? [];
  }

  async getProfile(context: AgentContext, profileId: string) {
    this.#log.push('profiles.getProfile');
    return (this.byOrg.get(context.organizationId) ?? []).find((p) => p.id === profileId) ?? null;
  }

  async latestRateCard(context: AgentContext, profileId: string) {
    this.#log.push('profiles.latestRateCard');
    const mine = (this.byOrg.get(context.organizationId) ?? []).some((p) => p.id === profileId);
    return mine ? (this.rates.get(profileId) ?? null) : null;
  }
}

export class RecordingEgress implements EgressLog {
  readonly rows: EgressRecord[] = [];
  readonly #log: string[];
  fail = false;

  constructor(log: string[]) {
    this.#log = log;
  }

  async record(_context: AgentContext, entry: EgressRecord) {
    this.#log.push('egress.record');
    if (this.fail) throw new Error('could not write');
    this.rows.push(entry);
  }
}

export class FakeLedger implements UsageLedger {
  readonly #log: string[];
  available: Headroom['availableMicros'] = 1_000_000;
  reservation: Reservation | null = null;
  headroomThrows = false;
  settleThrows = false;
  releaseThrows = false;
  readonly reservations: ReservationRequest[] = [];
  readonly settled: { reservationId: string; actualMicros: number }[] = [];
  readonly released: string[] = [];
  readonly entries: LedgerEntry[] = [];

  constructor(log: string[]) {
    this.#log = log;
  }

  async headroom() {
    this.#log.push('ledger.headroom');
    if (this.headroomThrows) throw new Error('unreadable');
    return { availableMicros: this.available };
  }

  async reserve(_tx: Tx, _context: AgentContext, request: ReservationRequest) {
    this.#log.push('ledger.reserve');
    if (this.reservation) return this.reservation;
    this.reservations.push(request);
    return {
      ok: true as const,
      reservationId: `reservation-${this.reservations.length}`,
      amountMicros: request.amountMicros,
    };
  }

  async settle(
    _tx: Tx,
    _context: AgentContext,
    settlement: { reservationId: string; actualMicros: number },
  ) {
    this.#log.push('ledger.settle');
    if (this.settleThrows) throw new Error('could not write');
    this.settled.push(settlement);
  }

  async release(_tx: Tx, _context: AgentContext, reservationId: string) {
    this.#log.push('ledger.release');
    if (this.releaseThrows) throw new Error('could not write');
    this.released.push(reservationId);
  }

  async record(_tx: Tx, _context: AgentContext, entry: LedgerEntry) {
    this.#log.push('ledger.record');
    this.entries.push(entry);
    return true;
  }

  async reconcileRun() {
    return { ledgerMicros: 0, counterMicros: 0, matches: true };
  }
}

/** The scripted model, and a check that no transaction is open while it is being called. */
export class LoggedAdapter extends ScriptedModelAdapter {
  readonly #log: string[];
  readonly #openTx: () => number;
  sawOpenTransaction = false;

  constructor(log: string[], script: readonly ScriptStep[], openTx: () => number) {
    super(script);
    this.#log = log;
    this.#openTx = openTx;
  }

  override generate(call: AdapterCall, signal: AbortSignal): Promise<AdapterResult> {
    this.#log.push('adapter.generate');
    if (this.#openTx() > 0) this.sawOpenTransaction = true;
    return super.generate(call, signal);
  }
}

export class LoggedLender extends RecordingLender {
  readonly #log: string[];
  fail: 'before' | 'after' | null = null;

  constructor(log: string[], key: Buffer) {
    super(key);
    this.#log = log;
  }

  override async withKey<T>(profile: ProfileKeyRef, use: (key: Buffer) => Promise<T>): Promise<T> {
    this.#log.push('credentials.withKey');
    if (this.fail === 'before') {
      this.asked.push(profile);
      throw new Error('SecretUnavailable');
    }
    const value = await super.withKey(profile, use);
    if (this.fail === 'after') throw new Error('could not wipe');
    return value;
  }
}

export const generatedKey = () => randomBytes(24);

export const guard = (log: string[], endpoints: VerifiedEndpoint[] = []): EndpointGuard => ({
  fetchFor(endpoint) {
    log.push('guard.fetchFor');
    endpoints.push(endpoint);
    return (() => {
      throw new Error('This test reaches no network.');
    }) as unknown as typeof fetch;
  },
});

export const entitlements = (
  log: string[],
  result: EntitlementResult = { ok: true, billable: false, commercialMode: 'byom' },
): Entitlements => ({
  async check() {
    log.push('entitlements.check');
    return result;
  },
});

export const haltCheck = (log: string[], halted: () => boolean = () => false): HaltCheck => ({
  async assertRunning() {
    log.push('halt.assertRunning');
    if (halted()) throw new Error('AI_HALTED');
  },
});

export const turnStore = (
  log: string[],
  refuse: () => boolean = () => false,
): TurnStore & {
  bound: { runId: string; profileId: string; profileVersion: number }[];
} => {
  const bound: { runId: string; profileId: string; profileVersion: number }[] = [];
  return {
    bound,
    async beginTurn() {
      throw new Error('The gateway is handed a step that has already begun.');
    },
    async bindProfile(_context, binding) {
      log.push('turns.bindProfile');
      if (refuse()) throw new Error('Already bound');
      bound.push(binding);
    },
  };
};
