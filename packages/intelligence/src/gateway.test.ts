// MODEL-03, SEC-01, COMM-02, FD-8. The order is the control: a wrong one sends data and logs a denial afterwards.
// So each test here says exactly which ports were reached, in order, and that nothing later was. The model is
// scripted and obeys everything, so what these prove is the gateway and not a model's good sense.
import type { AgentContext, Tx } from '@ensemus/application/ai-ports';
import type { RoutableProfile } from '@ensemus/application/ai-ports';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keyShapedText, pemShapedText, tenantCanary } from '../../../tests/helpers/ai/canaries';
import { FALLBACK_ATTEMPT_STRIDE, createInferenceGateway, type GatewayDeps } from './gateway';
import {
  agentContext,
  byomProfile,
  compiled as compiledTurn,
  entitlements,
  FakeLedger,
  FakeProfileStore,
  generatedKey,
  guard,
  haltCheck,
  localProfile,
  LoggedAdapter,
  LoggedLender,
  managedProfile,
  message,
  RecordingEgress,
  REQUEST_HASH,
  rateCard,
  step,
  task,
  turnStore,
} from './router/doubles.test-support';
import { createModelRouter } from './router/index';
import type { ScriptStep } from './testing/scripted-adapter';
import type { CompiledTurn, VerifiedEndpoint } from './types';
import { ceilingFor, costOf } from './router/cost';

// endpoint.ts is the transport slice's, and is tested there. Here it is one more stage in the order, so
// this double says yes to everything but one address, whatever state that slice is in.
vi.mock('@ensemus/policy/endpoint', () => ({
  checkEndpoint: (_kind: string, url: string) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'refused.example.invalid') {
      return { ok: false, code: 'MODEL_ENDPOINT_NOT_ALLOWED' };
    }
    return {
      ok: true,
      host: parsed.hostname,
      port: Number(parsed.port) || 443,
      viaPrivateAllowlist: parsed.protocol === 'http:',
    };
  },
}));

const FULL_ORDER = [
  'entitlements.check',
  'ledger.headroom',
  'profiles.listCandidates',
  'profiles.latestRateCard',
  'egress.record',
  'tx.open',
  'halt.assertRunning',
  'ledger.reserve',
  'tx.close',
  'canaries',
  'guard.fetchFor',
  'credentials.withKey',
  'adapter.generate',
  'tx.open',
  'ledger.settle',
  'ledger.record',
  'ledger.record',
  'tx.close',
  'turns.bindProfile',
];

/** Up to and including the row that says this data may leave. */
const THROUGH_EGRESS = FULL_ORDER.slice(0, 5);
const THROUGH_RESERVATION = FULL_ORDER.slice(0, 9);
const RELEASED = ['tx.open', 'ledger.release', 'tx.close'];

type Options = {
  profiles?: readonly RoutableProfile[];
  script?: readonly ScriptStep[];
  canaries?: () => Promise<readonly string[]>;
  deps?: Partial<GatewayDeps>;
  halted?: () => boolean;
  bindRefused?: () => boolean;
};

function setup(options: Options = {}) {
  const log: string[] = [];
  let openTx = 0;
  const key = generatedKey();
  const store = new FakeProfileStore(log, options.profiles ?? [byomProfile()]);
  const egress = new RecordingEgress(log);
  const ledger = new FakeLedger(log);
  const adapter = new LoggedAdapter(
    log,
    options.script ?? [{ kind: 'final', text: 'Done.' }],
    () => openTx,
  );
  const lender = new LoggedLender(log, key);
  const turns = turnStore(log, options.bindRefused);
  const endpoints: VerifiedEndpoint[] = [];
  const router = createModelRouter({ profiles: store, egress });
  const deps: GatewayDeps = {
    entitlements: entitlements(log),
    ledger,
    withTx: async <T>(_context: AgentContext, fn: (tx: Tx) => Promise<T>) => {
      log.push('tx.open');
      openTx += 1;
      try {
        return await fn({} as Tx);
      } finally {
        openTx -= 1;
        log.push('tx.close');
      }
    },
    router,
    egress,
    guard: guard(log, endpoints),
    credentials: lender,
    adapter,
    turns,
    halt: haltCheck(log, options.halted),
    privateEndpoints: [],
    canaries: async () => {
      log.push('canaries');
      return options.canaries ? options.canaries() : [];
    },
    ...options.deps,
  };
  const gateway = createInferenceGateway(deps);
  const run = (compiled: CompiledTurn = compiledTurn(), signal = new AbortController().signal) =>
    gateway.turn(agentContext(), step, compiled, signal);
  return { log, key, store, egress, ledger, adapter, lender, turns, endpoints, run };
}

/** What every denial must hold to: no model hit, no key asked for. */
function expectNothingLeft(harness: ReturnType<typeof setup>) {
  expect(harness.adapter.hits).toBe(0);
  expect(harness.lender.asked).toHaveLength(0);
}

const internal = (overrides: Partial<CompiledTurn> = {}) =>
  compiledTurn({
    task: task({ classification: 'internal' }),
    messages: [message({ classification: 'internal' })],
    ...overrides,
  });

const pinnedTo = (profileId: string, profileVersion = 1) =>
  compiledTurn({ task: task({ pinned: { profileId, profileVersion } }) });

