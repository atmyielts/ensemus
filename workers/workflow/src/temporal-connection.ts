// The dispatcher's connection to Temporal. It does not wait for Temporal at startup, because a process
// that cannot start cannot write the tombstone ledger or report its backlog either, and neither of
// those needs Temporal (ADR-026). Calls that do need it fail as an outage until it returns, and gRPC
// reconnects by itself.
import { TEMPORAL_CHANNEL_ARGS } from '@ensemus/workflows/constants';
import { Connection } from '@temporalio/client';

export function openDispatcherConnection(address: string) {
  return Connection.lazy({ address, channelArgs: TEMPORAL_CHANNEL_ARGS });
}
