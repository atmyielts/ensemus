// The check on name pins, against configurations that must fail it. tests/stack/platform.test.ts runs
// it on what Compose really resolves, for compose.yaml and for compose.test.yaml.
import { describe, expect, it } from 'vitest';
import { pinProblems, pinsOf, type ResolvedConfig } from '../helpers/compose-pins';

const connections = { proxy: ['web', 'web-2'], web: [], 'web-2': [] };
const good = (): ResolvedConfig => ({
  services: {
    proxy: {
      networks: { edge: null },
      extra_hosts: ['web:172.30.1.10', 'web-2:172.30.1.11'],
    },
    web: { networks: { edge: { ipv4_address: '172.30.1.10' } } },
    'web-2': { networks: { edge: { ipv4_address: '172.30.1.11' } } },
  },
});

describe('pinProblems', () => {
  it('accepts correct pins', () => {
    expect(pinProblems(good(), connections)).toEqual([]);
  });

  it('reads pins in every form Compose prints', () => {
    const pins = { web: '172.30.1.10', 'web-2': '172.30.1.11' };
    for (const form of [
      ['web:172.30.1.10', 'web-2:172.30.1.11'],
      // What `docker compose config` really prints for a list.
      ['web=172.30.1.10', 'web-2=172.30.1.11'],
      { web: '172.30.1.10', 'web-2': ['172.30.1.11'] },
    ]) {
      const config = good();
      (config.services.proxy as { extra_hosts: unknown }).extra_hosts = form;
      expect(pinsOf(config, 'proxy')).toEqual(pins);
      expect(pinProblems(config, connections)).toEqual([]);
    }
  });

  it('refuses a missing pin, which is the fault an outage would send off the network', () => {
    const config = good();
    (config.services.proxy as { extra_hosts: string[] }).extra_hosts = ['web:172.30.1.10'];
    expect(pinProblems(config, connections)).toEqual([
      'proxy pins web-2 to nothing, expected 172.30.1.11',
    ]);
  });

  it('refuses a pin to the wrong address', () => {
    const config = good();
    (config.services.proxy as { extra_hosts: string[] }).extra_hosts = [
      'web:172.30.1.10',
      'web-2:172.30.1.12',
    ];
    expect(pinProblems(config, connections)).toEqual([
      'proxy pins web-2 to 172.30.1.12, expected 172.30.1.11',
    ]);
  });

  it('refuses a pin the service has no use for', () => {
    const config = good();
    (config.services.web as { extra_hosts?: string[] }).extra_hosts = ['temporal:172.30.3.10'];
    expect(pinProblems(config, connections)).toEqual([
      'web pins temporal to 172.30.3.10, expected no pin',
    ]);
  });

  it('refuses a peer with no fixed address, or no shared network', () => {
    const config = good();
    (config.services.web as { networks: unknown }).networks = { edge: null };
    (config.services['web-2'] as { networks: unknown }).networks = { data: null };
    const problems = pinProblems(config, connections);
    expect(problems).toContain('web has no fixed address on edge, for proxy to pin');
    expect(problems).toContain('proxy shares no network with web-2');
  });

  it('refuses a service nobody listed', () => {
    const config = good();
    config.services.extra = {};
    expect(pinProblems(config, connections)).toEqual(['extra is not in the list of connections']);
  });

  it('refuses a listed service that is not there, so the list cannot go stale', () => {
    const config = good();
    expect(pinProblems(config, { ...connections, gone: [] })).toEqual([
      'gone is not in this configuration',
    ]);
  });
});
