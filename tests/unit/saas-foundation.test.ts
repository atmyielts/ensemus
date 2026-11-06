// What holds M8's foundation together with no database: the state tables match the reviewed SQL, money adds up,
// no price or retention number got into code, and nothing shipped reaches the test doubles (ADR-032).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { can } from '@ensemus/domain/policy';
import { loadSaasConfig, ConfigError } from '@ensemus/config';
import { BREAK_GLASS_TRANSITIONS } from '@ensemus/saas/support';
import { INVOICE_TRANSITIONS } from '@ensemus/saas/invoice';
import { OFFBOARDING_TRANSITIONS } from '@ensemus/saas/offboarding';
import {
  microsFromWire,
  microsToWire,
  minorUnitMicros,
  roundToMinorUnit,
} from '@ensemus/saas/money';
import { PAYMENT_TRANSITIONS } from '@ensemus/saas/payment';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

const SECURITY_SQL = readFileSync(
  join(repoRoot, 'packages/database/migrations/0501_saas_security.sql'),
  'utf8',
);

/** Reads `WHEN 'x' THEN NEW.y IN ('a','b')` and `= 'a'` out of one trigger, into a table. */
function transitionsIn(functionName: string, column: string) {
  const start = SECURITY_SQL.indexOf(`CREATE FUNCTION ${functionName}`);
  expect(start, functionName).toBeGreaterThan(-1);
  const body = SECURITY_SQL.slice(start, SECURITY_SQL.indexOf('END $$;', start));
  const table: Record<string, string[]> = {};
  const pattern = new RegExp(
    `WHEN '(\\w+)' THEN NEW\\.${column}\\s+(?:IN \\(([^)]*)\\)|= '(\\w+)')`,
    'g',
  );
  for (const match of body.matchAll(pattern)) {
    table[match[1]!] = match[2]
      ? match[2].split(',').map((value) => value.trim().replaceAll("'", ''))
      : [match[3]!];
  }
  return table;
}

const withoutEmpty = (table: Readonly<Record<string, readonly string[]>>) =>
  Object.fromEntries(Object.entries(table).filter(([, to]) => to.length > 0));

describe('the state tables match the reviewed SQL', () => {
  it.each([
    ['payments', 'billing.check_payment_change', 'status', PAYMENT_TRANSITIONS],
    ['invoices', 'billing.check_invoice_change', 'status', INVOICE_TRANSITIONS],
    ['offboarding', 'lifecycle.check_offboarding_change', 'state', OFFBOARDING_TRANSITIONS],
    ['break-glass', 'support.check_break_glass_change', 'state', BREAK_GLASS_TRANSITIONS],
  ])('%s', (_, name, column, table) => {
    expect(transitionsIn(name, column)).toEqual(withoutEmpty(table));
  });
});

describe('money', () => {
  it('rounds half away from zero, to the minor unit the card says', () => {
    expect(minorUnitMicros(2)).toBe(10_000n);
    expect(minorUnitMicros(0)).toBe(1_000_000n);
    expect(roundToMinorUnit(14_999n, 2)).toBe(10_000n);
    expect(roundToMinorUnit(15_000n, 2)).toBe(20_000n);
    expect(roundToMinorUnit(-15_000n, 2)).toBe(-20_000n);
    expect(roundToMinorUnit(0n, 2)).toBe(0n);
  });

  it('refuses a minor unit that makes no sense', () => {
    expect(() => minorUnitMicros(-1)).toThrow(RangeError);
    expect(() => minorUnitMicros(5)).toThrow(RangeError);
    expect(() => minorUnitMicros(1.5)).toThrow(RangeError);
  });

  it('crosses an API as digits, and refuses anything else', () => {
    expect(microsFromWire(microsToWire(9_007_199_254_740_993n))).toBe(9_007_199_254_740_993n);
    for (const bad of ['1e3', '0x10', ' 1', '01', '1.5', '', '-']) {
      expect(() => microsFromWire(bad), bad).toThrow(RangeError);
    }
  });
});

