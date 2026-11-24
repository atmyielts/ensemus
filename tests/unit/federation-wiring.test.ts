import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from '../helpers/stack';
import { pinProblems, type ResolvedConfig } from '../helpers/compose-pins';

type ResolvedService = ResolvedConfig['services'][string];
type Service = Omit<ResolvedService, 'networks'> & {
  networks?: ResolvedService['networks'] | string[];
  profiles?: string[];
  network_mode?: string;
  read_only?: boolean;
  ports?: string[];
  secrets?: string[];
  environment?: Record<string, string | null>;
  depends_on?: Record<string, { condition: string; required?: boolean }>;
};
const config = parse(
  readFileSync(join(repoRoot, 'infrastructure/compose/compose.yaml'), 'utf8').replaceAll(
    '${ENSEMUS_NETWORK_PREFIX:-172.30}',
    '172.30',
  ),
) as {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean }>;
};
const worker = config.services['federation-worker']!;
const provision = config.services['provision-federation']!;

describe('federation deployment profile', () => {
  it('keeps both services and both credentials opt-in', () => {
    expect(worker.profiles).toEqual(['federation']);
    expect(provision.profiles).toEqual(['federation']);
    const secretConsumers = (secret: string) =>
      Object.entries(config.services)
        .filter(([, service]) => service.secrets?.includes(secret))
        .map(([service]) => service);
    expect(secretConsumers('db_federation_password')).toEqual(['provision-federation']);
    expect(secretConsumers('db_federation_url')).toEqual(['federation-worker']);
    expect(worker.environment?.DATABASE_URL_APP_FILE).toBe('/run/secrets/db_worker_url');
  });

  it('waits for provisioning and migration before starting the worker', () => {
    const completed = 'service_completed_successfully';
    expect(worker.depends_on).toMatchObject({
      'provision-federation': { condition: completed },
      migrate: { condition: completed },
      'temporal-namespace': { condition: completed },
    });
    expect(config.services.migrate!.depends_on?.['provision-federation']).toEqual({
      condition: completed,
      required: false,
    });
  });

  it('pins all bridge traffic to three peers on its internal network', () => {
    expect(config.networks.federation?.internal).toBe(true);
    const peers = ['postgres', 'temporal', 'objects'];
    const isolate = (service: Service) => {
      expect(service.networks).toEqual(['federation']);
      expect(service.network_mode).toBeUndefined();
      expect(service.ports).toBeUndefined();
      expect(service.read_only).toBe(true);
      return { networks: { federation: null }, extra_hosts: service.extra_hosts };
    };
    const services = {
      'federation-worker': isolate(worker),
      'provision-federation': isolate(provision),
      ...Object.fromEntries(
        peers.map((peer) => [
          peer,
          { networks: config.services[peer]!.networks as ResolvedService['networks'] },
        ]),
      ),
    };
    const members = Object.entries(config.services)
      .filter(([, service]) => Object.hasOwn(service.networks ?? {}, 'federation'))
      .map(([name]) => name);
    expect(members.sort()).toEqual([...peers].sort());
    expect(
      pinProblems(
        { services },
        {
          'federation-worker': peers,
          'provision-federation': ['postgres'],
          postgres: [],
          temporal: [],
          objects: [],
        },
      ),
    ).toEqual([]);
  });
});
