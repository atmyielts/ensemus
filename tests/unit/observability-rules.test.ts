import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/stack';

const root = join(repoRoot, 'infrastructure/observability'),
  read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const telemetry = read('packages/telemetry/src/index.ts'),
  safe = new Set(
    [
      ...telemetry
        .slice(telemetry.indexOf('const SAFE_FIELDS'), telemetry.indexOf('const SAFE_VALUE'))
        .matchAll(/'([A-Za-z]+)'/g),
    ].map((match) => match[1]),
  );
type Source = {
  kind: string;
  event?: string;
  available: boolean;
  binding?: string;
  equals?: Record<string, string>;
};
type Rule = {
  id: string;
  priority: string;
  source: Source;
  fields: string[];
  condition: { field: string; operator: string; tuningValue: number };
  runbook: string;
};
describe('portable operations definitions', () => {
  it('parses every rule and resolves its runbook anchor without free-text selectors', () => {
    const rules: Rule[] = [];
    for (const filename of readdirSync(root).filter((name) => name.endsWith('.yaml'))) {
      const document = parse(readFileSync(join(root, filename), 'utf8')) as {
        schemaVersion: number;
        activation: string;
        thresholdPolicy: string;
        rules: Rule[];
      };
      expect(document.schemaVersion).toBe(1);
      expect(document.activation).toBe('unbound');
      expect(document.thresholdPolicy).toContain('tuning-values');
      rules.push(...document.rules);
    }
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    expect(
      rules
        .filter((rule) => rule.priority === 'P0')
        .map((rule) => rule.id)
        .sort(),
    ).toEqual([
      'compromised-key',
      'cross-tenant-policy',
      'forbidden-egress',
      'repeated-duplicate-effects',
    ]);
    for (const rule of rules) {
      const [path, anchor] = rule.runbook.split('#'),
        markdown = read(path!);
      expect(markdown.toLowerCase()).toContain(`## ${anchor!.replaceAll('-', ' ')}`);
      expect(Number.isFinite(rule.condition.tuningValue)).toBe(true);
      expect(
        [...rule.fields, ...Object.keys(rule.source.equals ?? {})].every((field) =>
          safe.has(field),
        ),
      ).toBe(true);
      if (rule.source.kind === 'required_projection') {
        expect(rule.source.available).toBe(false);
        expect(rule.source.binding).toMatch(/^[a-z_]+$/);
      } else {
        expect(rule.source.kind).toBe('log');
        expect(rule.source.event).toMatch(/^[a-z_.]+$/);
      }
      expect(JSON.stringify(rule)).not.toMatch(
        /@|tenantId|email|customerName|body|publicMessage|operatorRef|authorRef|amount/i,
      );
    }
  });
  it('keeps dashboards unbound and uses only safe operational fields', () => {
    const dashboard = JSON.parse(readFileSync(join(root, 'service-dashboard.json'), 'utf8')) as {
      activation: string;
      panels: { source: Source; fields: string[] }[];
    };
    expect(dashboard.activation).toBe('unbound');
    for (const panel of dashboard.panels) {
      expect(panel.fields.every((field) => safe.has(field))).toBe(true);
      if (panel.source.kind === 'required_projection') expect(panel.source.available).toBe(false);
    }
  });
  it('uses safe fields in runbook examples and leaves security.txt unpublished', () => {
    const runbook = read('docs/05-operations/08-runbooks.md');
    for (const block of runbook.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const value = JSON.parse(block[1]!) as Record<string, unknown>;
      expect(Object.keys(value).every((key) => key === 'event' || safe.has(key))).toBe(true);
    }
    expect(readFileSync(join(root, 'security.txt.template'), 'utf8')).toContain(
      'OWNER_APPROVED_SECURITY_CONTACT_URI',
    );
    for (const path of [
      'apps/web/public/security.txt',
      'apps/web/public/.well-known/security.txt',
      'apps/web/src/app/.well-known/security.txt/route.ts',
    ])
      expect(existsSync(join(repoRoot, path))).toBe(false);
  });
});
