// PLAT-16: what the air-gap gate decides. A gate that cannot fail is worse than no gate, so these are
// the decisions that make it fail. The gate itself needs Docker and runs in CI.
import { describe, expect, it } from 'vitest';
import {
  containersOffTheSubnet,
  expectedFile,
  expectedHealth,
  gateNetworkPrefix,
  SUBNET,
  wrongAnswer,
} from '../../infrastructure/scripts/air-gap-rules.mjs';

describe('the subnet the gate watches', () => {
  it('allows a dedicated private subnet and refuses ambiguous or public prefixes', () => {
    expect(gateNetworkPrefix(undefined)).toBe('172.30');
    expect(gateNetworkPrefix('172.28')).toBe('172.28');
    for (const value of ['', '172.15', '172.32', '172.280', '172.28.1', '172.28/16']) {
      expect(() => gateNetworkPrefix(value)).toThrow('AIRGAP_NETWORK_PREFIX_INVALID');
    }
  });
  it('is the one the stack uses by default', () => {
    expect(SUBNET).toBe('172.30.0.0/16');
  });

  it('accepts a stack on it', () => {
    expect(
      containersOffTheSubnet([
        { name: '/ensemus-web-1', addresses: ['172.30.1.10', '172.30.2.130'] },
        { name: '/ensemus-postgres-1', addresses: ['172.30.2.10', '172.30.4.10'] },
      ]),
    ).toEqual([]);
  });

  it('refuses a stack that a .env file moved somewhere else', () => {
    const problems = containersOffTheSubnet([
      { name: '/ensemus-web-1', addresses: ['10.20.1.10', '10.20.2.130'] },
    ]);
    expect(problems).toEqual(['/ensemus-web-1 is at 10.20.1.10, 10.20.2.130']);
  });

  it('refuses one container off it, among others on it', () => {
    const problems = containersOffTheSubnet([
      { name: '/on', addresses: ['172.30.1.10'] },
      { name: '/off', addresses: ['172.30.2.130', '172.31.0.2'] },
    ]);
    expect(problems).toEqual(['/off is at 172.31.0.2']);
  });

  it('does not take a lookalike address for one inside it', () => {
    expect(containersOffTheSubnet([{ name: '/a', addresses: ['172.300.1.10'] }])).toHaveLength(1);
  });

  it('refuses when there is nothing to watch', () => {
    expect(containersOffTheSubnet([])).toHaveLength(1);
    expect(containersOffTheSubnet([{ name: '/a', addresses: [] }])).toHaveLength(1);
  });
});

describe('what an outage must look like through the proxy', () => {
  it('answers from the proxy alone for the replica that is stopped', () => {
    expect(expectedHealth('web', 'web')).toEqual({ status: 502, servedBy: null });
    expect(expectedHealth('web-2', 'web-2')).toEqual({ status: 502, servedBy: null });
  });

  it('keeps the other replica answering', () => {
    expect(expectedHealth('web', 'web-2')).toEqual({ status: 200, servedBy: 'web-2' });
    expect(expectedHealth('web-2', 'web')).toEqual({ status: 200, servedBy: 'web' });
  });

  it('has a replica say so when the database is gone', () => {
    expect(expectedHealth('postgres', 'web')).toEqual({ status: 503, servedBy: 'web' });
  });

  it('expects nothing to change when a service the health check does not read stops', () => {
    for (const stopped of ['objects', 'valkey', 'temporal']) {
      expect(expectedHealth(stopped, 'web-2')).toEqual({ status: 200, servedBy: 'web-2' });
    }
  });

  it('has a stored file fail only while the store is stopped', () => {
    expect(expectedFile('objects', 'web')).toEqual({ status: 500, servedBy: 'web' });
    expect(expectedFile(undefined, 'web-2')).toEqual({ status: 200, servedBy: 'web-2' });
  });
});

describe('what counts as a real answer', () => {
  const healthy = { status: 200, servedBy: 'web' };

  it('accepts the expected answer', () => {
    expect(wrongAnswer(healthy, healthy)).toBeNull();
    const fromProxy = { status: 502, servedBy: null };
    expect(wrongAnswer(fromProxy, fromProxy)).toBeNull();
  });

  // How the gate used to pass: the request never reached a replica, and nobody looked.
  it('refuses no answer at all', () => {
    expect(wrongAnswer({ status: 0, servedBy: null }, healthy)).toBe(
      'expected 200 from web, got no answer',
    );
  });

  it('refuses an answer the proxy made up, such as for an unknown address', () => {
    expect(wrongAnswer({ status: 200, servedBy: null }, healthy)).toBe(
      'expected 200 from web, got 200 from the proxy itself',
    );
  });

  it('refuses the wrong status from the right replica', () => {
    expect(wrongAnswer({ status: 500, servedBy: 'web' }, healthy)).toBe(
      'expected 200 from web, got 500 from web',
    );
  });

  it('refuses the right status from the wrong replica', () => {
    expect(wrongAnswer({ status: 200, servedBy: 'web-2' }, healthy)).toBe(
      'expected 200 from web, got 200 from web-2',
    );
  });

  it('refuses a replica answering while it is meant to be stopped', () => {
    expect(wrongAnswer(healthy, { status: 502, servedBy: null })).toBe(
      'expected 502 from the proxy itself, got 200 from web',
    );
  });
});
