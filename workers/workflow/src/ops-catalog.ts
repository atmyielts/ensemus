// Owned by the catalog slice (BILL-04). `DATABASE_URL_OPERATOR`. Every price comes in on the command line or from
// a file an operator names, and nothing here has a default. See docs/06-delivery/m8-slices.md.
//   node dist/ops.js catalog <command> --file <JSON file>
// Commands: draft-rate-card, approve-rate-card, draft-plan, approve-plan,
// publish-collection-policy, publish-tax-treatment, enter-provider-bill, reconcile-provider-bill.
// Files use the service's camelCase fields, explicit ISO dates and decimal strings for bigint amounts.
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  approvePlanVersion,
  approveRateCard,
  catalogDateWireSchema,
  catalogInputSchemas,
  createProviderCostReader,
  draftPlanVersion,
  draftRateCard,
  enterProviderBill,
  publishCollectionPolicy,
  publishTaxTreatment,
  reconcileProviderBill,
} from '@ensemus/application/saas/operator-catalog';
import { AppError } from '@ensemus/application';
import { readSecret } from '@ensemus/config';
import { openOperatorDatabase } from '@ensemus/database/operator';
import { microsFromWire } from '@ensemus/saas/money';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('catalog-command');
const MAX_INPUT_BYTES = 1024 * 1024;

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_INPUT');
  return value as Record<string, unknown>;
}

function money(value: unknown): bigint {
  if (typeof value !== 'string') throw new Error('INVALID_AMOUNT');
  return microsFromWire(value);
}

function date(value: unknown): Date {
  return catalogDateWireSchema.parse(value);
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('INVALID_INPUT');
  return value.map(objectOf);
}

const parsers = {
  'draft-rate-card': (value: unknown) => {
    const input = objectOf(value);
    return {
      command: 'draft-rate-card' as const,
      input: catalogInputSchemas.draftRateCard.parse({
        ...input,
        lines: rows(input.lines).map((line) => ({
          ...line,
          microcreditsPerUnit: money(line.microcreditsPerUnit),
        })),
        topUpOffers: rows(input.topUpOffers).map((offer) => ({
          ...offer,
          microcredits: money(offer.microcredits),
          priceMicros: money(offer.priceMicros),
        })),
      }),
    };
  },
  'approve-rate-card': (value: unknown) => {
    const input = objectOf(value);
    return {
      command: 'approve-rate-card' as const,
      input: catalogInputSchemas.approveRateCard.parse({
        ...input,
        effectiveFrom: date(input.effectiveFrom),
      }),
    };
  },
  'draft-plan': (value: unknown) => {
    const input = objectOf(value);
    return {
      command: 'draft-plan' as const,
      input: catalogInputSchemas.draftPlanVersion.parse({
        ...input,
        platformFeeMicros: money(input.platformFeeMicros),
        includedMicrocredits:
          input.includedMicrocredits === null ? null : money(input.includedMicrocredits),
      }),
    };
  },
  'approve-plan': (value: unknown) => ({
    command: 'approve-plan' as const,
    input: catalogInputSchemas.approvePlanVersion.parse(value),
  }),
  'publish-collection-policy': (value: unknown) => ({
    command: 'publish-collection-policy' as const,
    input: catalogInputSchemas.publishCollectionPolicy.parse(value),
  }),
  'publish-tax-treatment': (value: unknown) => ({
    command: 'publish-tax-treatment' as const,
    input: catalogInputSchemas.publishTaxTreatment.parse(value),
  }),
  'enter-provider-bill': (value: unknown) => {
    const input = objectOf(value);
    return {
      command: 'enter-provider-bill' as const,
      input: catalogInputSchemas.enterProviderBill.parse({
        ...input,
        amountMicros: money(input.amountMicros),
        periodStart: date(input.periodStart),
        periodEnd: date(input.periodEnd),
      }),
    };
  },
  'reconcile-provider-bill': (value: unknown) => ({
    command: 'reconcile-provider-bill' as const,
    input: catalogInputSchemas.reconcileProviderBill.parse(value),
  }),
};

type Prepared = ReturnType<(typeof parsers)[keyof typeof parsers]>;

function prepare(args: string[]): Prepared {
  const [command, ...rest] = args;
  if (!command || !Object.hasOwn(parsers, command)) throw new Error('NOT_A_COMMAND');
  const { values, tokens } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: { file: { type: 'string' } },
  });
  if (
    !values.file ||
    tokens.filter((token) => token.kind === 'option' && token.name === 'file').length !== 1
  )
    throw new Error('INPUT_FILE_REQUIRED');
  const stat = statSync(values.file);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_INPUT_BYTES)
    throw new Error('INVALID_INPUT_FILE');
  const text = readFileSync(values.file, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error('INVALID_INPUT_FILE');
  return parsers[command as keyof typeof parsers](JSON.parse(text));
}

export async function catalogCommand(args: string[]): Promise<number> {
  let prepared: Prepared;
  let url: string;
  try {
    // A bad number, file or missing credential is refused before any database can be opened.
    prepared = prepare(args);
    url = readSecret('DATABASE_URL_OPERATOR');
  } catch {
    log.error('catalog.refused', { reasonCode: 'INVALID_COMMAND_OR_CONFIGURATION' });
    return 2;
  }

  const operator = openOperatorDatabase(url);
  try {
    let tableRef: string;
    let count = 1;
    switch (prepared.command) {
      case 'draft-rate-card': {
        const result = await draftRateCard(operator.db, prepared.input);
        tableRef = `rate_card:${result.rateCardId}`;
        count = result.version;
        break;
      }
      case 'approve-rate-card':
        await approveRateCard(operator.db, prepared.input);
        tableRef = `rate_card:${prepared.input.rateCardId}`;
        break;
      case 'draft-plan': {
        const result = await draftPlanVersion(operator.db, prepared.input);
        tableRef = `plan_version:${result.planVersionId}`;
        count = result.version;
        break;
      }
      case 'approve-plan':
        await approvePlanVersion(operator.db, prepared.input);
        tableRef = `plan_version:${prepared.input.planVersionId}`;
        break;
      case 'publish-collection-policy': {
        const result = await publishCollectionPolicy(operator.db, prepared.input);
        tableRef = `collection_policy:${result.policyId}`;
        count = result.version;
        break;
      }
      case 'publish-tax-treatment': {
        const result = await publishTaxTreatment(operator.db, prepared.input);
        tableRef = `tax_treatment:${result.treatmentId}`;
        count = result.version;
        break;
      }
      case 'enter-provider-bill': {
        const result = await enterProviderBill(operator.db, prepared.input);
        tableRef = `provider_bill:${result.providerBillId}`;
        break;
      }
      case 'reconcile-provider-bill':
        await reconcileProviderBill(
          operator.db,
          prepared.input,
          createProviderCostReader(operator.db),
        );
        tableRef = `provider_bill:${prepared.input.providerBillId}`;
        log.info('catalog.compared', {
          tableRef,
          reasonCode: prepared.input.decision?.toUpperCase() ?? 'COMPARISON_ONLY',
        });
        return prepared.input.decision === 'reconciled' ? 0 : 1;
    }
    log.info('catalog.completed', { tableRef, count });
    return 0;
  } catch (error) {
    const code = errorCode(error);
    const refused = error instanceof AppError || ['42501', '28P01', '28000'].includes(code);
    log.error(refused ? 'catalog.refused' : 'catalog.failed', { errorCode: code });
    return refused ? 2 : 1;
  } finally {
    await operator.close();
  }
}