describe('the fixed order (FD-8)', () => {
  it('refuses freshly exhausted run headroom before a reservation, key or provider call', async () => {
    const admit = vi.fn<NonNullable<GatewayDeps['admitInTx']>>(async () => 'BUDGET_EXHAUSTED');
    const harness = setup({ deps: { admitInTx: admit } }),
      result = await harness.run();
    expect(result).toMatchObject({ outcome: 'budget_exhausted', stopCode: 'BUDGET_EXHAUSTED' });
    expect(admit).toHaveBeenCalledTimes(1);
    expectNothingLeft(harness);
    expect(harness.log).not.toContain('ledger.reserve');
  });
  it('rechecks current input authority after key lending and releases an unsent hold on refusal', async () => {
    const admit = vi
      .fn<NonNullable<GatewayDeps['admitInTx']>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue('CLASS_DENIED');
    const harness = setup({ deps: { admitInTx: admit } }),
      result = await harness.run();
    expect(result).toMatchObject({ outcome: 'policy_denied', decisionCode: 'CLASS_DENIED' });
    expect(admit).toHaveBeenCalledTimes(2);
    expect(harness.adapter.hits).toBe(0);
    expect(harness.log).toContain('ledger.release');
    expect(harness.log).not.toContain('ledger.record');
  });
  it('prepares the full input identity before money and claims it once before dispatch, then records a validated result after charging', async () => {
    const phases: string[] = [];
    const inputs: Parameters<NonNullable<GatewayDeps['admitInTx']>>[2][] = [];
    const admit = vi.fn<NonNullable<GatewayDeps['admitInTx']>>(async (_tx, _context, input) => {
      inputs.push(input);
      phases.push(input.snapshot?.phase ?? 'missing');
      return null;
    });
    const receive = vi.fn<NonNullable<GatewayDeps['receiveInputSnapshotInTx']>>(async () => {
      expect(harness.log).toContain('ledger.record');
      phases.push('received');
    });
    const harness = setup({ deps: { admitInTx: admit, receiveInputSnapshotInTx: receive } });
    const result = await harness.run();
    expect(phases).toEqual(['prepare', 'dispatch', 'received']);
    const prepared = inputs[0]?.snapshot,
      dispatched = inputs[1]?.snapshot;
    expect(prepared?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(dispatched).toEqual({ ...prepared, phase: 'dispatch' });
    expect(result.inputSnapshotId).toBe(prepared?.id);
    expect(receive.mock.calls[0]?.[2]).toMatchObject({
      snapshotId: prepared?.id,
      writerToken: prepared?.writerToken,
      kind: 'final',
      toolId: null,
    });
  });
  it('a losing duplicate attempt refuses before borrowing or releasing the original writer hold', async () => {
    let winner: string | undefined;
    const admit = vi.fn<NonNullable<GatewayDeps['admitInTx']>>(async (_tx, _context, input) => {
      if (input.snapshot?.phase === 'prepare') {
        if (winner) return 'POLICY_UNREADABLE';
        winner = input.snapshot.writerToken;
      }
      return input.snapshot?.writerToken === winner ? null : 'POLICY_UNREADABLE';
    });
    const harness = setup({ deps: { admitInTx: admit } });
    expect((await harness.run()).outcome).toBe('final_output');
    const count = harness.log.filter((entry) => entry === 'ledger.reserve').length;
    expect((await harness.run()).decisionCode).toBe('POLICY_UNREADABLE');
    expect(harness.log.filter((entry) => entry === 'ledger.reserve')).toHaveLength(count);
    expect(harness.log).not.toContain('ledger.release');
    expect(harness.adapter.hits).toBe(1);
  });
  it('a retained caller reference cannot change the actual prompt after its trusted snapshot hash', async () => {
    const input = message({ text: 'Original actual material' });
    const harness = setup({
      canaries: async () => {
        input.text = 'Later caller mutation';
        return [];
      },
    });
    expect((await harness.run(compiledTurn({ messages: [input] }))).outcome).toBe('final_output');
    expect(harness.adapter.calls[0]?.messages[0]?.text).toBe('Original actual material');
  });
  it('unknown paid responses never acquire a child-input result receipt', async () => {
    const receive = vi.fn<NonNullable<GatewayDeps['receiveInputSnapshotInTx']>>();
    const harness = setup({
      script: [{ kind: 'failure', failure: 'unknown', mayHaveBilled: true }],
      deps: { receiveInputSnapshotInTx: receive },
    });
    const result = await harness.run();
    expect(result.inputSnapshotId).toBeUndefined();
    expect(receive).not.toHaveBeenCalled();
    expect(harness.log).toContain('ledger.record');
  });
  it('a refused result receipt discards content after charge without releasing or resending the paid attempt', async () => {
    const receive = vi.fn<NonNullable<GatewayDeps['receiveInputSnapshotInTx']>>(async () => {
      throw new Error('TEST_RESULT_FENCED');
    });
    const harness = setup({ deps: { receiveInputSnapshotInTx: receive } });
    await expect(harness.run()).rejects.toThrow('TEST_RESULT_FENCED');
    expect(harness.adapter.hits).toBe(1);
    expect(harness.log).toContain('ledger.settle');
    expect(harness.log).not.toContain('ledger.release');
  });
  it('includes actual evidence-role fences and full tool/schema framing in the conservative money envelope', () => {
    const input = {
      messages: [message({ role: 'evidence', text: 'Generated evidence' })],
      tools: [
        {
          id: 'work.read',
          version: '1',
          description: 'Generated tool',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ],
      responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      maxOutputTokens: 31,
      modelId: 'generated-model',
    };
    const ceiling = ceilingFor(input);
    const oldTextOnly =
      Buffer.byteLength(input.messages[0]!.text) +
      Buffer.byteLength(JSON.stringify(input.tools)) +
      Buffer.byteLength(JSON.stringify(input.responseSchema));
    expect(ceiling.inputTokens).toBeGreaterThan(oldTextOnly);
    expect(ceiling.outputTokens).toBe(31);
    expect(
      costOf(
        { inputTokens: ceiling.inputTokens, outputTokens: 31 },
        rateCard('generated', { inputMicrosPerMtok: 1000000, outputMicrosPerMtok: 1000000 }),
      ).totalMicros,
    ).toBe(ceiling.inputTokens + 31);
    expect(() =>
      costOf(
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
        rateCard('generated', {
          inputMicrosPerMtok: Number.MAX_SAFE_INTEGER,
          outputMicrosPerMtok: 1,
        }),
      ),
    ).toThrow();
  });
  it('runs every stage, in order, on a clean turn', async () => {
    const harness = setup();
    const outcome = await harness.run();
    expect(harness.log).toEqual(FULL_ORDER);
    expect(outcome).toEqual({
      outcome: 'final_output',
      stopCode: null,
      decisionCode: 'ALLOWED',
      usage: { inputTokens: 10, outputTokens: 5, costMicros: 20 },
      profile: { id: 'byom', version: 1 },
      text: 'Done.',
      toolCall: null,
    });
  });

  it('holds no transaction across the model call', async () => {
    const harness = setup();
    await harness.run();
    expect(harness.adapter.hits).toBe(1);
    expect(harness.adapter.sawOpenTransaction).toBe(false);
  });

  it('hands the adapter what was compiled, the guarded fetch and the lent key', async () => {
    const harness = setup();
    await harness.run();
    expect(harness.adapter.calls[0]).toMatchObject({
      providerKind: 'openai_compatible',
      modelId: 'test-model',
      endpointUrl: 'https://byom.example.invalid/v1',
      maxOutputTokens: 200,
      timeoutMs: 1_000,
    });
    expect(harness.adapter.calls[0]?.apiKey?.equals(harness.key)).toBe(true);
    expect(harness.endpoints).toEqual([
      {
        host: 'byom.example.invalid',
        port: 443,
        protocol: 'https:',
        viaPrivateAllowlist: false,
      },
    ]);
    expect(harness.lender.asked).toEqual([
      expect.objectContaining({
        profileId: 'byom',
        secretRef: 'secret-byom',
        endpointUrl: 'https://byom.example.invalid/v1',
        providerKind: 'openai_compatible',
      }),
    ]);
  });

  it('asks the halt check about this agent version and this provider', async () => {
    const assertRunning = vi.fn(async () => {});
    const harness = setup({ deps: { halt: { assertRunning } } });
    await harness.run();
    expect(assertRunning).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      agentVersionId: 'version-1',
      providerKind: 'openai_compatible',
    });
  });
});

