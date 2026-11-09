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
