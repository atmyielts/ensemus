// KNOW-07: QA-037 and QA-038 at the level of pure rules. The refusals that need a tenant, a role or a trigger
// are in tests/integration/custom-objects.test.ts.
import { describe, expect, it } from 'vitest';
import {
  indexedValues,
  isSafeObjectLink,
  migrateRecordAttributes,
  OBJECT_INDEXED_TEXT_MAX_BYTES,
  OBJECT_LIMITS,
  parseObjectFilter,
  planTypeMigration,
  RESERVED_OBJECT_SLUGS,
  validateObjectSchema,
  validateRecordAttributes,
  type ObjectField,
  type ObjectRelationDefinition,
} from './custom-object';

const field = (overrides: Partial<ObjectField> & { key: string }): ObjectField => ({
  label: 'A label',
  kind: 'text',
  required: false,
  indexed: false,
  ...overrides,
});

const relation = (key: string, toTypeSlug = 'vendor'): ObjectRelationDefinition => ({
  key,
  label: 'A relation',
  toTypeSlug,
  cardinality: 'many',
});

const schema = (
  fields: readonly ObjectField[],
  relations: readonly ObjectRelationDefinition[] = [],
  slug = 'purchase_order',
) => validateObjectSchema({ slug, fields, relations });

const codes = (issues: readonly { code: string }[]) => issues.map((issue) => issue.code);

describe('validateObjectSchema', () => {
  it('accepts a shape within the limits', () => {
    expect(
      schema([
        field({ key: 'number', indexed: true, required: true }),
        field({ key: 'state', kind: 'enum', options: ['open', 'closed'], indexed: true }),
        field({ key: 'notes', kind: 'long_text', maxLength: OBJECT_LIMITS.maxLongTextLength }),
      ]),
    ).toEqual([]);
  });

  it.each(RESERVED_OBJECT_SLUGS)('refuses the reserved slug %s', (slug) => {
    expect(codes(schema([], [], slug))).toContain('RESERVED_SLUG');
  });

  it.each(['A', 'a', '1abc', 'with-dash', 'Upper', `a${'b'.repeat(64)}`, ''])(
    'refuses the malformed slug %j',
    (slug) => {
      expect(codes(schema([], [], slug))).toContain('BAD_KEY');
    },
  );

  it('refuses malformed and repeated keys, also across fields and relations', () => {
    expect(codes(schema([field({ key: 'Bad Key' })]))).toEqual(['BAD_KEY']);
    expect(codes(schema([field({ key: '__proto__' })]))).toEqual(['BAD_KEY']);
    expect(codes(schema([field({ key: 'same' }), field({ key: 'same' })]))).toEqual([
      'DUPLICATE_KEY',
    ]);
    expect(codes(schema([field({ key: 'same' })], [relation('same')]))).toEqual(['DUPLICATE_KEY']);
  });

  it('refuses too many fields, indexed fields and relations', () => {
    const many = Array.from({ length: OBJECT_LIMITS.maxFields + 1 }, (_, i) =>
      field({ key: `f${i}` }),
    );
    expect(codes(schema(many))).toContain('TOO_MANY_FIELDS');

    const indexed = Array.from({ length: OBJECT_LIMITS.maxIndexedFields + 1 }, (_, i) =>
      field({ key: `f${i}`, indexed: true }),
    );
    expect(codes(schema(indexed))).toEqual(['TOO_MANY_INDEXED']);

    const relations = Array.from({ length: OBJECT_LIMITS.maxRelations + 1 }, (_, i) =>
      relation(`r${i}`),
    );
    expect(codes(schema([], relations))).toEqual(['TOO_MANY_RELATIONS']);
  });

  it('asks an enum for options, and only an enum', () => {
    expect(codes(schema([field({ key: 'a', kind: 'enum' })]))).toEqual(['ENUM_NEEDS_OPTIONS']);
    expect(codes(schema([field({ key: 'a', kind: 'enum', options: [] })]))).toEqual([
      'ENUM_NEEDS_OPTIONS',
    ]);
    expect(codes(schema([field({ key: 'a', options: ['x'] })]))).toEqual(['ENUM_NEEDS_OPTIONS']);
    expect(
      codes(
        schema([
          field({
            key: 'a',
            kind: 'enum',
            options: Array.from({ length: OBJECT_LIMITS.maxEnumOptions + 1 }, (_, i) => `o${i}`),
          }),
        ]),
      ),
    ).toEqual(['ENUM_NEEDS_OPTIONS']);
    expect(codes(schema([field({ key: 'a', kind: 'enum', options: ['x', 'x'] })]))).toEqual([
      'DUPLICATE_KEY',
    ]);
  });

  it('refuses a length the kind cannot hold', () => {
    expect(
      codes(schema([field({ key: 'a', maxLength: OBJECT_LIMITS.maxTextLength + 1 })])),
    ).toEqual(['BAD_LENGTH']);
    expect(
      codes(
        schema([
          field({ key: 'a', kind: 'long_text', maxLength: OBJECT_LIMITS.maxLongTextLength + 1 }),
        ]),
      ),
    ).toEqual(['BAD_LENGTH']);
    expect(codes(schema([field({ key: 'a', maxLength: 0 })]))).toEqual(['BAD_LENGTH']);
    expect(codes(schema([field({ key: 'a', maxLength: 1.5 })]))).toEqual(['BAD_LENGTH']);
    expect(codes(schema([field({ key: 'a', kind: 'number', maxLength: 10 })]))).toEqual([
      'BAD_LENGTH',
    ]);
  });

  // An index entry has a size limit, so a long text would be refused by PostgreSQL at the worst moment.
  it('does not index long text', () => {
    expect(codes(schema([field({ key: 'a', kind: 'long_text', indexed: true })]))).toEqual([
      'BAD_LENGTH',
    ]);
  });

  it('refuses a kind it does not know, and text that could not be stored', () => {
    const unknown = { ...field({ key: 'a' }), kind: 'formula' } as unknown as ObjectField;
    expect(codes(schema([unknown]))).toEqual(['UNKNOWN_KIND']);
    expect(codes(schema([field({ key: 'a', label: 'nul\u0000' })]))).toEqual(['BAD_LENGTH']);
    expect(codes(schema([field({ key: 'a', label: '   ' })]))).toEqual(['BAD_LENGTH']);
  });

  it('checks where a relation points', () => {
    expect(codes(schema([], [relation('r', 'Not A Slug')]))).toEqual(['BAD_KEY']);
    expect(codes(schema([], [relation('r', 'approval')]))).toEqual(['RESERVED_SLUG']);
  });
});

