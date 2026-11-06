// What makes a stop reach a call already in flight (SEC-06, ADR-028 FD-15). The check in
// `@ensemus/application/ai-halt` stops the next effect. This stops the current one: agent-worker polls the
// switches and aborts through the signal a model call was given. Unreadable state counts as halted, here as
// everywhere. The operator's command is parsed here too, so it can be tested without running it.
import {
  haltedError,
  readLiveSwitches,
  switchCovers,
  type LiveSwitch,
} from '@ensemus/application/ai-halt';
import type { AppDatabase } from '@ensemus/database';
import { withRunLookupTx } from '@ensemus/database/agent';
import type { OperatorSwitch } from '@ensemus/database/halt-operator';
import { createLogger, errorCode, type Logger } from '@ensemus/telemetry';

/**
 * How often agent-worker polls, for the wiring to pass in. An engineering choice and not a promise to
 * anyone: each poll is one short read per tenant with a call in flight. A tested limit follows from it,
 * `abortLimitMs`, and deciding what to tell a customer about that is the owner's.
 */
export const HALT_POLL_MS = 1_000;

/** One call to watch. Leave out `providerKind` if the provider is not chosen yet. */
export type WatchedRun = {
  organizationId: string;
  agentVersionId: string;
  providerKind?: string;
};

/** Registers an in-flight call so a switch can abort it, and tells the caller when one does. */
export interface HaltWatcher {
  start(): void;
  /** Stops polling and aborts whatever is left, since nothing is watching those any more. */
  stop(): Promise<void>;
  /**
   * Aborted when a switch covering this run engages or the switches cannot be read, with AI_HALTED as its
   * reason. Already aborted if the watcher is not running, because then nothing could keep this promise.
   * A call whose provider is not known yet is aborted by any provider's switch. Pair with `release`, or
   * use `watch`, which does it for you.
   */
  signalFor(run: WatchedRun): AbortSignal;
  /** The call this signal was for is over, so stop watching it. */
  release(signal: AbortSignal): void;
  /** Runs one call under a signal, and stops watching it however it ends. */
  watch<T>(run: WatchedRun, use: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * The longest a covered call can run on after its switch commits: a switch that just missed one read
   * waits for that read's answer, the pause, and all of the next read. Tested on a fake clock, and in
   * tests/integration/ai-halt.test.ts against a real database.
   */
  readonly abortLimitMs: number;
}

/** Reads the switches one tenant has to obey. It rejects, or never answers, when they cannot be read. */
export type SwitchReader = (organizationId: string) => Promise<readonly LiveSwitch[]>;

/** The real reader. Each read binds one tenant, because RLS shows it only that tenant's rows and the operator's. */
export const switchReaderFor =
  (database: AppDatabase): SwitchReader =>
  (organizationId) =>
    withRunLookupTx(database, organizationId, readLiveSwitches);

type WatcherLog = Pick<Logger, 'warn' | 'error'>;

export function createHaltWatcher(deps: {
  pollMs: number;
  read: SwitchReader;
  /** How long a read may take before the state counts as unreadable. The poll interval, unless set. */
  readTimeoutMs?: number;
  log?: WatcherLog;
}): HaltWatcher {
  const { pollMs, read } = deps;
  if (!(pollMs > 0)) throw new RangeError('pollMs must be positive');
  const readTimeoutMs = deps.readTimeoutMs ?? pollMs;
  if (!(readTimeoutMs > 0)) throw new RangeError('readTimeoutMs must be positive');
  const log = deps.log ?? createLogger('halt-watcher');

  const watches = new Map<AbortSignal, { run: WatchedRun; controller: AbortController }>();
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> = Promise.resolve();

  const abortWhere = (matches: (run: WatchedRun) => boolean) => {
    let count = 0;
    for (const [signal, watch] of watches) {
      if (!matches(watch.run)) continue;
      watches.delete(signal);
      watch.controller.abort(haltedError());
      count += 1;
    }
    return count;
  };

  /** Null means it could not be read. The hung read is abandoned: the pool times it out on its own. */
  const readWithin = async (organizationId: string): Promise<readonly LiveSwitch[] | null> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => read(organizationId))
          .catch((error: unknown) => {
            // Reduced to a code. A driver's message can quote the connection string or the query.
            log.warn('halt_watcher.unreadable', { organizationId, errorCode: errorCode(error) });
            return null;
          }),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => {
            log.warn('halt_watcher.unreadable', { organizationId, errorCode: 'READ_TIMEOUT' });
            resolve(null);
          }, readTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };

  const covers = (row: LiveSwitch, run: WatchedRun) =>
    switchCovers(row, run.organizationId, run) ||
    (row.scope === 'provider' && run.providerKind === undefined);

  const poll = async () => {
    const organizations = new Set([...watches.values()].map((watch) => watch.run.organizationId));
    await Promise.all(
      [...organizations].map(async (organizationId) => {
        const live = await readWithin(organizationId);
        const count = abortWhere(
          (run) =>
            run.organizationId === organizationId &&
            (live === null || live.some((row) => covers(row, run))),
        );
        if (count > 0) {
          log.warn('halt_watcher.aborted', {
            organizationId,
            count,
            reasonCode: live === null ? 'UNREADABLE' : 'SWITCH_ENGAGED',
          });
        }
      }),
    );
  };

  const schedule = () => {
    if (!running) return;
    timer = setTimeout(() => {
      polling = poll()
        // Nothing above should throw. If something does, this watcher can no longer keep its promise.
        .catch((error: unknown) => {
          log.error('halt_watcher.poll_failed', { errorCode: errorCode(error) });
          abortWhere(() => true);
        })
        .finally(schedule);
    }, pollMs);
    timer.unref?.();
  };

  const signalFor = (run: WatchedRun) => {
    const controller = new AbortController();
    if (!running) {
      controller.abort(haltedError());
      return controller.signal;
    }
    watches.set(controller.signal, { run, controller });
    return controller.signal;
  };

  const release = (signal: AbortSignal) => {
    watches.delete(signal);
  };

  return {
    abortLimitMs: pollMs + 2 * readTimeoutMs,
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await polling;
      abortWhere(() => true);
    },
    signalFor,
    release,
    async watch(run, use) {
      const signal = signalFor(run);
      try {
        return await use(signal);
      } finally {
        release(signal);
      }
    },
  };
}

