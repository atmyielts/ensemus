// What the air-gap gate decides, apart from the Docker it runs on, so that a unit test can check each
// decision. See tests/unit/air-gap-rules.test.ts.

export const WATCHED_PREFIX = '172.30';
export const SUBNET = `${WATCHED_PREFIX}.0.0/16`;

/**
 * What stops the gate trusting its own count. The firewall rule only sees the watched subnet, so a
 * container anywhere else could call out unblocked and uncounted, and the gate would report zero.
 */
export function containersOffTheSubnet(containers) {
  if (containers.length === 0) return ['no container is running, so nothing was watched'];
  return containers.flatMap(({ name, addresses }) => {
    if (addresses.length === 0) return [`${name} has no address on any network`];
    const outside = addresses.filter((address) => !address.startsWith(`${WATCHED_PREFIX}.`));
    return outside.length ? [`${name} is at ${outside.join(', ')}`] : [];
  });
}

/** The proxy's two routes. A request says which one it wants with X-Ensemus-Test-Replica. */
export const WEB_REPLICAS = ['web', 'web-2'];

/**
 * What /api/health/ready must answer through the proxy, with one service stopped. It reads the
 * database, so it uses the name of postgres as well as the proxy's name for the replica. A stopped
 * replica leaves the proxy with nothing to reach, and only the proxy can answer then, with a 502. No
 * other answer is accepted, because a request that went astray would prove nothing about the name.
 */
export function expectedHealth(stopped, replica) {
  if (stopped === replica) return { status: 502, servedBy: null };
  if (stopped === 'postgres') return { status: 503, servedBy: replica };
  return { status: 200, servedBy: replica };
}

/** What reading a stored file must answer. With the store stopped, the replica has to say so. */
export function expectedFile(stopped, replica) {
  return { status: stopped === 'objects' ? 500 : 200, servedBy: replica };
}

/** Why an answer is not the expected one, or null when it is. No answer at all has status 0. */
export function wrongAnswer(answer, expected) {
  if (answer.status === expected.status && answer.servedBy === expected.servedBy) return null;
  const said = (reply) => `${reply.status} from ${reply.servedBy ?? 'the proxy itself'}`;
  return `expected ${said(expected)}, got ${answer.status === 0 ? 'no answer' : said(answer)}`;
}
