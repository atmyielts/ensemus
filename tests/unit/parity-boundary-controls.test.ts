// Scratch check, never committed: runs the seam scenarios against local fakes, with no stack.
import { describe, expect, it, vi } from 'vitest';
import { PARITY_CATALOG } from '../parity/catalog';
import { identifiersIn, type Observation } from '../parity/rules';
import { seamFrom, SeamNotWired, type ParitySeams, type ParityTenant } from '../parity/seams';

const captured = vi.hoisted(() => ({
  file: '',
  scenarios: {} as Record<string, (context: never) => Promise<unknown>>,
}));

vi.mock('../parity/harness', () => ({
  describeParity: (file: string, scenarios: typeof captured.scenarios) => {
    captured.file = file;
    captured.scenarios = scenarios;
  },
}));

await import('../parity/scenarios/boundary.parity');

const SEAM_SCENARIOS = ['PAR-SEC-04', 'PAR-ACT-01', 'PAR-ACT-02', 'PAR-ACT-03'];

const tenantOf = (label = 'x'): ParityTenant =>
  ({ organization: label, owner: { jar: { cookie: '' }, name: label, email: '' } }) as ParityTenant;

function contextWith(wiring: Partial<ParitySeams>) {
  const tenant = vi.fn(async (label?: string) => tenantOf(label));
  return {
    tenant,
    context: {
      mode: 'cloud',
      su: {},
      tenant,
      seam: (name: keyof ParitySeams) => seamFrom(wiring, name),
      expected: () => '',
    } as never,
  };
}

const run = (id: string, context: never) => captured.scenarios[id]!(context);

const goodModels = () => {
  let calls = 0;
  const seam = {
    arrange: async () => undefined,
    invoke: async (_: ParityTenant, call: { dataClass: string }) => {
      if (call.dataClass === 'restricted') return { result: 'denied', code: 'EGRESS_DENIED' };
      calls += 1;
      return { result: 'answered' };
    },
    callsReceived: async () => calls,
  };
  return seam as unknown as ParitySeams['modelSupply'];
};

const goodActions = () =>
  ({
    sendApproved: async (_: ParityTenant, behaviour: string) =>
      behaviour === 'accepts' ? { status: 'sent', effects: 1 } : { status: 'unknown', effects: 1 },
    changeRecipientAfterApproval: async () => ({ approval: 'cancelled', effects: 0 }),
    replayWebhook: async () => ({ accepted: 1, effects: 1 }),
  }) as unknown as ParitySeams['externalActions'];

describe('the boundary file', () => {
  it('implements exactly its catalog IDs', () => {
    expect(captured.file).toBe('boundary');
    expect(Object.keys(captured.scenarios).sort()).toEqual(
      PARITY_CATALOG.filter((spec) => spec.file === 'boundary')
        .map((spec) => spec.id)
        .sort(),
    );
  });

  it.each(SEAM_SCENARIOS)('%s reports an unplugged seam before any setup', async (id) => {
    const { context, tenant } = contextWith({});
    await expect(run(id, context)).rejects.toBeInstanceOf(SeamNotWired);
    expect(tenant).not.toHaveBeenCalled();
  });

  it('PAR-SEC-04 passes on a good supply, with a comparable observation', async () => {
    const { context } = contextWith({ modelSupply: goodModels() });
    const seen = (await run('PAR-SEC-04', context)) as Observation;
    expect(identifiersIn(seen)).toEqual([]);
    expect(seen).toMatchObject({ callsAddedByRefusals: 0, callsAddedByControls: 2 });
  });

  it('PAR-SEC-04 fails when a refused call still reached the provider', async () => {
    const models = goodModels();
    const leaky = {
      ...models,
      callsReceived: (() => {
        let n = 0;
        return async () => (n += 1);
      })(),
    };
    await expect(
      run('PAR-SEC-04', contextWith({ modelSupply: leaky }).context),
    ).rejects.toThrow();
  });

  it('PAR-SEC-04 fails when restricted data is answered', async () => {
    const models = goodModels();
    const open = { ...models, invoke: async () => ({ result: 'answered' as const }) };
    await expect(run('PAR-SEC-04', contextWith({ modelSupply: open }).context)).rejects.toThrow();
  });

  it('PAR-SEC-04 fails when the fake was never reachable', async () => {
    const models = goodModels();
    const dead = { ...models, callsReceived: async () => 0 };
    await expect(run('PAR-SEC-04', contextWith({ modelSupply: dead }).context)).rejects.toThrow();
  });

  it.each(['PAR-ACT-01', 'PAR-ACT-02', 'PAR-ACT-03'])('%s passes on good actions', async (id) => {
    const seen = (await run(
      id,
      contextWith({ externalActions: goodActions() }).context,
    )) as Observation;
    expect(identifiersIn(seen)).toEqual([]);
  });

  it.each([
    ['PAR-ACT-01', { changeRecipientAfterApproval: async () => ({ approval: 'approved', effects: 0 }) }],
    ['PAR-ACT-01', { changeRecipientAfterApproval: async () => ({ approval: 'cancelled', effects: 1 }) }],
    ['PAR-ACT-01', { sendApproved: async () => ({ status: 'sent', effects: 0 }) }],
    ['PAR-ACT-02', { sendApproved: async () => ({ status: 'sent', effects: 1 }) }],
    ['PAR-ACT-02', { sendApproved: async () => ({ status: 'unknown', effects: 2 }) }],
    ['PAR-ACT-03', { replayWebhook: async () => ({ accepted: 2, effects: 1 }) }],
    ['PAR-ACT-03', { replayWebhook: async () => ({ accepted: 1, effects: 2 }) }],
  ])('%s refuses a wrong answer %#', async (id, wrong) => {
    const seam = { ...goodActions(), ...wrong } as unknown as ParitySeams['externalActions'];
    await expect(run(id, contextWith({ externalActions: seam }).context)).rejects.toThrow();
  });
});