describe('it stops at each stage, with zero later calls', () => {
  it('an aborted turn does nothing at all', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = setup();
    const outcome = await harness.run(compiledTurn(), controller.signal);
    expect(outcome.outcome).toBe('stopped');
    expect(harness.log).toEqual([]);
  });

  it('entitlement denied', async () => {
    const log: string[] = [];
    const harness = setup({
      deps: {
        entitlements: {
          async check() {
            log.push('entitlements.check');
            return { ok: false, code: 'ENTITLEMENT_DENIED' };
          },
        },
      },
    });
    const outcome = await harness.run();
    expect(log).toEqual(['entitlements.check']);
    expect(harness.log).toEqual([]);
    expect(outcome).toMatchObject({
      outcome: 'policy_denied',
      stopCode: 'ENTITLEMENT_DENIED',
      decisionCode: 'ENTITLEMENT_DENIED',
      text: null,
      toolCall: null,
    });
  });

  it('entitlement unreadable', async () => {
    const harness = setup({
      deps: {
        entitlements: {
          async check() {
            throw new Error('unreadable');
          },
        },
      },
    });
    expect(await harness.run()).toMatchObject({ decisionCode: 'POLICY_UNREADABLE' });
    expect(harness.log).toEqual([]);
  });

  it('no budget configured', async () => {
    const harness = setup();
    harness.ledger.available = null;
    expect(await harness.run()).toMatchObject({
      outcome: 'budget_exhausted',
      stopCode: 'BUDGET_NOT_CONFIGURED',
    });
    expect(harness.log).toEqual(FULL_ORDER.slice(0, 2));
  });

  it('no headroom left', async () => {
    const harness = setup();
    harness.ledger.available = 0;
    expect(await harness.run()).toMatchObject({
      outcome: 'budget_exhausted',
      stopCode: 'BUDGET_EXHAUSTED',
    });
    expect(harness.log).toEqual(FULL_ORDER.slice(0, 2));
  });

  it('headroom unreadable', async () => {
    const harness = setup();
    harness.ledger.headroomThrows = true;
    expect(await harness.run()).toMatchObject({ decisionCode: 'POLICY_UNREADABLE' });
    expect(harness.log).toEqual(FULL_ORDER.slice(0, 2));
  });

  it('no candidate', async () => {
    const harness = setup({ profiles: [] });
    expect(await harness.run()).toMatchObject({
      outcome: 'model_unavailable',
      stopCode: 'MODEL_UNAVAILABLE',
      decisionCode: 'NO_CANDIDATE',
    });
    expect(harness.log).toEqual([...FULL_ORDER.slice(0, 3), 'egress.record']);
    expect(harness.egress.rows).toHaveLength(1);
  });

  it('a capability missing', async () => {
    const harness = setup({ profiles: [byomProfile({ capabilities: ['text'] })] });
    const outcome = await harness.run(compiledTurn({ task: task({ required: ['vision'] }) }));
    expect(outcome).toMatchObject({
      outcome: 'model_unavailable',
      decisionCode: 'CAPABILITY_MISSING',
    });
    expectNothingLeft(harness);
    expect(harness.ledger.reservations).toHaveLength(0);
  });

  it('egress denied: reserves nothing and opens no key', async () => {
    const harness = setup();
    const outcome = await harness.run(
      compiledTurn({ task: task({ requiredRegion: 'somewhere-else' }) }),
    );
    expect(outcome).toMatchObject({
      outcome: 'policy_denied',
      stopCode: 'POLICY_DENIED',
      decisionCode: 'WRONG_REGION',
    });
    expect(harness.log).toEqual([...FULL_ORDER.slice(0, 3), 'egress.record']);
    expect(harness.ledger.reservations).toHaveLength(0);
    expectNothingLeft(harness);
  });

  it('no rate card: reserves nothing', async () => {
    const harness = setup();
    harness.store.rates.delete('byom');
    expect(await harness.run()).toMatchObject({
      outcome: 'budget_exhausted',
      stopCode: 'RATE_CARD_MISSING',
    });
    expect(harness.ledger.reservations).toHaveLength(0);
    expectNothingLeft(harness);
  });

  it('a decision that cannot be recorded stops the call', async () => {
    const harness = setup();
    harness.egress.fail = true;
    expect(await harness.run()).toMatchObject({
      outcome: 'policy_denied',
      decisionCode: 'POLICY_UNREADABLE',
    });
    expect(harness.ledger.reservations).toHaveLength(0);
    expectNothingLeft(harness);
  });

  it('a router that throws stops the call', async () => {
    const harness = setup({
      deps: {
        router: {
          select() {
            return Promise.reject(new Error('down'));
          },
        },
      },
    });
    expect(await harness.run()).toMatchObject({ decisionCode: 'POLICY_UNREADABLE' });
    expectNothingLeft(harness);
  });

  it('halted: rolled back, so nothing is reserved', async () => {
    const harness = setup({ halted: () => true });
    expect(await harness.run()).toMatchObject({
      outcome: 'stopped',
      stopCode: 'HALTED',
      decisionCode: 'HALTED',
    });
    expect(harness.log).toEqual([...THROUGH_EGRESS, 'tx.open', 'halt.assertRunning', 'tx.close']);
    expect(harness.ledger.reservations).toHaveLength(0);
    expectNothingLeft(harness);
  });

  it('a transaction that cannot open is not a pass', async () => {
    const harness = setup({
      deps: {
        withTx() {
          return Promise.reject(new Error('no connection'));
        },
      },
    });
    expect(await harness.run()).toMatchObject({ decisionCode: 'POLICY_UNREADABLE' });
    expectNothingLeft(harness);
  });

  it('the reservation refused', async () => {
    const harness = setup();
    harness.ledger.reservation = { ok: false, code: 'BUDGET_EXHAUSTED' };
    expect(await harness.run()).toMatchObject({
      outcome: 'budget_exhausted',
      stopCode: 'BUDGET_EXHAUSTED',
    });
    expect(harness.log).toEqual(THROUGH_RESERVATION);
    expectNothingLeft(harness);
  });

  it('canaries unreadable: the scan cannot run, so nothing is sent, and the hold is released', async () => {
    const harness = setup({
      canaries: () => Promise.reject(new Error('unreadable')),
    });
    expect(await harness.run()).toMatchObject({ decisionCode: 'POLICY_UNREADABLE' });
    expect(harness.log).toEqual([...THROUGH_RESERVATION, 'canaries', ...RELEASED]);
    expectNothingLeft(harness);
  });

  it('the endpoint refused: recorded, released, and no key asked for', async () => {
    const harness = setup({
      profiles: [byomProfile({ endpointUrl: 'https://refused.example.invalid/v1' })],
    });
    expect(await harness.run()).toMatchObject({
      outcome: 'policy_denied',
      decisionCode: 'PROFILE_NOT_QUALIFIED',
    });
    expect(harness.log).toEqual([...THROUGH_RESERVATION, 'canaries', 'egress.record', ...RELEASED]);
    expect(harness.egress.rows.at(-1)).toMatchObject({
      decision: 'deny',
      reasonCode: 'PROFILE_NOT_QUALIFIED',
      stepId: 'step-1',
      requestHash: REQUEST_HASH,
    });
    expectNothingLeft(harness);
  });

  it('a guard that refuses is the same as a refused endpoint', async () => {
    const harness = setup({
      deps: {
        guard: {
          fetchFor() {
            throw new Error('no');
          },
        },
      },
    });
    expect(await harness.run()).toMatchObject({ decisionCode: 'PROFILE_NOT_QUALIFIED' });
    expectNothingLeft(harness);
  });

  it('aborted just before the key: released, and no key asked for', async () => {
    const controller = new AbortController();
    const harness = setup({
      deps: {
        guard: {
          fetchFor() {
            controller.abort();
            return (() => {
              throw new Error('This test reaches no network.');
            }) as unknown as typeof fetch;
          },
        },
      },
    });
    const outcome = await harness.run(compiledTurn(), controller.signal);
    expect(outcome.outcome).toBe('stopped');
    expect(harness.ledger.released).toEqual(['reservation-1']);
    expectNothingLeft(harness);
  });

  it('the key refused: nothing sent, nothing owed', async () => {
    const harness = setup();
    harness.lender.fail = 'before';
    expect(await harness.run()).toMatchObject({
      outcome: 'credential_unavailable',
      stopCode: 'CREDENTIAL_UNAVAILABLE',
      usage: { costMicros: 0 },
    });
    expect(harness.adapter.hits).toBe(0);
    expect(harness.ledger.released).toEqual(['reservation-1']);
    expect(harness.ledger.entries).toHaveLength(0);
  });

  it('a release that fails does not hide why the turn stopped', async () => {
    const harness = setup({
      profiles: [byomProfile({ endpointUrl: 'https://refused.example.invalid/v1' })],
    });
    harness.ledger.releaseThrows = true;
    expect(await harness.run()).toMatchObject({ decisionCode: 'PROFILE_NOT_QUALIFIED' });
    expectNothingLeft(harness);
  });

  it('a schema that cannot compile stops before anything is held or paid for', async () => {
    const harness = setup();
    const outcome = await harness.run(compiledTurn({ responseSchema: { type: 'not-a-type' } }));
    expect(outcome).toMatchObject({ outcome: 'invalid_output', stopCode: 'INVALID_OUTPUT' });
    expect(harness.ledger.reservations).toHaveLength(0);
    expectNothingLeft(harness);
  });
});

