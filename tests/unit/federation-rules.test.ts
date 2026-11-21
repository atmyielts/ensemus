// ADR-035: the state machines and tables exist in code and in reviewed SQL, because both tenants reach a grant
// through one role, and the contracts and OpenAPI repeat their names. These keep every copy the same, and
// hold the shape of the boundary itself without needing a database.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  federationClassificationSchema,
  federationDispositionSchema,
  federationEndReasonSchema,
  federationGrantStatusSchema,
  federationItemKindSchema,
  federationItemStateSchema,
  federationPurposeSchema,
} from '@ensemus/contracts/federation';
import {
  isolationAspectSchema,
  residencyScopeSchema,
  residencySurfaceSchema,
} from '@ensemus/contracts/tenancy';
import {
  FEDERATION_CLASSIFICATIONS,
  FEDERATION_CROSSING_OUTCOMES,
  FEDERATION_DISPOSITIONS,
  FEDERATION_END_REASONS,
  FEDERATION_GRANT_STATUSES,
  FEDERATION_GRANT_TRANSITIONS,
  FEDERATION_ITEM_KINDS,
  FEDERATION_ITEM_STATES,
  FEDERATION_ITEM_TRANSITIONS,
  FEDERATION_PURPOSE_KINDS,
  FEDERATION_PURPOSES,
} from '@ensemus/domain/federation';
import { RESIDENCY_SCOPES, RESIDENCY_SURFACES } from '@ensemus/domain/residency';
import { ISOLATION_ASPECTS } from '@ensemus/domain/tenancy';
import { spec } from '../helpers/openapi';
import { repoRoot } from '../helpers/stack';

const migrations = join(repoRoot, 'packages/database/migrations');
const read = (name: string) => readFileSync(join(migrations, name), 'utf8');
const security = read('0703_federation_security.sql');
const tables = read('0702_federation.sql');
const tenancySecurity = read('0701_tenancy_security.sql');
const tenancyTables = read('0700_tenancy.sql');

const quoted = (list: string) => list.split(',').map((item) => item.trim().replaceAll("'", ''));

const machine = (field: 'status' | 'state') =>
  Object.fromEntries(
    [
      ...security.matchAll(
        new RegExp(`WHEN '([a-z_]+)' THEN NEW\\.${field} IN \\(([^)]+)\\)`, 'g'),
      ),
    ].map(([, from, to]) => [from, quoted(to ?? '')]),
  );

const checkValues = (source: string, constraint: string, column: string) => {
  const start = source.indexOf(`"${constraint}"`);
  const match = new RegExp(`"${column}" in \\(([^)]+)\\)`).exec(source.slice(start));
  return quoted(match?.[1] ?? '');
};

const enumOf = (name: string) =>
  (spec.components.schemas as unknown as Record<string, { enum: string[] }>)[name]?.enum;

describe('the grant state machine', () => {
  it('is the same table in the domain and in the trigger', () => {
    const moving = Object.entries(FEDERATION_GRANT_TRANSITIONS).filter(([, to]) => to.length > 0);
    const inSql = machine('status');
    expect(Object.keys(inSql).sort()).toEqual(moving.map(([from]) => from).sort());
    for (const [from, to] of moving) expect(inSql[from], from).toEqual([...to]);
  });

  it('has no way out of ended', () => {
    expect(FEDERATION_GRANT_TRANSITIONS.ended).toEqual([]);
  });

  it('needs the second and the third consent, in that order, before anything is active', () => {
    expect(FEDERATION_GRANT_TRANSITIONS.proposed).not.toContain('active');
    expect(FEDERATION_GRANT_TRANSITIONS.accepted).toContain('active');
  });
});

describe('the item state machine', () => {
  it('is the same table in the domain and in the trigger', () => {
    const moving = Object.entries(FEDERATION_ITEM_TRANSITIONS).filter(([, to]) => to.length > 0);
    const inSql = machine('state');
    expect(Object.keys(inSql).sort()).toEqual(moving.map(([from]) => from).sort());
    for (const [from, to] of moving) expect(inSql[from], from).toEqual([...to]);
  });
});

