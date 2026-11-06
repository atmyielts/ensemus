// The one file in this package allowed to open a socket (enforced by lint). It connects to the egress
// gateway and nowhere else: the worker has no other route out, and the caller names no host (ADR-027 D5).
import { connect } from 'node:net';
import type { ConnectorNetwork } from '../index';

export function createGatewayNetwork(gatewayAddress: string): ConnectorNetwork {
  const [host, port] = gatewayAddress.split(':');
  if (!host || !port || !Number.isInteger(Number(port))) {
    throw new Error('The egress gateway address must be host:port');
  }
  return {
    openRelay: ({ timeoutMs, signal }) =>
      new Promise((resolve, reject) => {
        const socket = connect({ host, port: Number(port) });
        const fail = (error: Error) => {
          socket.destroy();
          reject(error);
        };
        const onAbort = () => fail(new Error('ABORTED'));
        const timer = setTimeout(() => fail(new Error('CONNECT_TIMEOUT')), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        socket.once('error', fail);
        socket.once('connect', () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          socket.off('error', fail);
          resolve(socket);
        });
      }),
  };
}