describe('validateRecordAttributes', () => {
  const fields = [
    field({ key: 'name', required: true }),
    field({ key: 'notes', kind: 'long_text' }),
    field({ key: 'amount', kind: 'number' }),
    field({ key: 'active', kind: 'boolean' }),
    field({ key: 'due', kind: 'date' }),
    field({ key: 'state', kind: 'enum', options: ['open', 'closed'] }),
    field({ key: 'contact', kind: 'email' }),
    field({ key: 'site', kind: 'url' }),
  ];
  const check = (attributes: Record<string, unknown>) =>
    validateRecordAttributes(fields, { name: 'x', ...attributes });

  it('accepts what fits', () => {
    expect(
      check({
        notes: 'long',
        amount: 12.5,
        active: false,
        due: '2026-02-28',
        state: 'open',
        contact: 'someone@example.invalid',
        site: 'https://example.invalid/a?b=c',
      }),
    ).toEqual([]);
  });

  it('refuses a field the type does not declare, whatever its value', () => {
    expect(check({ surprise: 'x' })).toEqual([
      { path: 'attributes.surprise', code: 'UNKNOWN_FIELD' },
    ]);
    expect(codes(check({ surprise: null }))).toEqual(['UNKNOWN_FIELD']);
    // A key every plain object answers for must not look declared.
    expect(codes(check(JSON.parse('{"__proto__":"x"}') as Record<string, unknown>))).toEqual([
      'UNKNOWN_FIELD',
    ]);
    expect(codes(check({ constructor: 'x' }))).toEqual(['UNKNOWN_FIELD']);
  });

  it('wants required fields, and blank does not count', () => {
    expect(codes(validateRecordAttributes(fields, {}))).toEqual(['REQUIRED']);
    expect(codes(validateRecordAttributes(fields, { name: null }))).toEqual(['REQUIRED']);
    expect(codes(validateRecordAttributes(fields, { name: '   ' }))).toEqual(['REQUIRED']);
    // `constructor` is found on any object, and a required field by that name is still missing.
    expect(
      codes(validateRecordAttributes([field({ key: 'constructor', required: true })], {})),
    ).toEqual(['REQUIRED']);
  });

  it.each([
    ['name', 5],
    ['amount', '5'],
    ['amount', Number.NaN],
    ['amount', Number.POSITIVE_INFINITY],
    ['active', 'true'],
    ['due', '28/02/2026'],
    ['due', '2026-02-31'],
    ['due', 20260228],
    ['state', 3],
    ['contact', 'not an address'],
    ['contact', 'two@@example.invalid'],
    ['contact', 'a@nodot'],
    ['site', 'example.invalid'],
    ['site', 'javascript:alert(1)'],
    ['site', 'JaVaScRiPt:alert(1)'],
    ['site', 'data:text/html,x'],
    ['site', 'ftp://example.invalid'],
    ['site', ' https://example.invalid'],
    ['site', 'https://exa mple.invalid'],
    ['notes', { nested: true }],
    ['notes', ['list']],
  ])('refuses %s = %j as the wrong kind', (key, value) => {
    expect(check({ [key]: value })).toEqual([{ path: `attributes.${key}`, code: 'WRONG_KIND' }]);
  });

  it('refuses text PostgreSQL could not store, which would otherwise be a 500', () => {
    expect(codes(check({ notes: 'nul\u0000' }))).toEqual(['WRONG_KIND']);
    expect(codes(check({ notes: 'lone \ud800 surrogate' }))).toEqual(['WRONG_KIND']);
    expect(check({ notes: 'a pair is fine 😀' })).toEqual([]);
  });

  it('keeps an enum to its options', () => {
    expect(codes(check({ state: 'other' }))).toEqual(['NOT_AN_OPTION']);
  });

  it('holds each kind to its length', () => {
    expect(codes(check({ name: 'x'.repeat(OBJECT_LIMITS.maxTextLength + 1) }))).toEqual([
      'TOO_LONG',
    ]);
    expect(check({ notes: 'x'.repeat(OBJECT_LIMITS.maxTextLength + 1) })).toEqual([]);
    expect(codes(check({ notes: 'x'.repeat(OBJECT_LIMITS.maxLongTextLength + 1) }))).toEqual([
      'TOO_LONG',
    ]);
    expect(
      codes(validateRecordAttributes([field({ key: 'a', maxLength: 3 })], { a: 'four' })),
    ).toEqual(['TOO_LONG']);
  });

  it('keeps an indexed value small enough for its index, in bytes', () => {
    const indexed = [field({ key: 'a', indexed: true })];
    // Two thousand characters, each of three bytes, is within the text limit and well over the index's.
    const wide = '中'.repeat(OBJECT_LIMITS.maxTextLength);
    expect(codes(validateRecordAttributes(indexed, { a: wide }))).toEqual(['TOO_LONG']);
    expect(validateRecordAttributes([field({ key: 'a' })], { a: wide })).toEqual([]);
    expect(
      validateRecordAttributes(indexed, { a: 'x'.repeat(OBJECT_INDEXED_TEXT_MAX_BYTES) }),
    ).toEqual([]);
  });

  it('enforces the size of the whole record', () => {
    const big = Array.from({ length: 6 }, (_, i) => field({ key: `f${i}`, kind: 'long_text' }));
    const attributes = Object.fromEntries(
      big.map((f) => [f.key, 'x'.repeat(OBJECT_LIMITS.maxLongTextLength)]),
    );
    expect(codes(validateRecordAttributes(big, attributes))).toEqual(['TOO_LARGE']);
  });

  it('refuses attributes that are not an object', () => {
    for (const bad of [[], 'x', null, 3]) {
      expect(codes(validateRecordAttributes(fields, bad as unknown as Record<string, unknown>))) //
        .toEqual(['WRONG_KIND']);
    }
  });
});