describe('the limited objects', () => {
  it('are the same table in the domain and in federation.kinds_for', () => {
    const inSql = Object.fromEntries(
      [...security.matchAll(/WHEN '([a-z_]+\/[a-z_]+)' THEN ARRAY\[([^\]]+)\]/g)].map(
        ([, key, kinds]) => [key, quoted(kinds ?? '')],
      ),
    );
    const inDomain = Object.fromEntries(
      FEDERATION_PURPOSES.flatMap((purpose) =>
        (['forward', 'return'] as const).map((direction) => [
          `${purpose}/${direction}`,
          [...FEDERATION_PURPOSE_KINDS[purpose][direction]],
        ]),
      ),
    );
    expect(inSql).toEqual(inDomain);
  });

  it('never let restricted data cross, anywhere it is listed', () => {
    expect(FEDERATION_CLASSIFICATIONS).not.toContain('restricted');
    for (const [constraint] of [
      ['grants_max_classification_check'],
      ['outbound_items_classification_check'],
      ['inbound_items_classification_check'],
    ]) {
      expect(tables.slice(tables.indexOf(`"${constraint}"`)).split('\n')[0]).not.toContain(
        'restricted',
      );
    }
  });
});

describe('every copy of a list', () => {
  const lists: Array<[string, readonly string[], string, string, readonly string[], string]> = [
    [
      'grant statuses',
      FEDERATION_GRANT_STATUSES,
      'grants_status_check',
      'status',
      federationGrantStatusSchema.options,
      'FederationGrantStatus',
    ],
    [
      'purposes',
      FEDERATION_PURPOSES,
      'grants_purpose_check',
      'purpose',
      federationPurposeSchema.options,
      'FederationPurpose',
    ],
    [
      'item kinds',
      FEDERATION_ITEM_KINDS,
      'outbound_items_kind_check',
      'kind',
      federationItemKindSchema.options,
      'FederationItemKind',
    ],
    [
      'item states',
      FEDERATION_ITEM_STATES,
      'outbound_items_state_check',
      'state',
      federationItemStateSchema.options,
      'FederationItemState',
    ],
    [
      'classifications',
      FEDERATION_CLASSIFICATIONS,
      'grants_max_classification_check',
      'max_classification',
      federationClassificationSchema.options,
      'FederationClassification',
    ],
    [
      'dispositions',
      FEDERATION_DISPOSITIONS,
      'inbound_items_disposition_check',
      'disposition',
      federationDispositionSchema.options,
      'FederationDisposition',
    ],
    [
      'end reasons',
      FEDERATION_END_REASONS,
      'grants_end_reason_check',
      'end_reason',
      federationEndReasonSchema.options,
      'FederationEndReason',
    ],
  ];

  it.each(lists)(
    '%s match in the domain, the table, the contract and the API',
    (_, domain, constraint, column, contract, schema) => {
      expect(checkValues(tables, constraint, column)).toEqual([...domain]);
      expect([...contract]).toEqual([...domain]);
      expect(enumOf(schema)).toEqual([...domain]);
    },
  );

  it('crossing outcomes match', () => {
    expect(checkValues(tables, 'crossings_outcome_check', 'outcome')).toEqual([
      ...FEDERATION_CROSSING_OUTCOMES,
    ]);
    expect(enumOf('FederationCrossingOutcome')).toEqual([...FEDERATION_CROSSING_OUTCOMES]);
  });

  it('isolation aspects match', () => {
    expect(checkValues(tenancyTables, 'isolation_evidence_aspect_check', 'aspect')).toEqual([
      ...ISOLATION_ASPECTS,
    ]);
    expect([...isolationAspectSchema.options]).toEqual([...ISOLATION_ASPECTS]);
    expect(enumOf('IsolationAspect')).toEqual([...ISOLATION_ASPECTS]);
  });

  it('residency surfaces and scopes match', () => {
    expect([...residencySurfaceSchema.options]).toEqual([...RESIDENCY_SURFACES]);
    expect(enumOf('ResidencySurface')).toEqual([...RESIDENCY_SURFACES]);
    expect(checkValues(tenancyTables, 'residency_requirements_scope_check', 'scope')).toEqual([
      ...RESIDENCY_SCOPES,
    ]);
    expect([...residencyScopeSchema.options]).toEqual([...RESIDENCY_SCOPES]);
    expect(enumOf('ResidencyScope')).toEqual([...RESIDENCY_SCOPES]);
  });
});

