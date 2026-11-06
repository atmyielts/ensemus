// Reads the name pins out of a resolved Compose configuration (`docker compose config --format json`).
// A pin must be exactly the address its peer holds on a network the two share, because a stopped
// service's name otherwise leaves the network. See infrastructure/compose/compose.yaml.

export type ResolvedConfig = {
  services: Record<
    string,
    {
      networks?: Record<string, { ipv4_address?: string } | null>;
      extra_hosts?: string[] | Record<string, string | string[]>;
    }
  >;
};

const dataPeers = ['postgres', 'valkey', 'objects'];

/** Who connects to whom. A new service must be added here, rather than quietly left unpinned. */
export const SHIPPED_CONNECTIONS: Record<string, string[]> = {
  proxy: ['web'],
  web: dataPeers,
  worker: [...dataPeers, 'temporal'],
  dispatcher: [...dataPeers, 'temporal'],
  migrate: dataPeers,
  'temporal-schema': ['postgres'],
  temporal: ['postgres'],
  'temporal-namespace': ['temporal'],
  postgres: [],
  valkey: [],
  objects: [],
};

/** The same with compose.test.yaml, which the air-gap gate runs: a second replica and a test port. */
export const TEST_CONNECTIONS: Record<string, string[]> = {
  ...SHIPPED_CONNECTIONS,
  proxy: ['web', 'web-2'],
  'web-2': dataPeers,
  'temporal-test-port': ['temporal'],
};

export function pinsOf(config: ResolvedConfig, service: string): Record<string, string> {
  const hosts = config.services[service]?.extra_hosts ?? [];
  const pairs: [string, string][] = Array.isArray(hosts)
    ? hosts.map((entry) => {
        const [name = '', address = ''] = entry.split(/[:=]/);
        return [name, address];
      })
    : Object.entries(hosts).map(([name, value]) => [name, [value].flat()[0] ?? '']);
  return Object.fromEntries(pairs);
}

function addressesOf(config: ResolvedConfig, service: string) {
  return Object.entries(config.services[service]?.networks ?? {}).map(([network, settings]) => ({
    network,
    address: settings?.ipv4_address,
  }));
}

/** Everything wrong with the pins, in words. Exact, so a pin a service has no use for counts too. */
export function pinProblems(
  config: ResolvedConfig,
  connections: Record<string, string[]>,
): string[] {
  const problems: string[] = [];
  const known = Object.keys(connections).sort();
  const present = Object.keys(config.services).sort();
  for (const name of present) {
    if (!known.includes(name)) problems.push(`${name} is not in the list of connections`);
  }
  for (const name of known) {
    if (!present.includes(name)) problems.push(`${name} is not in this configuration`);
  }
  for (const [client, peers] of Object.entries(connections)) {
    const networks = addressesOf(config, client).map(({ network }) => network);
    const expected: Record<string, string> = {};
    for (const peer of peers) {
      const shared = addressesOf(config, peer).find(
        ({ network }) =>
          networks.includes(network) &&
          // Auxiliary worker networks also join these peers; Temporal still uses its DB network.
          (client !== 'temporal' || peer !== 'postgres' || network === 'temporal-db'),
      );
      if (!shared) {
        problems.push(`${client} shares no network with ${peer}`);
      } else if (!/^\d+\.\d+\.\d+\.\d+$/.test(shared.address ?? '')) {
        problems.push(`${peer} has no fixed address on ${shared.network}, for ${client} to pin`);
      } else {
        expected[peer] = shared.address as string;
      }
    }
    const pins = pinsOf(config, client);
    for (const name of new Set([...Object.keys(expected), ...Object.keys(pins)])) {
      if (pins[name] !== expected[name]) {
        problems.push(
          `${client} pins ${name} to ${pins[name] ?? 'nothing'}, expected ${expected[name] ?? 'no pin'}`,
        );
      }
    }
  }
  return problems;
}