describe('keys', () => {
  it('a model the customer runs needs none, and no key is asked for', async () => {
    const harness = setup({ profiles: [localProfile()] });
    expect((await harness.run()).outcome).toBe('final_output');
    expect(harness.lender.asked).toHaveLength(0);
    expect(harness.adapter.calls[0]?.apiKey).toBeNull();
  });

  it('a local model with a key on file uses it', async () => {
    const harness = setup({ profiles: [localProfile({ secretRef: 'secret-local' })] });
    await harness.run();
    expect(harness.lender.asked).toHaveLength(1);
  });

  it('an outside provider with no key on file is not sent to without one', async () => {
    const harness = setup({ profiles: [byomProfile({ secretRef: null })] });
    expect(await harness.run()).toMatchObject({
      outcome: 'credential_unavailable',
      stopCode: 'CREDENTIAL_UNAVAILABLE',
    });
    expect(harness.adapter.hits).toBe(0);
    expect(harness.ledger.released).toEqual(['reservation-1']);
  });

  it('a key never reaches an outcome, a row or a ledger entry', async () => {
    const harness = setup();
    const outcome = await harness.run();
    const everything = JSON.stringify([outcome, harness.egress.rows, harness.ledger.entries]);
    expect(everything).not.toContain(harness.key.toString('hex'));
    expect(everything).not.toContain(harness.key.toString('base64'));
  });

  it('a lender that fails after the call does not lose what the call cost', async () => {
    const harness = setup();
    harness.lender.fail = 'after';
    expect((await harness.run()).outcome).toBe('final_output');
    expect(harness.ledger.entries).toHaveLength(2);
  });
});

describe('mixed classes', () => {
  it('takes the strongest in the messages, over what the task said', async () => {
    const harness = setup();
    const outcome = await harness.run(
      compiledTurn({
        task: task({ classification: 'public' }),
        messages: [
          message({ partId: 'a', classification: 'public' }),
          message({ partId: 'b', classification: 'restricted' }),
        ],
      }),
    );
    expect(outcome).toMatchObject({ outcome: 'policy_denied', decisionCode: 'CLASS_DENIED' });
    expect(harness.egress.rows[0]).toMatchObject({ dataClass: 'restricted' });
    expectNothingLeft(harness);
  });

  it('never lowers what the task said', async () => {
    const harness = setup();
    await harness.run(
      compiledTurn({
        task: task({ classification: 'confidential' }),
        messages: [message({ classification: 'public' })],
      }),
    );
    expect(harness.egress.rows[0]).toMatchObject({ dataClass: 'confidential' });
    expectNothingLeft(harness);
  });
});

describe('what a turn needs comes along, so it cannot be dropped', () => {
  const tool = { id: 'work.read', version: '1', description: 'Reads work.', parameters: {} };

  it('tools need the tools capability', async () => {
    const harness = setup({ profiles: [byomProfile({ capabilities: ['text'] })] });
    const outcome = await harness.run(compiledTurn({ tools: [tool] }));
    expect(outcome).toMatchObject({ decisionCode: 'CAPABILITY_MISSING' });
    expectNothingLeft(harness);
  });

  it('a response schema needs structured output', async () => {
    const harness = setup({ profiles: [byomProfile({ capabilities: ['text'] })] });
    const outcome = await harness.run(compiledTurn({ responseSchema: { type: 'object' } }));
    expect(outcome).toMatchObject({ decisionCode: 'CAPABILITY_MISSING' });
    expectNothingLeft(harness);
  });

  it('asks for no more output than the profile allows', async () => {
    const harness = setup({
      profiles: [byomProfile({ limits: { maxInputTokens: 4096, maxOutputTokens: 50 } })],
    });
    await harness.run(compiledTurn({ maxOutputTokens: 5_000 }));
    expect(harness.adapter.calls[0]?.maxOutputTokens).toBe(50);
  });
});

describe('the pre-send scan (SEC-13, QA-018)', () => {
  const plain = (text: string) =>
    compiledTurn({ messages: [message({ text, classification: 'public' })] });

  for (const [name, make] of [
    ['a key', keyShapedText],
    ['a PEM block', pemShapedText],
  ] as const) {
    it(`${name} in a document stops the call, after the reservation and before the key`, async () => {
      const harness = setup();
      const secret = make();
      const outcome = await harness.run(plain(`Here is the file. ${secret}`));
      expect(outcome).toMatchObject({
        outcome: 'policy_denied',
        stopCode: 'POLICY_DENIED',
        decisionCode: 'SECRET_FOUND_IN_PAYLOAD',
      });
      expect(harness.log).toEqual([
        ...THROUGH_RESERVATION,
        'canaries',
        'egress.record',
        ...RELEASED,
      ]);
      expectNothingLeft(harness);
      expect(JSON.stringify([outcome, harness.egress.rows])).not.toContain(secret);
    });
  }

  it('a tenant canary stops the call', async () => {
    const canary = tenantCanary();
    const harness = setup({ canaries: async () => [canary] });
    const outcome = await harness.run(plain(`Marked ${canary} text.`));
    expect(outcome.decisionCode).toBe('SECRET_FOUND_IN_PAYLOAD');
    expectNothingLeft(harness);
    expect(JSON.stringify(harness.egress.rows)).not.toContain(canary);
  });

  it('records the second decision against this step and request, as restricted', async () => {
    const harness = setup();
    await harness.run(plain(keyShapedText()));
    expect(harness.egress.rows).toEqual([
      expect.objectContaining({ decision: 'allow', dataClass: 'public', stepId: null }),
      expect.objectContaining({
        decision: 'deny',
        reasonCode: 'SECRET_FOUND_IN_PAYLOAD',
        dataClass: 'restricted',
        stepId: 'step-1',
        requestHash: REQUEST_HASH,
      }),
    ]);
  });

  it('a decision it cannot record stops the call all the same', async () => {
    const harness = setup();
    const originalRecord = harness.egress.record.bind(harness.egress);
    let writes = 0;
    harness.egress.record = async (context, entry) => {
      writes += 1;
      if (writes > 1) throw new Error('could not write');
      return originalRecord(context, entry);
    };
    expect(await harness.run(plain(keyShapedText()))).toMatchObject({
      decisionCode: 'POLICY_UNREADABLE',
    });
    expect(harness.ledger.released).toEqual(['reservation-1']);
    expectNothingLeft(harness);
  });

  it('a private model that lists restricted may still take it, as restricted', async () => {
    const harness = setup({
      profiles: [
        localProfile({ allowedClasses: ['public', 'internal', 'confidential', 'restricted'] }),
      ],
    });
    const outcome = await harness.run(plain(keyShapedText()));
    expect(outcome.outcome).toBe('final_output');
    expect(harness.adapter.calls[0]?.messages[0]?.classification).toBe('restricted');
    expect(harness.egress.rows.at(-1)).toMatchObject({
      decision: 'allow',
      dataClass: 'restricted',
    });
  });

  it('a private model that does not list restricted is denied', async () => {
    const harness = setup({ profiles: [localProfile()] });
    const outcome = await harness.run(plain(keyShapedText()));
    expect(outcome.decisionCode).toBe('SECRET_FOUND_IN_PAYLOAD');
    expectNothingLeft(harness);
  });

  it('the decision after a hit applies the tenant bundle', async () => {
    const harness = setup({
      profiles: [
        localProfile({ allowedClasses: ['public', 'internal', 'confidential', 'restricted'] }),
      ],
      deps: {
        bundle: async () => ({
          version: '7',
          denyClasses: { customer_private_inference: ['restricted'] },
        }),
      },
    });
    const outcome = await harness.run(plain(keyShapedText()));
    expect(outcome.decisionCode).toBe('SECRET_FOUND_IN_PAYLOAD');
    expectNothingLeft(harness);
  });

  it('leaves clean text alone', async () => {
    const harness = setup();
    await harness.run(plain('A clean document.'));
    expect(harness.adapter.calls[0]?.messages[0]?.classification).toBe('public');
    expect(harness.egress.rows).toHaveLength(1);
  });
});

