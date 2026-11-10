import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AppError } from '@ensemus/application';
import { readSecret } from '@ensemus/config';
import { openOperatorDatabase } from '@ensemus/database/operator';
import * as commands from '@ensemus/application/saas/operator-catalog';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogCommand } from './ops-catalog';

vi.mock('@ensemus/config', () => ({ readSecret: vi.fn() }));
vi.mock('@ensemus/database/operator', () => ({ openOperatorDatabase: vi.fn() }));
vi.mock('@ensemus/application/saas/operator-catalog', async (original) => ({
  ...(await original<typeof commands>()),
  draftRateCard: vi.fn(),
  approveRateCard: vi.fn(),
  draftPlanVersion: vi.fn(),
  approvePlanVersion: vi.fn(),
  publishCollectionPolicy: vi.fn(),
  publishTaxTreatment: vi.fn(),
  enterProviderBill: vi.fn(),
  reconcileProviderBill: vi.fn(),
  createProviderCostReader: vi.fn(),
}));

const folder = mkdtempSync(join(tmpdir(), 'catalog-command-'));
const resolvedFolder = resolve(folder);
afterAll(() => {
  // Only the directory this test made, checked before recursive cleanup on Windows.
  if (!resolvedFolder.startsWith(resolve(tmpdir()) + sep)) throw new Error('TEST_PATH_ESCAPED');
  rmSync(resolvedFolder, { recursive: true, force: true });
});
const fileWith = (input: unknown) => {
  const path = join(folder, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(input));
  return path;
};
const amount = '9007199254740993';
const draft = {
  operatorRef: 'test-operator@example.invalid',
  code: `test-${randomUUID()}`,
  currency: 'XTS',
  minorUnitExponent: 2,
  lines: [{ meter: 'test.units', unit: 'unit', microcreditsPerUnit: amount }],
  topUpOffers: [{ code: 'test-offer', microcredits: amount, priceMicros: amount }],
};
const close = vi.fn(async () => undefined);
const database = {} as ReturnType<typeof openOperatorDatabase>['db'];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSecret).mockReturnValue('generated-test-database-url');
  vi.mocked(openOperatorDatabase).mockReturnValue({ db: database, close });
  vi.mocked(commands.draftRateCard).mockResolvedValue({ rateCardId: randomUUID(), version: 1 });
  vi.mocked(commands.draftPlanVersion).mockResolvedValue({
    planVersionId: randomUUID(),
    version: 1,
  });
  vi.mocked(commands.publishCollectionPolicy).mockResolvedValue({
    policyId: randomUUID(),
    version: 1,
  });
  vi.mocked(commands.publishTaxTreatment).mockResolvedValue({
    treatmentId: randomUUID(),
    version: 1,
  });
  vi.mocked(commands.enterProviderBill).mockResolvedValue({ providerBillId: randomUUID() });
});