// --- The operator's command, run through halt-global.ts.

export type HaltCommand =
  | { kind: 'engage'; input: OperatorSwitch }
  | { kind: 'release'; switchId: string }
  | { kind: 'list' };

const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Null for anything it was not built to do. It is strict about providers in particular: a name typed wrong
 * would write a row that looks like a stop and stops nothing, in the middle of an incident.
 */
export function parseHaltCommand(
  argv: readonly string[],
  providerKinds: readonly string[],
): HaltCommand | null {
  const [verb, ...rest] = argv;
  if (verb === 'list') return rest.length === 0 ? { kind: 'list' } : null;
  if (verb === 'release') {
    const [switchId] = rest;
    if (rest.length !== 1 || !switchId || !ID.test(switchId)) return null;
    return { kind: 'release', switchId: switchId.toLowerCase() };
  }
  if (verb !== 'engage') return null;
  const [scope] = rest;
  if (scope === 'global') {
    const [, reasonCode] = rest;
    if (rest.length !== 2 || !reasonCode || !REASON.test(reasonCode)) return null;
    return { kind: 'engage', input: { scope, reasonCode } };
  }
  if (scope === 'provider') {
    const [, providerKind, reasonCode] = rest;
    if (rest.length !== 3 || !providerKind || !reasonCode) return null;
    if (!providerKinds.includes(providerKind) || !REASON.test(reasonCode)) return null;
    return { kind: 'engage', input: { scope, providerKind, reasonCode } };
  }
  return null;
}

export type HaltOperations = {
  engage(input: OperatorSwitch): Promise<string>;
  release(switchId: string): Promise<void>;
  list(): Promise<
    readonly { id: string; scope: string; targetRef: string | null; engagedAt: Date }[]
  >;
};

/**
 * Prints the switch's ID and nothing else, after the write has committed, so a script can capture it and
 * a failure can never look like a stop. Listing has to say more, because a person picks an ID from it.
 */
export async function runHaltCommand(
  command: HaltCommand,
  operations: HaltOperations,
  write: (text: string) => void,
): Promise<void> {
  switch (command.kind) {
    case 'engage':
      write(`${await operations.engage(command.input)}\n`);
      return;
    case 'release':
      await operations.release(command.switchId);
      write(`${command.switchId}\n`);
      return;
    case 'list':
      for (const row of await operations.list()) {
        write(
          `${[row.id, row.scope, row.targetRef ?? '-', row.engagedAt.toISOString()].join('\t')}\n`,
        );
      }
  }
}