describe('validating what came back', () => {
  const tool = { id: 'work.read', version: '1', description: 'Reads work.', parameters: {} };

  it('hands on a tool call for a tool on the list, unvalidated', async () => {
    const harness = setup({
      script: [{ kind: 'tool_call', toolId: 'work.read', args: { id: 'x' } }],
    });
    expect(await harness.run(compiledTurn({ tools: [tool] }))).toMatchObject({
      outcome: 'tool_proposed',
      text: null,
      toolCall: { toolId: 'work.read', args: { id: 'x' } },
    });
  });

  it('refuses a tool call naming anything outside the list', async () => {
    const harness = setup({
      script: [{ kind: 'tool_call', toolId: 'secrets.read', args: {} }],
    });
    expect(await harness.run(compiledTurn({ tools: [tool] }))).toMatchObject({
      outcome: 'invalid_output',
      stopCode: 'INVALID_OUTPUT',
      decisionCode: 'TOOL_UNKNOWN',
      toolCall: null,
    });
  });

  it('refuses any tool call when no tools were offered', async () => {
    const harness = setup({ script: [{ kind: 'tool_call', toolId: 'work.read', args: {} }] });
    expect((await harness.run()).outcome).toBe('invalid_output');
  });

  it('checks a final answer against the schema', async () => {
    const schema = {
      type: 'object',
      properties: { brief: { type: 'string' } },
      required: ['brief'],
      additionalProperties: false,
    };
    const good = setup({ script: [{ kind: 'final', text: '{"brief":"Done."}' }] });
    expect(await good.run(compiledTurn({ responseSchema: schema }))).toMatchObject({
      outcome: 'final_output',
      text: '{"brief":"Done."}',
    });
    for (const text of ['not json', '{"brief":7}', '{"brief":"x","extra":true}', '[]']) {
      const bad = setup({ script: [{ kind: 'final', text }] });
      expect(await bad.run(compiledTurn({ responseSchema: schema })), text).toMatchObject({
        outcome: 'invalid_output',
        text: null,
      });
    }
  });

  it('refuses an empty answer', async () => {
    for (const text of ['', '   \n']) {
      const harness = setup({ script: [{ kind: 'final', text }] });
      expect((await harness.run()).outcome).toBe('invalid_output');
    }
  });

  it('refuses an answer holding a canary or a key, and does not pass it on', async () => {
    const canary = tenantCanary();
    for (const text of [`The marker is ${canary}.`, `The key is ${keyShapedText()}.`]) {
      const harness = setup({
        canaries: async () => [canary],
        script: [{ kind: 'final', text }],
      });
      const outcome = await harness.run();
      expect(outcome).toMatchObject({
        outcome: 'invalid_output',
        decisionCode: 'SECRET_FOUND_IN_PAYLOAD',
        text: null,
      });
      expect(JSON.stringify(outcome)).not.toContain(canary);
    }
  });

  it('refuses tool arguments holding a canary', async () => {
    const canary = tenantCanary();
    const harness = setup({
      canaries: async () => [canary],
      script: [{ kind: 'tool_call', toolId: 'work.read', args: { query: canary } }],
    });
    expect(await harness.run(compiledTurn({ tools: [tool] }))).toMatchObject({
      outcome: 'invalid_output',
      decisionCode: 'SECRET_FOUND_IN_PAYLOAD',
      toolCall: null,
    });
  });

  it('refuses tool arguments it cannot read', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const harness = setup({
      script: [{ kind: 'tool_call', toolId: 'work.read', args: circular }],
    });
    expect((await harness.run(compiledTurn({ tools: [tool] }))).outcome).toBe('invalid_output');
  });

  it('charges for an answer it refused: it was still paid for', async () => {
    const harness = setup({ script: [{ kind: 'final', text: '' }] });
    const outcome = await harness.run();
    expect(outcome.usage.costMicros).toBe(20);
    expect(harness.ledger.settled).toEqual([{ reservationId: 'reservation-1', actualMicros: 20 }]);
    expect(harness.ledger.entries).toHaveLength(2);
  });
});