describe('the shape of the boundary', () => {
  const m11c = readdirSync(migrations).filter((name) => /^07\d\d_/.test(name));

  it('marks every migration that sets a policy or a grant as reviewed security SQL', () => {
    for (const name of m11c) {
      const text = read(name);
      if (/\b(CREATE POLICY|GRANT |REVOKE )/.test(text)) {
        expect(
          text.split(/\r?\n/).some((line) => line.startsWith('-- REVIEWED SECURITY SQL')),
          name,
        ).toBe(true);
      }
    }
  });

  it('changes no policy on any table outside its own two schemas', () => {
    const outside = [
      ...security.matchAll(/CREATE POLICY \w+ ON ([a-z_]+)\./g),
      ...tenancySecurity.matchAll(/CREATE POLICY \w+ ON ([a-z_]+)\./g),
    ]
      .map(([, schema]) => schema)
      .filter((schema) => schema !== 'federation' && schema !== 'tenancy');
    expect(outside).toEqual([]);
    expect(`${security}${tenancySecurity}`).not.toMatch(
      /ALTER POLICY|DROP POLICY (?!IF EXISTS bridge_)/,
    );
  });

  it('grants the bridge role nothing outside the tables ADR-035 lists', () => {
    const start = security.indexOf('CREATE FUNCTION federation.apply_bridge_grants');
    const body = security.slice(start);
    const targets = [
      ...body.matchAll(/GRANT [^;]*?ON (?:DATABASE )?([a-z_]+\.[a-z_]+)\s+TO ensemus_federation/g),
    ].map(([, table]) => table);
    expect([...new Set(targets)].sort()).toEqual([
      'federation.crossings',
      'federation.grants',
      'federation.inbound_items',
      'federation.outbound_items',
      'tenancy.deployment_profile',
    ]);
    // What it may read of an arrival leaves out the content.
    const inbound = /GRANT SELECT \(([^)]+)\)\s+ON federation\.inbound_items/.exec(body)?.[1] ?? '';
    expect(inbound).not.toMatch(/title|body/);
  });

  it('never makes the bridge role strong, and refuses one somebody else did', () => {
    expect(security).toContain('rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb');
    expect(`${security}${tenancySecurity}`).not.toMatch(/BYPASSRLS|SECURITY DEFINER/);
  });

  it('gives the application role no way to write an arrival or a ledger line', () => {
    const appGrants = [
      ...security.matchAll(
        /GRANT ([^;]+?) ON federation\.(inbound_items|crossings) TO ensemus_app/g,
      ),
    ].map(([, verbs]) => verbs ?? '');
    expect(appGrants.join(' ')).not.toMatch(/INSERT|DELETE/);
  });

  it('keeps a file key to the derived prefix, in the table and in the domain', () => {
    expect(tables).toContain(`'federation/outbound/' ||`);
    expect(tables).toContain(`'federation/inbound/' ||`);
  });

  it('lets only the named files use the bridge role', () => {
    const lint = readFileSync(join(repoRoot, 'eslint.config.mjs'), 'utf8');
    const list = /const BRIDGE_FILES = \[([^\]]+)\]/.exec(lint)?.[1] ?? '';
    expect(quoted(list.replaceAll('\n', '')).filter(Boolean)).toEqual([
      'workers/workflow/src/federation-worker.ts',
      'packages/workflows/src/federation-activities.ts',
      'packages/workflows/src/federation-deps.ts',
    ]);
  });

  it('names nothing an owner has yet to decide', () => {
    const everything = [
      ...m11c.map(read),
      readFileSync(join(repoRoot, 'packages/domain/src/residency.ts'), 'utf8'),
      readFileSync(join(repoRoot, 'packages/domain/src/tenancy.ts'), 'utf8'),
    ].join('\n');
    // No real region name, and no certification, however it is spelled.
    expect(everything).not.toMatch(/\b(us|eu|ap|me|sa|af)-(east|west|central|north|south)\b/);
    expect(everything).not.toMatch(/\b(SOC ?2|ISO ?27001|HIPAA|FedRAMP|GDPR)\b/i);
  });
});
