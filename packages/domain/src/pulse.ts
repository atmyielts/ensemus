// Company Pulse (WORK-09). A signal is a fact about work with a link to the records it rests on, and
// nothing else: no score for a person, and no claim about why (ADR-031 D4). Owned by the pulse slice,
// which derives facts only. Visibility is decided by the application before calling this module.
import { STOP_CODES } from './ai';
import { isTerminal, startOfUtcDay, WORK_STATES, type WorkState } from './work-unit';

export const PULSE_SIGNAL_KINDS = [
  'work_overdue',
  'work_due_soon',
  'work_blocked_by_prerequisite',
  'work_owner_disabled',
  'approval_waiting_past_expiry_window',
  'external_action_unknown',
  'external_action_failed',
  'process_run_failed',
  'agent_run_stopped',
] as const;
export type PulseSignalKind = (typeof PULSE_SIGNAL_KINDS)[number];

export type PulseSeverity = 'attention' | 'watch';

/** A record a signal rests on. Every signal has at least one, and the type requires it. */
export type PulseEvidence = {
  kind: 'work_unit' | 'approval' | 'external_action' | 'process_run' | 'agent_run';
  id: string;
  /** Why this record counts, as a fixed code. */
  reasonCode: string;
  observedAt: Date;
};

export type PulseSignal = {
  /** Stable across recomputes, so a person's dismissal keeps applying to the same fact. */
  key: string;
  kind: PulseSignalKind;
  severity: PulseSeverity;
  /** Never a person: Pulse groups by project and client, and has no per-person numbers at all. */
  scope: { projectId: string | null; clientId: string | null };
  evidence: readonly [PulseEvidence, ...PulseEvidence[]];
  since: Date;
};

export type PulseWorkFact = {
  id: string;
  status: string;
  dueAt: Date | null;
  updatedAt: Date;
  projectId: string | null;
  clientId: string | null;
  ownerDisabled: boolean;
  blockedByPrerequisite: boolean;
};

export type PulseFacts = {
  now: Date;
  /** Only what the viewer can read. The service filters before this function sees anything. */
  work: readonly PulseWorkFact[];
  approvals: readonly { id: string; workUnitId: string; expiresAt: Date; createdAt: Date }[];
  externalActions: readonly {
    id: string;
    workUnitId: string;
    status: 'unknown' | 'failed';
    updatedAt: Date;
  }[];
  processRuns: readonly { id: string; rootWorkUnitId: string; stopCode: string | null; at: Date }[];
  agentRuns: readonly { id: string; workUnitId: string; stopCode: string; at: Date }[];
};