describe('planTypeMigration', () => {
  const base = [
    field({ key: 'name', required: true }),
    field({ key: 'state', kind: 'enum', options: ['open', 'closed'] }),
  ];

  it('has nothing to do for the same shape', () => {
    expect(planTypeMigration(base, base)).toEqual({ safe: true, steps: [] });
  });

  it('allows an optional field, a wider enum and a change of index', () => {
    const plan = planTypeMigration(base, [
      field({ key: 'name', required: true, indexed: true }),
      field({ key: 'state', kind: 'enum', options: ['open', 'closed', 'held'] }),
      field({ key: 'extra' }),
    ]);
    expect(plan.safe).toBe(true);
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        { kind: 'add_optional', key: 'extra' },
        { kind: 'widen_enum', key: 'state' },
        { kind: 'change_index', key: 'name' },
      ]),
    );
  });

  it.each<[string, readonly ObjectField[], { kind: string; key: string; refused: true }]>([
    [
      'removing a field',
      [field({ key: 'name', required: true })],
      { kind: 'remove', key: 'state', refused: true },
    ],
    [
      'a new required field',
      [...base, field({ key: 'extra', required: true })],
      { kind: 'add_required', key: 'extra', refused: true },
    ],
    [
      'an optional field becoming required',
      [field({ key: 'name', required: true }), { ...base[1]!, required: true }],
      { kind: 'add_required', key: 'state', refused: true },
    ],
    [
      'a change of kind',
      [field({ key: 'name', required: true, kind: 'long_text' }), base[1]!],
      { kind: 'change_kind', key: 'name', refused: true },
    ],
    [
      'a narrower enum',
      [base[0]!, field({ key: 'state', kind: 'enum', options: ['open'] })],
      { kind: 'narrow_enum', key: 'state', refused: true },
    ],
    [
      'a shorter limit than any record might fit',
      [field({ key: 'name', required: true, maxLength: 5 }), base[1]!],
      { kind: 'change_kind', key: 'name', refused: true },
    ],
  ])('refuses %s', (_name, to, step) => {
    const plan = planTypeMigration(base, to);
    expect(plan.safe).toBe(false);
    expect(plan.steps).toContainEqual(step);
  });

  it('allows a longer limit, and a required field becoming optional', () => {
    const from = [field({ key: 'a', required: true, maxLength: 5 })];
    expect(planTypeMigration(from, [field({ key: 'a', maxLength: 50 })])).toEqual({
      safe: true,
      steps: [],
    });
  });

  it('calls a swapped enum option a narrowing', () => {
    const plan = planTypeMigration(base, [
      base[0]!,
      field({ key: 'state', kind: 'enum', options: ['open', 'held'] }),
    ]);
    expect(plan.safe).toBe(false);
    expect(plan.steps).toContainEqual({ kind: 'narrow_enum', key: 'state', refused: true });
  });
});