describe('the ledger (FD-6, FD-12)', () => {
  it('reserves what the call could cost, rounded up', async () => {
    const harness = setup();
    await harness.run();
    // 190 bytes of actual SDK input framing at 1 per token, plus 200 output at 2. Test-only rates.
    expect(harness.ledger.reservations).toEqual([
      {
        runId: step.runId,
        stepId: 'step-1',
        attempt: 1,
        agentVersionId: 'version-1',
        amountMicros: 590,
      },
    ]);
  });

  it('settles what it did cost, and records both meters under the keys of FD-12', async () => {
    const harness = setup();
    await harness.run();
    expect(harness.ledger.settled).toEqual([{ reservationId: 'reservation-1', actualMicros: 20 }]);
    const key = `model:${step.runId}:3:1`;
    expect(harness.ledger.entries).toEqual([
      expect.objectContaining({
        idempotencyKey: key,
        meter: 'model_input_tokens',
        quantity: 10,
        unit: 'token',
        costMicros: 10,
        status: 'final',
        rateCardId: 'rate-byom',
        rateCardVersion: 1,
        reservationId: 'reservation-1',
        workUnitId: 'work-1',
        runId: step.runId,
        stepId: 'step-1',
        profileId: 'byom',
        profileVersion: 1,
        providerKind: 'openai_compatible',
        requestHash: REQUEST_HASH,
      }),
      expect.objectContaining({
        idempotencyKey: `${key}:output`,
        meter: 'model_output_tokens',
        quantity: 5,
        costMicros: 10,
        status: 'final',
      }),
    ]);
  });

  it('the rows add up to what it settled and what the run is told', async () => {
    const harness = setup({
      script: [{ kind: 'final', text: 'Done.', usage: { inputTokens: 333, outputTokens: 777 } }],
    });
    const outcome = await harness.run();
    const sum = harness.ledger.entries.reduce((total, entry) => total + entry.costMicros, 0);
    expect(sum).toBe(outcome.usage.costMicros);
    expect(harness.ledger.settled[0]?.actualMicros).toBe(outcome.usage.costMicros);
  });

  it('rounds up, so a tiny call still costs something', async () => {
    const harness = setup({
      script: [{ kind: 'final', text: 'Done.', usage: { inputTokens: 1, outputTokens: 0 } }],
    });
    harness.store.rates.set(
      'byom',
      rateCard('byom', { inputMicrosPerMtok: 1, outputMicrosPerMtok: 1 }),
    );
    expect((await harness.run()).usage.costMicros).toBe(1);
  });

  it('no usage report: charged at the whole reservation, as an estimate', async () => {
    const harness = setup({ script: [{ kind: 'final', text: 'Done.', usage: null }] });
    harness.adapter.generate = async () => ({ kind: 'final', text: 'Done.', usage: null });
    const outcome = await harness.run();
    expect(outcome.usage.costMicros).toBe(590);
    expect(harness.ledger.settled).toEqual([{ reservationId: 'reservation-1', actualMicros: 590 }]);
    expect(harness.ledger.entries).toEqual([
      expect.objectContaining({
        idempotencyKey: `model:${step.runId}:3:1`,
        status: 'estimated',
        meter: 'model_input_tokens',
        quantity: 190,
        costMicros: 190,
      }),
      expect.objectContaining({
        idempotencyKey: `model:${step.runId}:3:1:output`,
        status: 'estimated',
        meter: 'model_output_tokens',
        quantity: 200,
        costMicros: 400,
      }),
    ]);
  });

  it('a failure that may have been billed is charged as an estimate', async () => {
    const harness = setup({
      script: [{ kind: 'failure', failure: 'timeout', mayHaveBilled: true }],
    });
    const outcome = await harness.run();
    expect(outcome).toMatchObject({
      outcome: 'model_unavailable',
      usage: { costMicros: 590 },
    });
    expect(harness.ledger.entries).toEqual([
      expect.objectContaining({ meter: 'model_input_tokens', status: 'estimated', quantity: 190, costMicros: 190 }),
      expect.objectContaining({ meter: 'model_output_tokens', status: 'estimated', quantity: 200, costMicros: 400 }),
    ]);
    expect(harness.ledger.released).toEqual([]);
  });

  it('a failure that cannot have been billed is released', async () => {
    const harness = setup({
      script: [{ kind: 'failure', failure: 'connect_failed', mayHaveBilled: false }],
    });
    const outcome = await harness.run();
    expect(outcome).toMatchObject({ outcome: 'model_unavailable', usage: { costMicros: 0 } });
    expect(harness.ledger.released).toEqual(['reservation-1']);
    expect(harness.ledger.entries).toEqual([]);
  });

  it('an adapter bug fails closed and is charged, since nobody knows what it sent', async () => {
    const harness = setup({ script: [{ kind: 'throw' }] });
    const outcome = await harness.run();
    expect(outcome).toMatchObject({ outcome: 'model_unavailable', stopCode: 'MODEL_UNAVAILABLE' });
    expect(outcome.usage.costMicros).toBe(590);
    expect(JSON.stringify(outcome)).not.toContain('scripted bug');
  });

  it('a ledger write that fails after the call throws, so the retry charges it (FD-12)', async () => {
    const harness = setup();
    harness.ledger.settleThrows = true;
    await expect(harness.run()).rejects.toThrow();
    expect(harness.adapter.hits).toBe(1);
    expect(harness.turns.bound).toEqual([]);
  });
});

describe('cancelling', () => {
  it('a call in flight stops, and is charged, since it may have been billed', async () => {
    const controller = new AbortController();
    const harness = setup({ script: [{ kind: 'hang' }] });
    const pending = harness.run(compiledTurn(), controller.signal);
    await vi.waitFor(() => expect(harness.adapter.hits).toBe(1));
    controller.abort();
    const outcome = await pending;
    expect(outcome.outcome).toBe('stopped');
    expect(harness.ledger.entries[0]).toMatchObject({ status: 'estimated' });
  });

  it('does not fall back once cancelled', async () => {
    const controller = new AbortController();
    const harness = setup({
      profiles: [
        byomProfile({ fallbackProfileIds: ['second'] }),
        byomProfile({ id: 'second', alias: 'b' }),
      ],
      script: [{ kind: 'hang' }, { kind: 'final', text: 'Should not happen.' }],
    });
    const pending = harness.run(compiledTurn(), controller.signal);
    await vi.waitFor(() => expect(harness.adapter.hits).toBe(1));
    controller.abort();
    expect((await pending).outcome).toBe('stopped');
    expect(harness.adapter.hits).toBe(1);
  });
});

describe('QA-009: a BYOM outage never reaches a cheaper Ensemus model', () => {
  const cheap = () => managedProfile({ endpointUrl: 'https://managed.example.invalid/v1' });
  const callsTo = (harness: ReturnType<typeof setup>, url: string) =>
    harness.adapter.calls.filter((call) => call.endpointUrl === url).length;

  for (const failure of ['server_error', 'timeout', 'rate_limited', 'connect_failed'] as const) {
    it(`on ${failure}: zero hits there, fail closed with MODEL_UNAVAILABLE`, async () => {
      const harness = setup({
        profiles: [byomProfile(), cheap()],
        script: [
          { kind: 'failure', failure },
          { kind: 'final', text: 'Should not happen.' },
        ],
      });
      harness.store.rates.set(
        'managed',
        rateCard('managed', { inputMicrosPerMtok: 0, outputMicrosPerMtok: 0 }),
      );
      const outcome = await harness.run(compiledTurn({ task: task({ quality: 'economy' }) }));
      expect(outcome).toMatchObject({
        outcome: 'model_unavailable',
        stopCode: 'MODEL_UNAVAILABLE',
        text: null,
      });
      expect(callsTo(harness, 'https://byom.example.invalid/v1')).toBe(1);
      expect(callsTo(harness, 'https://managed.example.invalid/v1')).toBe(0);
      expect(harness.lender.asked.map((asked) => asked.profileId)).toEqual(['byom']);
    });
  }

  it('listing it without a stored pre-approval changes nothing, and is recorded', async () => {
    const harness = setup({
      profiles: [byomProfile({ fallbackProfileIds: ['managed'] }), cheap()],
      script: [
        { kind: 'failure', failure: 'server_error' },
        { kind: 'final', text: 'No.' },
      ],
    });
    const outcome = await harness.run();
    expect(outcome).toMatchObject({
      outcome: 'model_unavailable',
      decisionCode: 'FALLBACK_NOT_ALLOWED',
    });
    expect(callsTo(harness, 'https://managed.example.invalid/v1')).toBe(0);
    expect(harness.egress.rows.at(-1)).toMatchObject({
      profileId: 'managed',
      decision: 'deny',
      reasonCode: 'BILLING_OWNER_CROSSED',
    });
  });

  it('control: with a stored pre-approval the same call does go there, so the zero above means something', async () => {
    const harness = setup({
      profiles: [
        byomProfile({ fallbackProfileIds: ['managed'], crossBillingApproved: true }),
        cheap(),
      ],
      script: [
        { kind: 'failure', failure: 'server_error' },
        { kind: 'final', text: 'Fine.' },
      ],
    });
    const outcome = await harness.run();
    expect(outcome).toMatchObject({ outcome: 'final_output', profile: { id: 'managed' } });
    expect(callsTo(harness, 'https://managed.example.invalid/v1')).toBe(1);
  });

  it('a BYOM tenant with only a managed profile left active is refused and recorded', async () => {
    const harness = setup({ profiles: [cheap()] });
    const outcome = await harness.run();
    expect(outcome).toMatchObject({
      outcome: 'policy_denied',
      decisionCode: 'BILLING_OWNER_CROSSED',
    });
    expect(harness.egress.rows.at(-1)).toMatchObject({
      decision: 'deny',
      reasonCode: 'BILLING_OWNER_CROSSED',
    });
    expect(harness.ledger.reservations).toHaveLength(0);
    expectNothingLeft(harness);
  });

  it('a cloud tenant may use a managed profile', async () => {
    const harness = setup({
      profiles: [cheap()],
      deps: {
        entitlements: {
          async check() {
            return { ok: true, billable: true, commercialMode: 'cloud' };
          },
        },
      },
    });
    expect((await harness.run()).outcome).toBe('final_output');
  });
});