/** How close to its limit something has to be before Pulse mentions it. Starting values. */
export const PULSE_DUE_SOON_HOURS = 48;
export const PULSE_APPROVAL_WINDOW_HOURS = 24;
/** Product limit: a signal cannot be silently snoozed indefinitely. Dismissal is a separate choice. */
export const PULSE_MAX_SNOOZE_DAYS = 30;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const kinds = new Set<string>(PULSE_SIGNAL_KINDS);
const workStates = new Set<string>(WORK_STATES);
const agentStopCodes = new Set<string>(STOP_CODES);
// M7's process runtime propagates M4 failures and these fixed process-step outcomes. An unknown
// future code can still produce a factual failure signal, with its details left to the source record.
const processStopCodes = new Set<string>([
  ...STOP_CODES,
  'STEP_FAILED',
  'RESTRICTED_EFFECT',
  'TOOL_NOT_CONNECTED',
  'AGENT_NOT_PUBLISHED',
  'EVIDENCE_MISSING',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recordId(raw: string): string | null {
  return typeof raw === 'string' && raw.length === 36 && UUID.test(raw) ? raw.toLowerCase() : null;
}

/** No trimming: extra text, line breaks and unknown kinds cannot name a real dismissal target. */
export function parsePulseSignalKey(raw: string): { kind: PulseSignalKind; id: string } | null {
  if (typeof raw !== 'string') return null;
  const separator = raw.indexOf(':');
  if (separator < 1) return null;
  const kind = raw.slice(0, separator);
  const id = recordId(raw.slice(separator + 1));
  return kinds.has(kind) && id ? { kind: kind as PulseSignalKind, id } : null;
}

export function pulseSignalKey(kind: PulseSignalKind, rawId: string): string {
  const id = recordId(rawId);
  if (!kinds.has(kind) || !id) throw new RangeError('INVALID_PULSE_SIGNAL_KEY');
  return `${kind}:${id}`;
}

function instant(value: Date): number | null {
  if (!(value instanceof Date)) return null;
  const at = value.getTime();
  return Number.isFinite(at) ? at : null;
}

export function snoozeEndIsAllowed(until: Date, now: Date): boolean {
  const end = instant(until),
    current = instant(now);
  return (
    end !== null &&
    current !== null &&
    end > current &&
    end - current <= PULSE_MAX_SNOOZE_DAYS * DAY_MS
  );
}

export function personalStateOf(
  row: { state: string; until: Date | null } | null | undefined,
  now: Date,
): { personalState: 'open' | 'snoozed' | 'dismissed'; snoozedUntil: Date | null } {
  if (instant(now) !== null && row) {
    if (row.state === 'dismissed' && row.until === null)
      return { personalState: 'dismissed', snoozedUntil: null };
    if (row.state === 'snoozed' && row.until !== null && snoozeEndIsAllowed(row.until, now))
      return { personalState: 'snoozed', snoozedUntil: new Date(row.until.getTime()) };
  }
  return { personalState: 'open', snoozedUntil: null };
}

/** Identical repeats collapse. Conflicting/invalid snapshots of one ID have no authoritative winner. */
function uniqueFacts<Input extends { id: string }, Value extends { id: string }>(
  input: readonly Input[],
  normalize: (raw: Input, id: string) => Value | null,
): ReadonlyMap<string, Value> {
  const values = new Map<string, Value | null>();
  for (const raw of input) {
    const id = recordId(raw.id);
    if (!id) continue;
    const value = normalize(raw, id);
    if (values.has(id)) {
      if (JSON.stringify(values.get(id)) !== JSON.stringify(value)) values.set(id, null);
    } else values.set(id, value);
  }
  return new Map([...values].filter((entry): entry is [string, Value] => entry[1] !== null));
}

type Work = Omit<PulseWorkFact, 'status' | 'dueAt' | 'updatedAt'> & {
  status: WorkState;
  dueAt: number | null;
  updatedAt: number;
};

function observation(value: Date, now: number): number | null {
  const at = instant(value);
  return at !== null && at <= now ? at : null;
}

/** Uppercase text is not by itself a trusted code. Unknowns retain only the factual failure kind. */
function processReason(raw: string | null): string {
  return raw !== null && processStopCodes.has(raw) ? raw : 'PROCESS_RUN_FAILED';
}

/**
 * Pure and total over the fact contract, including invalid dates/IDs/statuses. Every signal has evidence;
 * unreadable Work is absent from the input, and supporting records cannot bypass that intersection.
 */
export function deriveSignals(facts: PulseFacts): readonly PulseSignal[] {
  const now = instant(facts.now);
  if (now === null) return [];
  const day = startOfUtcDay(facts.now).getTime();
  const work = uniqueFacts(facts.work, (raw, id): Work | null => {
    const updatedAt = observation(raw.updatedAt, now);
    const dueAt = raw.dueAt === null ? null : instant(raw.dueAt);
    if (!workStates.has(raw.status) || updatedAt === null || (raw.dueAt !== null && dueAt === null))
      return null;
    return {
      id,
      status: raw.status as WorkState,
      updatedAt,
      dueAt,
      projectId: raw.projectId === null ? null : recordId(raw.projectId),
      clientId: raw.clientId === null ? null : recordId(raw.clientId),
      ownerDisabled: raw.ownerDisabled === true,
      blockedByPrerequisite: raw.blockedByPrerequisite === true,
    };
  });
  const signals: PulseSignal[] = [];
  const evidence = (
    kind: PulseEvidence['kind'],
    id: string,
    reasonCode: string,
    at: number,
  ): PulseEvidence => ({ kind, id, reasonCode, observedAt: new Date(at) });
  const workEvidence = (item: Work, reason = 'WORK_LINKED') =>
    evidence('work_unit', item.id, reason, item.updatedAt);
  const add = (
    kind: PulseSignalKind,
    id: string,
    item: Work,
    severity: PulseSeverity,
    since: number,
    items: readonly [PulseEvidence, ...PulseEvidence[]],
  ) => {
    signals.push({
      key: pulseSignalKey(kind, id),
      kind,
      severity,
      scope: { projectId: item.projectId, clientId: item.clientId },
      evidence: items,
      since: new Date(since),
    });
  };
  for (const item of work.values()) {
    if (isTerminal(item.status)) continue;
    if (item.dueAt !== null) {
      if (item.dueAt < day) {
        const threshold = startOfUtcDay(new Date(item.dueAt)).getTime() + DAY_MS;
        add('work_overdue', item.id, item, 'attention', Math.max(item.updatedAt, threshold), [
          workEvidence(item, 'WORK_OVERDUE'),
        ]);
      } else if (item.dueAt - now <= PULSE_DUE_SOON_HOURS * HOUR_MS)
        add(
          'work_due_soon',
          item.id,
          item,
          'watch',
          Math.max(item.updatedAt, item.dueAt - PULSE_DUE_SOON_HOURS * HOUR_MS),
          [workEvidence(item, 'WORK_DUE_SOON')],
        );
    }
    if (item.blockedByPrerequisite)
      add('work_blocked_by_prerequisite', item.id, item, 'attention', item.updatedAt, [
        workEvidence(item, 'PREREQUISITE_INCOMPLETE'),
      ]);
    if (item.ownerDisabled)
      add('work_owner_disabled', item.id, item, 'attention', item.updatedAt, [
        workEvidence(item, 'WORK_OWNER_DISABLED'),
      ]);
  }
  const approvals = uniqueFacts(facts.approvals, (raw, id) => {
    const workUnitId = recordId(raw.workUnitId),
      createdAt = observation(raw.createdAt, now),
      expiresAt = instant(raw.expiresAt);
    return workUnitId && createdAt !== null && expiresAt !== null && createdAt < expiresAt
      ? { id, workUnitId, createdAt, expiresAt }
      : null;
  });
  for (const approval of approvals.values()) {
    const item = work.get(approval.workUnitId);
    if (
      !item ||
      isTerminal(item.status) ||
      approval.expiresAt <= now ||
      approval.expiresAt - now > PULSE_APPROVAL_WINDOW_HOURS * HOUR_MS
    )
      continue;
    add('approval_waiting_past_expiry_window', approval.id, item, 'watch', approval.createdAt, [
      evidence('approval', approval.id, 'APPROVAL_EXPIRING', approval.createdAt),
      workEvidence(item),
    ]);
  }
  const actions = uniqueFacts(facts.externalActions, (raw, id) => {
    const workUnitId = recordId(raw.workUnitId),
      updatedAt = observation(raw.updatedAt, now);
    return workUnitId && updatedAt !== null && (raw.status === 'unknown' || raw.status === 'failed')
      ? { id, workUnitId, updatedAt, status: raw.status }
      : null;
  });
  for (const action of actions.values()) {
    const item = work.get(action.workUnitId);
    if (!item || (action.status !== 'unknown' && isTerminal(item.status))) continue;
    const kind = action.status === 'unknown' ? 'external_action_unknown' : 'external_action_failed';
    add(kind, action.id, item, 'attention', action.updatedAt, [
      evidence('external_action', action.id, kind.toUpperCase(), action.updatedAt),
      workEvidence(item),
    ]);
  }
  const processes = uniqueFacts(facts.processRuns, (raw, id) => {
    const workUnitId = recordId(raw.rootWorkUnitId),
      at = observation(raw.at, now);
    return workUnitId && at !== null
      ? { id, workUnitId, at, code: processReason(raw.stopCode) }
      : null;
  });
  for (const run of processes.values()) {
    const item = work.get(run.workUnitId);
    if (!item || isTerminal(item.status)) continue;
    add('process_run_failed', run.id, item, 'attention', run.at, [
      evidence('process_run', run.id, run.code, run.at),
      workEvidence(item),
    ]);
  }
  const agents = uniqueFacts(facts.agentRuns, (raw, id) => {
    const workUnitId = recordId(raw.workUnitId),
      at = observation(raw.at, now);
    return workUnitId && at !== null
      ? {
          id,
          workUnitId,
          at,
          code: agentStopCodes.has(raw.stopCode) ? raw.stopCode : 'AGENT_RUN_STOPPED',
        }
      : null;
  });
  for (const run of agents.values()) {
    const item = work.get(run.workUnitId);
    if (
      !item ||
      isTerminal(item.status) ||
      run.code === 'STOPPED_BY_PERSON' ||
      run.code === 'WORK_STOPPED'
    )
      continue;
    add('agent_run_stopped', run.id, item, 'attention', run.at, [
      workEvidence(item),
      evidence('agent_run', run.id, run.code, run.at),
    ]);
  }
  return signals.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'attention' ? -1 : 1) ||
      a.since.getTime() - b.since.getTime() ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
