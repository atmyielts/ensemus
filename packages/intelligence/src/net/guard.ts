// Owned by the transport slice (SEC-11). See docs/06-delivery/m4-slices.md and ADR-028 FD-10. The only file
// tree in this package allowed a socket or DNS, by lint.
//
// A check at the form is not enough: a public name can answer with a private address at the moment of
// connecting (DNS rebinding, TR-022). So the name is resolved once here, every answer is judged, and the
// socket can only reach that one judged address. The URL keeps its host name throughout, so TLS still
// verifies the certificate against the name and the provider still sees the right Host header.
import { lookup as dnsLookup } from 'node:dns/promises';
import { classifyAddress, isAddressLiteral, sameAddress } from '@ensemus/policy/endpoint';
import { Agent, buildConnector, fetch as undiciFetch, type RequestInit } from 'undici';
import type { EndpointGuard, VerifiedEndpoint } from '../types';
import { EndpointRefused, EndpointUnreachable, ResponseTooLarge } from './errors';

export type Resolver = (host: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;

export { EndpointRefused, EndpointUnreachable, ResponseTooLarge } from './errors';

/**
 * Not a product limit: a model's answer is text, and this stops a hostile endpoint from filling memory
 * with one, since provider packages read a whole body before parsing it.
 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const systemResolver: Resolver = async (host) => {
  const answers = await dnsLookup(host, { all: true, order: 'ipv4first' });
  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : [],
  );
};

type Pin = { address: string; family: 4 | 6 };

const stripBrackets = (host: string) =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

function judge(address: string, endpoint: VerifiedEndpoint): void {
  const kind = classifyAddress(address);
  if (kind === 'public') return;
  if (kind === 'private' && endpoint.viaPrivateAllowlist) return;
  throw new EndpointRefused();
}

async function pinFor(endpoint: VerifiedEndpoint, resolve: Resolver): Promise<Pin> {
  // Plain HTTP puts a key on the wire, so it needs the same operator's word as a private address.
  if (endpoint.protocol !== 'https:' && !endpoint.viaPrivateAllowlist) throw new EndpointRefused();
  const host = stripBrackets(endpoint.host);
  if (isAddressLiteral(host)) {
    judge(host, endpoint);
    return { address: host, family: host.includes(':') ? 6 : 4 };
  }
  let answers: Awaited<ReturnType<Resolver>>;
  try {
    answers = await resolve(host);
  } catch {
    throw new EndpointUnreachable();
  }
  const first = answers[0];
  if (!first) throw new EndpointUnreachable();
  // Every answer, and not just the one used: a name answering with a mix of public and private
  // addresses is either broken or an attack, and neither should get a key.
  for (const answer of answers) judge(answer.address, endpoint);
  return { address: first.address, family: first.family };
}

function agentFor(pin: Pin): Agent {
  const connector = buildConnector({ allowH2: false });
  return new Agent({
    allowH2: false,
    // One request per connection: no keep-alive means nothing outlives this call, and a pooled
    // connection can never carry another tenant's key.
    pipelining: 0,
    connect: (options, callback) => {
      // Connect to the judged literal, so no resolver runs inside the socket. Keep the original DNS
      // name for TLS verification/SNI; Undici builds the Host header from its unchanged request URL.
      // This also avoids Node's Windows peer-address cache being populated before a DNS connection
      // finishes, which otherwise leaves remoteAddress empty even after connect.
      connector(
        {
          ...options,
          hostname: pin.address,
          servername: options.protocol === 'https:' ? (options.servername ?? options.hostname) : '',
        },
        (error, socket) => {
          if (error || !socket) {
            callback(error ?? new EndpointUnreachable(), null);
            return;
          }
          // The literal above is the control. Verify where the socket actually went as well.
          if (!sameAddress(socket.remoteAddress ?? '', pin.address)) {
            socket.destroy();
            callback(new EndpointRefused(), null);
            return;
          }
          callback(null, socket);
        },
      );
    },
  });
}

function targetOf(input: Parameters<typeof fetch>[0], endpoint: VerifiedEndpoint): URL {
  // Provider packages pass a string. A Request could carry its own redirect mode and signal, and no
  // caller needs one, so it is refused and not unpacked.
  if (typeof input !== 'string' && !(input instanceof URL)) throw new EndpointRefused();
  let target: URL;
  try {
    target = new URL(input);
  } catch {
    throw new EndpointRefused();
  }
  const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;
  const sameEndpoint =
    target.protocol === endpoint.protocol &&
    target.hostname === endpoint.host.toLowerCase() &&
    port === endpoint.port &&
    !target.username &&
    !target.password;
  if (!sameEndpoint) throw new EndpointRefused();
  return target;
}

function isRedirectRefusal(error: unknown): boolean {
  const cause = (error as { cause?: { message?: unknown } } | null)?.cause;
  return cause?.message === 'unexpected redirect';
}

function capped(upstream: Awaited<ReturnType<typeof undiciFetch>>): Response {
  const declared = Number(upstream.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) {
    void upstream.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge();
  }
  const init = {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: [...upstream.headers] as [string, string][],
  };
  if (!upstream.body || NULL_BODY_STATUSES.has(upstream.status)) {
    return new Response(null, init);
  }
  let seen = 0;
  const counted = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > MAX_RESPONSE_BYTES) controller.error(new ResponseTooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, init);
}

export function createEndpointGuard(deps: { resolve?: Resolver } = {}): EndpointGuard {
  const resolve = deps.resolve ?? systemResolver;
  return {
    fetchFor(endpoint) {
      // Resolved once per guarded fetch, on first use, so it holds for everything this call sends. A
      // refusal is remembered too: a second request gets no second chance at a friendlier answer.
      let pinned: Promise<Pin> | undefined;
      const guarded = async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const target = targetOf(input, endpoint);
        pinned ??= pinFor(endpoint, resolve);
        const agent = agentFor(await pinned);
        let upstream: Awaited<ReturnType<typeof undiciFetch>>;
        try {
          upstream = await undiciFetch(target.href, {
            ...(init as RequestInit | undefined),
            // Last, so no caller can choose its own dispatcher or follow a redirect to where a key
            // should not go.
            dispatcher: agent,
            redirect: 'error',
          });
        } catch (error) {
          void agent.destroy().catch(() => undefined);
          if (isRedirectRefusal(error)) throw new EndpointRefused({ afterRequest: true });
          throw error;
        }
        // Graceful: it waits for the body still being read, then closes the socket.
        void agent.close().catch(() => undefined);
        return capped(upstream);
      };
      return guarded as typeof fetch;
    },
  };
}