describe('QA-010: restricted data and an outside profile', () => {
  it('zero hits, one row, zero keys asked for', async () => {
    const harness = setup({
      profiles: [
        byomProfile({ allowedClasses: ['public', 'internal', 'confidential', 'restricted'] }),
      ],
    });
    const outcome = await harness.run(
      compiledTurn({
        task: task({ classification: 'restricted' }),
        messages: [message({ classification: 'restricted' })],
      }),
    );
    expect(outcome).toMatchObject({
      outcome: 'policy_denied',
      stopCode: 'POLICY_DENIED',
      decisionCode: 'CLASS_DENIED',
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      profile: null,
    });
    expect(harness.adapter.hits).toBe(0);
    expect(harness.egress.rows).toHaveLength(1);
    expect(harness.egress.rows[0]).toMatchObject({
      decision: 'deny',
      reasonCode: 'CLASS_DENIED',
      dataClass: 'restricted',
    });
    expect(harness.lender.asked).toHaveLength(0);
    expect(harness.ledger.reservations).toHaveLength(0);
  });
});

describe('AI-TS-02: a disallowed fallback', () => {
  it('is denied and recorded, and the turn fails closed', async () => {
    const harness = setup({
      profiles: [
        byomProfile({ fallbackProfileIds: ['elsewhere'] }),
        byomProfile({ id: 'elsewhere', alias: 'b', region: 'us' }),
      ],
      script: [
        { kind: 'failure', failure: 'server_error' },
        { kind: 'final', text: 'No.' },
      ],
    });
    const outcome = await harness.run(compiledTurn({ task: task({ requiredRegion: 'eu' }) }));
    expect(outcome).toMatchObject({
      outcome: 'model_unavailable',
      stopCode: 'MODEL_UNAVAILABLE',
      decisionCode: 'FALLBACK_NOT_ALLOWED',
    });
    expect(harness.adapter.hits).toBe(1);
    expect(harness.egress.rows.map((row) => [row.profileId, row.reasonCode])).toEqual([
      ['byom', 'ALLOWED'],
      ['elsewhere', 'WRONG_REGION'],
    ]);
  });

  it('task says no fallback: the list is not even looked at', async () => {
    const harness = setup({
      profiles: [
        byomProfile({ fallbackProfileIds: ['second'] }),
        byomProfile({ id: 'second', alias: 'b' }),
      ],
      script: [
        { kind: 'failure', failure: 'server_error' },
        { kind: 'final', text: 'No.' },
      ],
    });
    const outcome = await harness.run(compiledTurn({ task: task({ allowFallback: false }) }));
    expect(outcome.outcome).toBe('model_unavailable');
    expect(harness.adapter.hits).toBe(1);
  });
});

describe('an allowed fallback (FD-9)', () => {
  const two = () => [
    byomProfile({ fallbackProfileIds: ['second'] }),
    byomProfile({
      id: 'second',
      alias: 'b',
      endpointUrl: 'https://second.example.invalid/v1',
      secretRef: 'secret-second',
    }),
  ];

  it('goes through every stage again, and answers as the profile that served it', async () => {
    const harness = setup({
      profiles: two(),
      script: [
        { kind: 'failure', failure: 'server_error', mayHaveBilled: true },
        { kind: 'final', text: 'From the second.' },
      ],
    });
    const outcome = await harness.run();
    expect(outcome).toMatchObject({
      outcome: 'final_output',
      text: 'From the second.',
      profile: { id: 'second', version: 1 },
    });
    expect(harness.lender.asked.map((asked) => asked.profileId)).toEqual(['byom', 'second']);
    expect(harness.endpoints.map((endpoint) => endpoint.host)).toEqual([
      'byom.example.invalid',
      'second.example.invalid',
    ]);
    expect(harness.log.filter((each) => each === 'halt.assertRunning')).toHaveLength(2);
    expect(harness.log.filter((each) => each === 'canaries')).toHaveLength(1);
    expect(harness.turns.bound).toEqual([
      { runId: step.runId, profileId: 'second', profileVersion: 1 },
    ]);
  });

  it('charges each call separately, so a lost call is not hidden by the one that worked', async () => {
    const harness = setup({
      profiles: two(),
      script: [
        { kind: 'failure', failure: 'timeout', mayHaveBilled: true },
        { kind: 'final', text: 'From the second.' },
      ],
    });
    const outcome = await harness.run();
    expect(harness.ledger.reservations.map((each) => each.attempt)).toEqual([
      1,
      1 + FALLBACK_ATTEMPT_STRIDE,
    ]);
    const keys = harness.ledger.entries.map((entry) => entry.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      `model:${step.runId}:3:1`,
      `model:${step.runId}:3:1:output`,
      `model:${step.runId}:3:${1 + FALLBACK_ATTEMPT_STRIDE}`,
      `model:${step.runId}:3:${1 + FALLBACK_ATTEMPT_STRIDE}:output`,
    ]);
    expect(outcome.usage.costMicros).toBe(590 + 20);
    const sum = harness.ledger.entries.reduce((total, entry) => total + entry.costMicros, 0);
    expect(sum).toBe(outcome.usage.costMicros);
  });

  it('a credential failure moves on too, with nothing charged for it', async () => {
    const harness = setup({ profiles: two() });
    const original = harness.lender.withKey.bind(harness.lender);
    harness.lender.withKey = async (profile, use) => {
      if (profile.profileId === 'byom') throw new Error('SecretUnavailable');
      return original(profile, use);
    };
    expect(await harness.run()).toMatchObject({
      outcome: 'final_output',
      profile: { id: 'second' },
    });
    expect(harness.ledger.released).toEqual(['reservation-1']);
  });

  it('is not used for an answer that was wrong rather than missing', async () => {
    for (const failure of ['bad_request', 'context_too_long', 'unknown'] as const) {
      const harness = setup({
        profiles: two(),
        script: [
          { kind: 'failure', failure },
          { kind: 'final', text: 'No.' },
        ],
      });
      expect((await harness.run()).outcome, failure).toBe('model_unavailable');
      expect(harness.adapter.hits, failure).toBe(1);
    }
  });

  it('is not used for a malformed answer, which is invalid output', async () => {
    for (const failure of ['malformed_response', 'partial_response'] as const) {
      const harness = setup({
        profiles: two(),
        script: [
          { kind: 'failure', failure },
          { kind: 'final', text: 'No.' },
        ],
      });
      expect(await harness.run(), failure).toMatchObject({
        outcome: 'invalid_output',
        stopCode: 'INVALID_OUTPUT',
      });
      expect(harness.adapter.hits, failure).toBe(1);
    }
  });

  it('is halted like anything else', async () => {
    let checks = 0;
    const harness = setup({
      profiles: two(),
      halted: () => {
        checks += 1;
        return checks > 1;
      },
      script: [
        { kind: 'failure', failure: 'server_error' },
        { kind: 'final', text: 'No.' },
      ],
    });
    expect(await harness.run()).toMatchObject({ outcome: 'stopped', stopCode: 'HALTED' });
    expect(harness.adapter.hits).toBe(1);
  });

  it('auth failure with nothing to fall back to says so', async () => {
    const harness = setup({ script: [{ kind: 'failure', failure: 'auth_failed' }] });
    expect(await harness.run()).toMatchObject({
      outcome: 'credential_unavailable',
      stopCode: 'CREDENTIAL_UNAVAILABLE',
    });
  });

  it('a scan hit is decided again for the next entry, and denies it too', async () => {
    const privatePair = [
      localProfile({
        alias: 'a-local',
        fallbackProfileIds: ['second'],
        allowedClasses: ['public', 'internal', 'confidential', 'restricted'],
      }),
      byomProfile({ id: 'second', alias: 'b' }),
    ];
    const harness = setup({
      profiles: privatePair,
      script: [
        { kind: 'failure', failure: 'server_error' },
        { kind: 'final', text: 'No.' },
      ],
    });
    const outcome = await harness.run(
      compiledTurn({ messages: [message({ text: keyShapedText() })] }),
    );
    expect(outcome.decisionCode).toBe('SECRET_FOUND_IN_PAYLOAD');
    expect(harness.adapter.hits).toBe(1);
    expect(harness.adapter.calls[0]?.endpointUrl).toContain('model.example.invalid');
  });
});