describe('who can do what', () => {
  it('keeps leaving, legal holds and break-glass with owners', () => {
    for (const capability of [
      'offboarding.manage',
      'legal_hold.manage',
      'break_glass.authorize',
    ] as const) {
      expect(can('owner', capability)).toBe(true);
      expect(can('admin', capability)).toBe(false);
      expect(can('member', capability)).toBe(false);
    }
  });

  it('keeps money from ordinary members, and lets anyone ask for help', () => {
    expect(can('member', 'billing.view')).toBe(false);
    expect(can('member', 'billing.manage')).toBe(false);
    expect(can('member', 'support.use')).toBe(true);
  });
});

describe('the hosted service settings', () => {
  it('turns billing and break-glass off unless named', () => {
    const config = loadSaasConfig({});
    expect(config.billingEnabled).toBe(false);
    expect(config.breakGlass).toEqual({ enabled: false });
  });

  it('refuses billing in Sovereign', () => {
    expect(() =>
      loadSaasConfig({ ENSEMUS_MODE: 'sovereign', ENSEMUS_BILLING_ENABLED: 'true' }),
    ).toThrow(ConfigError);
  });

  it('refuses break-glass with no limit, since there is no default length', () => {
    expect(() => loadSaasConfig({ ENSEMUS_BREAK_GLASS_ENABLED: 'true' })).toThrow(ConfigError);
    expect(
      loadSaasConfig({
        ENSEMUS_BREAK_GLASS_ENABLED: 'true',
        ENSEMUS_BREAK_GLASS_MAX_MINUTES: '5',
      }).breakGlass,
    ).toEqual({ enabled: true, maxMinutes: 5 });
  });
});

const walk = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === 'node_modules' || name === '.next' || name === 'dist') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

describe('what the code leaves to the owner', () => {
  const shipped = [
    ...walk(join(repoRoot, 'packages/saas/src')).filter((path) => !path.includes('testing')),
    ...walk(join(repoRoot, 'packages/application/src/saas')),
    join(repoRoot, 'packages/database/migrations/0500_saas_tables.sql'),
    join(repoRoot, 'packages/database/migrations/0501_saas_security.sql'),
  ];

  it('names no currency amount, certification or uptime', () => {
    for (const path of shipped) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toMatch(/\$\s?\d/);
      expect(text, path).not.toMatch(/\b(SOC ?2|ISO ?27001|HIPAA)\b/);
      expect(text, path).not.toMatch(/\b99\.\d+\s?%/);
    }
  });

  it('seeds no price list, plan or retention rule', () => {
    const migrations = [
      readFileSync(join(repoRoot, 'packages/database/migrations/0500_saas_tables.sql'), 'utf8'),
      SECURITY_SQL,
    ].join('\n');
    expect(migrations).not.toMatch(
      /INSERT INTO\s+"?billing"?\."?(rate_cards|plans|plan_versions)/i,
    );
    expect(migrations).not.toMatch(/INSERT INTO\s+"?lifecycle"?\."?retention_rules/i);
    expect(migrations).not.toMatch(/INSERT INTO\s+"?support"?\."?coverage_schedules/i);
  });

  it('gives no default to a commercial number', () => {
    const tables = readFileSync(
      join(repoRoot, 'packages/database/migrations/0500_saas_tables.sql'),
      'utf8',
    );
    for (const column of [
      'platform_fee_micros',
      'payment_terms_days',
      'microcredits_per_unit',
      'retain_days',
      'requested_minutes',
    ]) {
      expect(tables, column).not.toMatch(new RegExp(`"${column}" \\w+ DEFAULT`));
    }
  });

  it('reaches the test doubles from no shipped file', () => {
    const roots = ['packages', 'apps', 'workers'].map((name) => join(repoRoot, name));
    for (const path of roots.flatMap(walk)) {
      if (!/\.tsx?$/.test(path) || path.includes('testing') || path.endsWith('.test.ts')) continue;
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/@ensemus\/saas\/testing/);
    }
  });
});
