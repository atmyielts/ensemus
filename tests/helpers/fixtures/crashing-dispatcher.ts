// The real dispatcher loop in a process of its own, which dies with no warning while delivering the
// event it was told to. It prints each event it was handed, and lets the others through normally.
import { dispatchDueEvents, openDispatcherDatabase } from '@ensemus/database/dispatcher';

const { DISPATCH_URL, KILL_ON } = process.env;
if (!DISPATCH_URL || !KILL_ON) throw new Error('DISPATCH_URL and KILL_ON are required');

const { db } = openDispatcherDatabase(DISPATCH_URL);
await dispatchDueEvents(
  db,
  async (event) => {
    process.stdout.write(`${event.aggregateId}\n`);
    if (event.aggregateId === KILL_ON) process.kill(process.pid, 'SIGKILL');
  },
  { leaseMs: 4_000 },
);
throw new Error('Finished without reaching the event it was told to die on');
