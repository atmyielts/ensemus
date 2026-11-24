// How much the platform worker runs at once, against how many PostgreSQL connections it holds.
//
// Every platform Activity takes a pooled connection, and the pool gives up on a checkout after 5 seconds
// (packages/database/src/connection.ts). The Temporal SDK's default is 100 Activities at once, so a burst of
// work (a dispatcher coming back to a backlog, WORK-06) queued about 90 of them on the pool's 10 connections.
// A checkout that timed out was only a retry for most Activities, but not for the completion checklist: its
// first transaction had already committed the generated write, so the retry met an earlier write it may not
// overlap and refused for good, and the Work ended failed (tests/stack/real-failures.test.ts). Activities now
// wait in Temporal's queue, which has no deadline, instead of in the pool, which has one.

/** Connections the platform worker's pool may hold. */
export const PLATFORM_DATABASE_POOL = 12;

/**
 * Activities the platform worker runs at once. Fewer than the pool, so an Activity that briefly needs a second
 * connection (a failure record after its transaction, a fresh read) still finds one.
 */
export const PLATFORM_ACTIVITY_SLOTS = 8;

/** Connections kept free for that second checkout, whatever the Activities are doing. */
export const CONNECTION_HEADROOM = 2;

/** Refuses a configuration that could queue Activities on the pool, where a wait has a deadline. */
export function assertActivityCapacity(pool: number, activities: number): void {
  if (!Number.isSafeInteger(pool) || !Number.isSafeInteger(activities) || activities < 1)
    throw new Error('WORKER_CAPACITY_INVALID');
  if (activities + CONNECTION_HEADROOM > pool) throw new Error('WORKER_CAPACITY_EXCEEDS_POOL');
}

// The connector worker (ADR-027 D5). It holds every connector credential and talks to providers through the
// egress gateways, so how much it does at once is also how hard it can push a provider and the gateways. The
// SDK default of 100 Activities on a pool of 10 has the same failure as the platform worker had (WORK-06), and
// a burst of suite reads or webhook deliveries is exactly when it would show. So it is capped, and an operator
// may move the cap within bounds that keep the pool above it.

/** Activities the connector worker runs at once when nothing says otherwise. A starting value, not a measurement. */
export const CONNECTOR_ACTIVITY_SLOTS_DEFAULT = 8;

/** The most an operator may ask for. Past this, the gateways and providers are the limit, not the worker. */
export const CONNECTOR_ACTIVITY_SLOTS_MAX = 32;

/** The setting that moves the cap. */
export const CONNECTOR_ACTIVITY_SLOTS_SETTING = 'ENSEMUS_CONNECTOR_ACTIVITY_SLOTS';

/**
 * The connector worker's cap, from its setting. Unset means the default. Anything but a whole number from 1 to
 * the maximum stops the worker, because a cap that silently fell back would look set and not be. The error
 * names the setting and never repeats its value.
 */
export function connectorActivitySlots(env: NodeJS.ProcessEnv = process.env): number {
  const value = env[CONNECTOR_ACTIVITY_SLOTS_SETTING];
  if (value === undefined) return CONNECTOR_ACTIVITY_SLOTS_DEFAULT;
  if (!/^[1-9][0-9]{0,2}$/.test(value)) throw new Error('CONNECTOR_ACTIVITY_SLOTS_INVALID');
  const slots = Number(value);
  if (slots > CONNECTOR_ACTIVITY_SLOTS_MAX) throw new Error('CONNECTOR_ACTIVITY_SLOTS_INVALID');
  return slots;
}

/** The connector worker's pool: one connection per Activity, and the same headroom the platform worker keeps. */
export const connectorDatabasePool = (slots: number) => slots + CONNECTION_HEADROOM;