describe('migrateRecordAttributes', () => {
  it('keeps every value, in a new object', () => {
    const attributes = { name: 'x', amount: 3 };
    const moved = migrateRecordAttributes({ safe: true, steps: [] }, attributes);
    expect(moved).toEqual(attributes);
    expect(moved).not.toBe(attributes);
  });

  it('will not run an unsafe plan', () => {
    expect(() =>
      migrateRecordAttributes(
        { safe: false, steps: [{ kind: 'remove', key: 'x', refused: true }] },
        { x: 1 },
      ),
    ).toThrow();
  });
});

describe('isSafeObjectLink', () => {
  it.each(['https://example.invalid', 'http://example.invalid/a', 'HTTPS://EXAMPLE.INVALID'])(
    'links %s',
    (value) => {
      expect(isSafeObjectLink(value)).toBe(true);
    },
  );

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    '//example.invalid',
    '/relative',
    'not a url',
    '',
    5,
    null,
    undefined,
    {},
  ])('does not link %j', (value) => {
    expect(isSafeObjectLink(value)).toBe(false);
  });
});

describe('indexedValues', () => {
  const fields = [
    field({ key: 'a', indexed: true }),
    field({ key: 'b', kind: 'number', indexed: true }),
    field({ key: 'c', kind: 'boolean', indexed: true }),
    field({ key: 'd', kind: 'date', indexed: true }),
    field({ key: 'e', kind: 'enum', options: ['x'], indexed: true }),
    field({ key: 'f' }),
    field({ key: 'g', indexed: true }),
  ];

  it('writes only indexed fields that hold a value, each in its own column', () => {
    const values = indexedValues(fields, {
      a: 'text',
      b: 2.5,
      c: false,
      d: '2026-01-02',
      e: 'x',
      f: 'not indexed',
      g: null,
    });
    expect(values.map((value) => value.fieldKey)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(values[0]).toMatchObject({ valueText: 'text', valueNumber: null });
    expect(values[1]).toMatchObject({ valueNumber: '2.5', valueText: null });
    expect(values[2]).toMatchObject({ valueBoolean: false });
    expect(values[3]?.valueTime?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(values[4]).toMatchObject({ valueText: 'x' });
  });
});

describe('parseObjectFilter', () => {
  it('turns a typed-in value into the column it is held in', () => {
    expect(parseObjectFilter(field({ key: 'a' }), 'x')).toEqual({ column: 'text', value: 'x' });
    expect(parseObjectFilter(field({ key: 'a', kind: 'number' }), '2.5')).toEqual({
      column: 'number',
      value: '2.5',
    });
    expect(parseObjectFilter(field({ key: 'a', kind: 'boolean' }), 'false')).toEqual({
      column: 'boolean',
      value: false,
    });
    expect(parseObjectFilter(field({ key: 'a', kind: 'date' }), '2026-01-02')).toEqual({
      column: 'time',
      value: new Date('2026-01-02T00:00:00.000Z'),
    });
  });

  it('says so when the value could not be of that kind', () => {
    expect(parseObjectFilter(field({ key: 'a', kind: 'number' }), 'abc')).toBeNull();
    expect(parseObjectFilter(field({ key: 'a', kind: 'number' }), '')).toBeNull();
    expect(parseObjectFilter(field({ key: 'a', kind: 'number' }), '0x10')).toBeNull();
    expect(parseObjectFilter(field({ key: 'a', kind: 'boolean' }), 'yes')).toBeNull();
    expect(parseObjectFilter(field({ key: 'a', kind: 'date' }), 'soon')).toBeNull();
    expect(parseObjectFilter(field({ key: 'a' }), 'nul\u0000')).toBeNull();
  });
});