describe('the catalog operator command', () => {
  it.each(
    [
      [],
      ['anything'],
      ['draft-rate-card'],
      ['draft-rate-card', '--file', 'does-not-exist'],
      ['draft-rate-card', '--invented', 'anything'],
    ].map((args) => ({ args })),
  )('refuses malformed arguments without opening a database: $args', async ({ args }) => {
    expect(await catalogCommand(args)).toBe(2);
    expect(openOperatorDatabase).not.toHaveBeenCalled();
    expect(commands.draftRateCard).not.toHaveBeenCalled();
  });

  it.each(['01', '1.2', '-1', '1e6', '9999999999999999999', 123])(
    'refuses a bad price before reading a secret: %s',
    async (value) => {
      const file = fileWith({
        ...draft,
        lines: [{ ...draft.lines[0], microcreditsPerUnit: value }],
      });
      expect(await catalogCommand(['draft-rate-card', '--file', file])).toBe(2);
      expect(readSecret).not.toHaveBeenCalled();
      expect(openOperatorDatabase).not.toHaveBeenCalled();
    },
  );

  it('refuses a missing operator secret before touching a catalog', async () => {
    vi.mocked(readSecret).mockImplementation(() => {
      throw new Error('generated secret is unavailable');
    });
    expect(await catalogCommand(['draft-rate-card', '--file', fileWith(draft)])).toBe(2);
    expect(openOperatorDatabase).not.toHaveBeenCalled();
    expect(commands.draftRateCard).not.toHaveBeenCalled();
  });

  it('passes exact bigint values from the named file, then closes its pool', async () => {
    expect(await catalogCommand(['draft-rate-card', '--file', fileWith(draft)])).toBe(0);
    expect(readSecret).toHaveBeenCalledWith('DATABASE_URL_OPERATOR');
    expect(commands.draftRateCard).toHaveBeenCalledWith(database, {
      ...draft,
      lines: [{ ...draft.lines[0], microcreditsPerUnit: BigInt(amount) }],
      topUpOffers: [
        { ...draft.topUpOffers[0], microcredits: BigInt(amount), priceMicros: BigInt(amount) },
      ],
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps a business refusal to exit two and still closes the pool', async () => {
    vi.mocked(commands.draftRateCard).mockRejectedValue(new AppError('INVALID_INPUT'));
    expect(await catalogCommand(['draft-rate-card', '--file', fileWith(draft)])).toBe(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('leaves an unavailable database as work still to do', async () => {
    vi.mocked(commands.draftRateCard).mockRejectedValue(new Error('generated database failure'));
    expect(await catalogCommand(['draft-rate-card', '--file', fileWith(draft)])).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('parses explicit dates and refuses an invalid calendar date', async () => {
    const rateCardId = randomUUID();
    const input = {
      operatorRef: draft.operatorRef,
      rateCardId,
      effectiveFrom: '2032-06-17T09:14:37Z',
    };
    expect(await catalogCommand(['approve-rate-card', '--file', fileWith(input)])).toBe(0);
    expect(commands.approveRateCard).toHaveBeenCalledWith(database, {
      ...input,
      effectiveFrom: new Date(input.effectiveFrom),
    });
    vi.clearAllMocks();
    expect(
      await catalogCommand([
        'approve-rate-card',
        '--file',
        fileWith({ ...input, effectiveFrom: '2032-02-30T09:14:37Z' }),
      ]),
    ).toBe(2);
    expect(openOperatorDatabase).not.toHaveBeenCalled();
  });

  it('reports an explicit unresolved provider comparison as left to do', async () => {
    const providerBillId = randomUUID();
    vi.mocked(commands.createProviderCostReader).mockReturnValue({ sumProviderCost: vi.fn() });
    vi.mocked(commands.reconcileProviderBill).mockResolvedValue({
      ledgerCostMicros: 1n,
      differenceMicros: 0n,
    });
    expect(
      await catalogCommand([
        'reconcile-provider-bill',
        '--file',
        fileWith({ operatorRef: draft.operatorRef, providerBillId, decision: null }),
      ]),
    ).toBe(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'draft-plan',
      method: 'draftPlanVersion',
      input: {
        operatorRef: draft.operatorRef,
        planCode: `test-${randomUUID()}`,
        displayName: 'Test plan',
        commercialMode: 'byom',
        currency: 'XTS',
        billingInterval: 'year',
        paymentTermsDays: 0,
        minorUnitExponent: 2,
        platformFeeMicros: amount,
        includedMicrocredits: null,
        rateCardId: null,
        overagePolicy: null,
        features: ['work'],
        maxActiveMembers: null,
      },
    },
    {
      name: 'approve-plan',
      method: 'approvePlanVersion',
      input: { operatorRef: draft.operatorRef, planVersionId: randomUUID() },
    },
    {
      name: 'publish-collection-policy',
      method: 'publishCollectionPolicy',
      input: {
        operatorRef: draft.operatorRef,
        termsRef: 'test-terms',
        steps: [{ afterDays: 0, action: 'notify' }],
      },
    },
    {
      name: 'publish-tax-treatment',
      method: 'publishTaxTreatment',
      input: {
        operatorRef: draft.operatorRef,
        countryCode: 'XX',
        regionCode: '',
        treatment: 'not_collected',
        adviserRef: 'test-adviser',
      },
    },
    {
      name: 'enter-provider-bill',
      method: 'enterProviderBill',
      input: {
        operatorRef: draft.operatorRef,
        providerKind: 'test_provider',
        periodStart: '2032-01-01T00:00:00Z',
        periodEnd: '2032-02-01T00:00:00Z',
        currency: 'XTS',
        amountMicros: amount,
        sourceRef: 'test-invoice',
      },
    },
  ] as const)(
    'dispatches $name only after validating its explicit inputs',
    async ({ name, method, input }) => {
      expect(await catalogCommand([name, '--file', fileWith(input)])).toBe(0);
      expect(commands[method]).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('logs IDs and codes without an amount or operator reference', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    let output: string;
    try {
      expect(await catalogCommand(['draft-rate-card', '--file', fileWith(draft)])).toBe(0);
      output = write.mock.calls.map(([value]) => String(value)).join('');
    } finally {
      write.mockRestore();
    }
    expect(output!).toContain('catalog.completed');
    expect(output!).not.toContain(amount);
    expect(output!).not.toContain(draft.operatorRef);
  });
});

describe('the provider ledger reader', () => {
  it('returns an exact bigint from the aggregate and hides raw database failures', async () => {
    const actual = await vi.importActual<typeof commands>(
      '@ensemus/application/saas/operator-catalog',
    );
    const execute = vi.fn().mockResolvedValue({ rows: [{ cost: amount }] });
    const reader = actual.createProviderCostReader({ execute } as unknown as commands.OperatorDb);
    const input = {
      providerKind: 'test_provider',
      from: new Date('2032-01-01T00:00:00Z'),
      to: new Date('2032-02-01T00:00:00Z'),
    };
    expect(await reader.sumProviderCost(input)).toBe(BigInt(amount));
    expect(execute).toHaveBeenCalledOnce();
    execute.mockRejectedValue(new Error('generated provider text must stay private'));
    await expect(reader.sumProviderCost(input)).rejects.toThrow('USAGE_UNAVAILABLE');
  });

  it('refuses a backwards range before any query', async () => {
    const actual = await vi.importActual<typeof commands>(
      '@ensemus/application/saas/operator-catalog',
    );
    const execute = vi.fn();
    const reader = actual.createProviderCostReader({ execute } as unknown as commands.OperatorDb);
    await expect(
      reader.sumProviderCost({
        providerKind: 'test_provider',
        from: new Date('2032-02-01T00:00:00Z'),
        to: new Date('2032-01-01T00:00:00Z'),
      }),
    ).rejects.toThrow('USAGE_UNAVAILABLE');
    expect(execute).not.toHaveBeenCalled();
  });
});