describe('BYOM-TS-01 and FD-13: the pin', () => {
  it('the first answer pins the run to that profile and version', async () => {
    const harness = setup();
    await harness.run();
    expect(harness.turns.bound).toEqual([
      { runId: step.runId, profileId: 'byom', profileVersion: 1 },
    ]);
  });

  it('a later turn does not pin again', async () => {
    const harness = setup();
    await harness.run(pinnedTo('byom'));
    expect(harness.turns.bound).toEqual([]);
    expect(harness.adapter.hits).toBe(1);
  });

  it('no answer, no pin', async () => {
    const harness = setup({ script: [{ kind: 'failure', failure: 'server_error' }] });
    await harness.run();
    expect(harness.turns.bound).toEqual([]);
  });

  it('a pin that is refused discards the answer', async () => {
    const harness = setup({ bindRefused: () => true });
    expect(await harness.run()).toMatchObject({
      outcome: 'policy_denied',
      stopCode: 'PROFILE_CHANGED',
      text: null,
    });
    // The call happened, so it stays charged.
    expect(harness.ledger.entries).toHaveLength(2);
  });

  it('the version moves mid-run: the next turn is policy_denied, with no hit, no key and no exposure', async () => {
    const harness = setup({
      profiles: [byomProfile(), byomProfile({ id: 'other', alias: 'b' })],
      script: [
        { kind: 'final', text: 'First turn.' },
        { kind: 'final', text: 'Should not happen.' },
      ],
    });
    expect((await harness.run()).outcome).toBe('final_output');
    expect(harness.adapter.hits).toBe(1);
    expect(harness.lender.asked).toHaveLength(1);

    // A rotated key, as the trigger leaves it: a new secret_ref and a new version.
    harness.store.set([
      byomProfile({ version: 2, secretRef: 'secret-rotated' }),
      byomProfile({ id: 'other', alias: 'b' }),
    ]);
    const next = await harness.run(pinnedTo('byom', 1));
    expect(next).toMatchObject({
      outcome: 'policy_denied',
      stopCode: 'PROFILE_CHANGED',
      decisionCode: 'PROFILE_CHANGED',
      text: null,
      toolCall: null,
    });
    expect(harness.adapter.hits).toBe(1);
    expect(harness.lender.asked).toHaveLength(1);
    expect(harness.egress.rows.at(-1)).toMatchObject({
      decision: 'deny',
      reasonCode: 'PROFILE_CHANGED',
    });
    const everything = JSON.stringify([next, harness.egress.rows]);
    expect(everything).not.toContain(harness.key.toString('hex'));
    expect(everything).not.toContain('secret-rotated');
  });

  it('a pinned run’s outage fails closed, with no move to another profile', async () => {
    const harness = setup({
      profiles: [
        byomProfile({ fallbackProfileIds: ['second'] }),
        byomProfile({ id: 'second', alias: 'b' }),
      ],
      script: [
        { kind: 'failure', failure: 'server_error' },
        { kind: 'final', text: 'No.' },
      ],
    });
    expect((await harness.run(pinnedTo('byom'))).outcome).toBe('model_unavailable');
    expect(harness.adapter.hits).toBe(1);
  });

  it('provider access revoked mid-run: the next turn stops', async () => {
    const harness = setup({ profiles: [byomProfile({ status: 'disabled' })] });
    expect(await harness.run(pinnedTo('byom'))).toMatchObject({
      outcome: 'policy_denied',
      decisionCode: 'PROFILE_NOT_ACTIVE',
    });
    expectNothingLeft(harness);
  });
});

describe('FAULT-10, the routing half: a tampered endpoint', () => {
  it('a changed endpoint moved the version, so a pinned run stops before anything is opened', async () => {
    const harness = setup({
      profiles: [
        byomProfile({
          version: 2,
          status: 'draft',
          secretRef: null,
          endpointUrl: 'https://attacker.example.invalid/v1',
        }),
      ],
    });
    expect(await harness.run(pinnedTo('byom', 1))).toMatchObject({
      outcome: 'policy_denied',
      decisionCode: 'PROFILE_CHANGED',
    });
    expectNothingLeft(harness);
  });

  it('a tampered row the trigger did not catch never gets a key: the endpoint is checked first', async () => {
    const harness = setup({
      profiles: [byomProfile({ endpointUrl: 'https://refused.example.invalid/v1' })],
    });
    expect(await harness.run(pinnedTo('byom'))).toMatchObject({
      decisionCode: 'PROFILE_NOT_QUALIFIED',
    });
    expectNothingLeft(harness);
  });

  it('an address that does not parse cannot be allowed', async () => {
    const harness = setup({ profiles: [byomProfile({ endpointUrl: 'not a url' })] });
    expect(await harness.run()).toMatchObject({ decisionCode: 'UNKNOWN_INPUT' });
    expectNothingLeft(harness);
  });

  it('a scheme a guarded fetch cannot speak is refused at this stage', async () => {
    const harness = setup({
      profiles: [byomProfile({ endpointUrl: 'ftp://model.example.invalid/v1' })],
    });
    expect(await harness.run()).toMatchObject({ decisionCode: 'PROFILE_NOT_QUALIFIED' });
    expectNothingLeft(harness);
  });

  it('the lender is told the endpoint as it stands, so a key sealed for another is refused there', async () => {
    const harness = setup();
    await harness.run();
    expect(harness.lender.asked[0]?.endpointUrl).toBe('https://byom.example.invalid/v1');
  });
});

describe('internal data, end to end', () => {
  let harness: ReturnType<typeof setup>;

  beforeEach(() => {
    harness = setup();
  });

  it('is allowed to an outside provider with a region and a purpose', async () => {
    expect((await harness.run(internal())).outcome).toBe('final_output');
    expect(harness.egress.rows[0]).toMatchObject({ dataClass: 'internal', decision: 'allow' });
  });
});
