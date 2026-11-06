// Custom objects (KNOW-07, docs/02-architecture/02-domain-model.md section 5). Fixed field kinds, explicit
// limits, and nothing that could become billing, grants, approvals or Work Unit state. Pure: no clock, no
// database, nothing from the network, so a page and a worker reach the same answer.

export const OBJECT_FIELD_KINDS = [
  'text',
  'long_text',
  'number',
  'boolean',
  'date',
  'enum',
  'email',
  'url',
] as const;
export type ObjectFieldKind = (typeof OBJECT_FIELD_KINDS)[number];

export type ObjectField = {
  key: string;
  label: string;
  kind: ObjectFieldKind;
  required: boolean;
  /** Filtering is only offered on indexed fields, and a type has a small number of them. */
  indexed: boolean;
  /** Only for `enum`. */
  options?: readonly string[];
  /** Only for text kinds. Never above OBJECT_LIMITS.maxTextLength. */
  maxLength?: number;
};

export type ObjectRelationDefinition = {
  key: string;
  label: string;
  /** Another custom type in this tenant, by slug. Relations to core entities are M5's graph. */
  toTypeSlug: string;
  cardinality: 'one' | 'many';
};

export const OBJECT_LIMITS = {
  maxFields: 64,
  maxIndexedFields: 8,
  maxRelations: 16,
  maxTextLength: 2000,
  maxLongTextLength: 50_000,
  maxEnumOptions: 64,
  maxAttributesBytes: 256_000,
  maxTypesPerOrganization: 200,
} as const;

/**
 * The most an indexed text value may take, in bytes. PostgreSQL refuses a btree entry above about 2700 bytes,
 * so two thousand characters of a wide script would otherwise fail as a server error when saved. It is measured
 * in bytes because that is what the index counts.
 */
export const OBJECT_INDEXED_TEXT_MAX_BYTES = 2000;

const MAX_LABEL_LENGTH = 120;
const MAX_REPORTED_KEY = 64;

/** Words a custom type may not take, because the platform already means something by them. */
export const RESERVED_OBJECT_SLUGS = [
  'work_unit',
  'approval',
  'grant',
  'invoice',
  'billing',
  'membership',
  'organization',
  'agent',
  'secret',
] as const;

const SLUG = /^[a-z][a-z0-9_]{1,63}$/;
const KEY = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED: ReadonlySet<string> = new Set(RESERVED_OBJECT_SLUGS);
const KINDS: ReadonlySet<string> = new Set(OBJECT_FIELD_KINDS);
const LONGEST: Record<ObjectFieldKind, number | null> = {
  text: OBJECT_LIMITS.maxTextLength,
  long_text: OBJECT_LIMITS.maxLongTextLength,
  email: OBJECT_LIMITS.maxTextLength,
  url: OBJECT_LIMITS.maxTextLength,
  enum: null,
  number: null,
  boolean: null,
  date: null,
};

/**
 * Whether PostgreSQL can hold this text at all. A NUL or half of a surrogate pair is refused by both `text` and
 * `jsonb`, and would otherwise reach a person as a server error. `\p{Cs}` with the `u` flag matches only a lone
 * surrogate, because a whole pair reads as one character.
 */
export function isStorableText(value: string): boolean {
  return !value.includes('\u0000') && !/\p{Cs}/u.test(value);
}

const bytesOf = (value: string) => new TextEncoder().encode(value).length;

export type ObjectSchemaIssue = {
  path: string;
  code:
    | 'RESERVED_SLUG'
    | 'BAD_KEY'
    | 'DUPLICATE_KEY'
    | 'TOO_MANY_FIELDS'
    | 'TOO_MANY_INDEXED'
    | 'TOO_MANY_RELATIONS'
    | 'ENUM_NEEDS_OPTIONS'
    | 'BAD_LENGTH'
    | 'UNKNOWN_KIND';
};

const goodLabel = (label: unknown) =>
  typeof label === 'string' &&
  label.trim().length > 0 &&
  label.length <= MAX_LABEL_LENGTH &&
  isStorableText(label);

function fieldIssues(field: ObjectField, path: string): ObjectSchemaIssue[] {
  const issues: ObjectSchemaIssue[] = [];
  if (!goodLabel(field.label)) issues.push({ path: `${path}.label`, code: 'BAD_LENGTH' });
  if (!KINDS.has(field.kind)) {
    issues.push({ path: `${path}.kind`, code: 'UNKNOWN_KIND' });
    return issues;
  }
  if (field.kind === 'enum') {
    const { options } = field;
    if (!options || options.length === 0 || options.length > OBJECT_LIMITS.maxEnumOptions) {
      issues.push({ path: `${path}.options`, code: 'ENUM_NEEDS_OPTIONS' });
    } else if (!options.every(goodLabel)) {
      issues.push({ path: `${path}.options`, code: 'BAD_LENGTH' });
    } else if (new Set(options).size !== options.length) {
      issues.push({ path: `${path}.options`, code: 'DUPLICATE_KEY' });
    }
  } else if (field.options !== undefined) {
    issues.push({ path: `${path}.options`, code: 'ENUM_NEEDS_OPTIONS' });
  }
  if (field.maxLength !== undefined) {
    const longest = LONGEST[field.kind];
    if (
      longest === null ||
      !Number.isInteger(field.maxLength) ||
      field.maxLength < 1 ||
      field.maxLength > longest
    ) {
      issues.push({ path: `${path}.maxLength`, code: 'BAD_LENGTH' });
    }
  }
  // Every other kind fits an index entry. A long text does not, and nobody filters by one exactly.
  if (field.kind === 'long_text' && field.indexed) {
    issues.push({ path: `${path}.indexed`, code: 'BAD_LENGTH' });
  }
  return issues;
}

/** Everything wrong with a shape, by where. An empty list means it can be saved. */
export function validateObjectSchema(input: {
  slug: string;
  fields: readonly ObjectField[];
  relations: readonly ObjectRelationDefinition[];
}): readonly ObjectSchemaIssue[] {
  const issues: ObjectSchemaIssue[] = [];
  if (RESERVED.has(input.slug)) issues.push({ path: 'slug', code: 'RESERVED_SLUG' });
  else if (!SLUG.test(input.slug)) issues.push({ path: 'slug', code: 'BAD_KEY' });

  if (input.fields.length > OBJECT_LIMITS.maxFields) {
    issues.push({ path: 'fields', code: 'TOO_MANY_FIELDS' });
  }
  if (input.fields.filter((field) => field.indexed).length > OBJECT_LIMITS.maxIndexedFields) {
    issues.push({ path: 'fields', code: 'TOO_MANY_INDEXED' });
  }
  if (input.relations.length > OBJECT_LIMITS.maxRelations) {
    issues.push({ path: 'relations', code: 'TOO_MANY_RELATIONS' });
  }

  // Fields and relations share one set of keys, so a page or an API reader never has to ask which is meant.
  const seen = new Set<string>();
  const checkKey = (key: unknown, path: string) => {
    if (typeof key !== 'string' || !KEY.test(key)) {
      issues.push({ path: `${path}.key`, code: 'BAD_KEY' });
    } else if (seen.has(key)) {
      issues.push({ path: `${path}.key`, code: 'DUPLICATE_KEY' });
    } else {
      seen.add(key);
    }
  };
  input.fields.forEach((field, index) => {
    const path = `fields[${index}]`;
    checkKey(field.key, path);
    issues.push(...fieldIssues(field, path));
  });
  input.relations.forEach((relation, index) => {
    const path = `relations[${index}]`;
    checkKey(relation.key, path);
    if (!goodLabel(relation.label)) issues.push({ path: `${path}.label`, code: 'BAD_LENGTH' });
    if (RESERVED.has(relation.toTypeSlug)) {
      issues.push({ path: `${path}.toTypeSlug`, code: 'RESERVED_SLUG' });
    } else if (!SLUG.test(relation.toTypeSlug)) {
      issues.push({ path: `${path}.toTypeSlug`, code: 'BAD_KEY' });
    }
    if (relation.cardinality !== 'one' && relation.cardinality !== 'many') {
      issues.push({ path: `${path}.cardinality`, code: 'UNKNOWN_KIND' });
    }
  });
  return issues;
}

export type RecordIssue = {
  path: string;
  code: 'REQUIRED' | 'WRONG_KIND' | 'UNKNOWN_FIELD' | 'TOO_LONG' | 'NOT_AN_OPTION' | 'TOO_LARGE';
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A date or a moment. JavaScript rolls 31 February over to March, so the calendar is checked by hand. */
function parseObjectDate(value: string): Date | null {
  const match = DATE_ONLY.exec(value) ?? DATE_TIME.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A format check and nothing more. Whether anyone receives mail there is not something this can know. */
function looksLikeEmail(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

/**
 * Whether a page may turn this into a link. Parsed the way a browser parses it, because a browser ignores tabs
 * and newlines inside a scheme: `java\tscript:` is still javascript. Anything that does not parse as an absolute
 * URL, including a relative one, is shown as plain text.
 */
export function isSafeObjectLink(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** What may be stored in a `url` field: literally http or https, with nothing a browser would strip first. */
function looksLikeWebAddress(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value) && isSafeObjectLink(value);
}

const isTextKind = (kind: ObjectFieldKind) => LONGEST[kind] !== null;

function valueIssue(field: ObjectField, value: unknown): RecordIssue['code'] | null {
  switch (field.kind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'WRONG_KIND';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'WRONG_KIND';
    case 'date':
      return typeof value === 'string' && parseObjectDate(value) ? null : 'WRONG_KIND';
    case 'enum':
      if (typeof value !== 'string') return 'WRONG_KIND';
      return field.options?.includes(value) ? null : 'NOT_AN_OPTION';
    case 'text':
    case 'long_text':
    case 'email':
    case 'url': {
      if (typeof value !== 'string' || !isStorableText(value)) return 'WRONG_KIND';
      const longest = Math.min(field.maxLength ?? Infinity, LONGEST[field.kind] ?? Infinity);
      if (value.length > longest) return 'TOO_LONG';
      if (field.indexed && bytesOf(value) > OBJECT_INDEXED_TEXT_MAX_BYTES) return 'TOO_LONG';
      if (field.kind === 'email' && !looksLikeEmail(value)) return 'WRONG_KIND';
      if (field.kind === 'url' && !looksLikeWebAddress(value)) return 'WRONG_KIND';
      return null;
    }
    default:
      return 'WRONG_KIND';
  }
}

const isBlank = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** Unknown keys are refused, so a record can never carry a field its type does not declare. */
export function validateRecordAttributes(
  fields: readonly ObjectField[],
  attributes: Record<string, unknown>,
): readonly RecordIssue[] {
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return [{ path: 'attributes', code: 'WRONG_KIND' }];
  }
  const issues: RecordIssue[] = [];
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(attributes)) {
    if (!byKey.has(key)) {
      issues.push({ path: `attributes.${key.slice(0, MAX_REPORTED_KEY)}`, code: 'UNKNOWN_FIELD' });
    }
  }
  for (const field of fields) {
    // Own properties only, because every object answers for `constructor`, and that is a legal key.
    const value = Object.hasOwn(attributes, field.key) ? attributes[field.key] : undefined;
    if (isBlank(value)) {
      if (field.required) issues.push({ path: `attributes.${field.key}`, code: 'REQUIRED' });
      if (value === undefined || value === null) continue;
    }
    const code = valueIssue(field, value);
    if (code) issues.push({ path: `attributes.${field.key}`, code });
  }
  if (bytesOf(JSON.stringify(attributes)) > OBJECT_LIMITS.maxAttributesBytes) {
    issues.push({ path: 'attributes', code: 'TOO_LARGE' });
  }
  return issues;
}

export type TypeMigrationPlan = {
  /** Whether existing records can move without anyone deciding anything. */
  safe: boolean;
  steps: readonly (
    | { kind: 'add_optional'; key: string }
    | { kind: 'add_required'; key: string; refused: true }
    | { kind: 'remove'; key: string; refused: true }
    | { kind: 'change_kind'; key: string; refused: true }
    | { kind: 'widen_enum'; key: string }
    | { kind: 'narrow_enum'; key: string; refused: true }
    | { kind: 'change_index'; key: string }
  )[];
};

const longestOf = (field: ObjectField) =>
  Math.min(field.maxLength ?? Infinity, LONGEST[field.kind] ?? Infinity);

/** What moving from one shape to the next would do. A step that could lose data is refused. */
export function planTypeMigration(
  from: readonly ObjectField[],
  to: readonly ObjectField[],
): TypeMigrationPlan {
  const steps: TypeMigrationPlan['steps'][number][] = [];
  const before = new Map(from.map((field) => [field.key, field]));
  const after = new Set(to.map((field) => field.key));
  for (const field of from) {
    if (!after.has(field.key)) steps.push({ kind: 'remove', key: field.key, refused: true });
  }
  for (const field of to) {
    const { key } = field;
    const old = before.get(key);
    if (!old) {
      steps.push(
        field.required
          ? { kind: 'add_required', key, refused: true }
          : { kind: 'add_optional', key },
      );
      continue;
    }
    if (old.kind !== field.kind) {
      steps.push({ kind: 'change_kind', key, refused: true });
      continue;
    }
    // A field that becomes required leaves every record without it invalid, just as a new required one does.
    if (field.required && !old.required) steps.push({ kind: 'add_required', key, refused: true });
    // A shorter limit is a narrower kind of text: a record that fitted the old one may not fit this one.
    if (isTextKind(field.kind) && longestOf(field) < longestOf(old)) {
      steps.push({ kind: 'change_kind', key, refused: true });
    }
    if (field.kind === 'enum') {
      const wanted = new Set(field.options ?? []);
      const had = new Set(old.options ?? []);
      if ([...had].some((option) => !wanted.has(option))) {
        steps.push({ kind: 'narrow_enum', key, refused: true });
      } else if ([...wanted].some((option) => !had.has(option))) {
        steps.push({ kind: 'widen_enum', key });
      }
    }
    if (old.indexed !== field.indexed) steps.push({ kind: 'change_index', key });
  }
  return { safe: !steps.some((step) => 'refused' in step), steps };
}

/**
 * Moves one record's attributes to the new shape. Pure, and only called after a `safe` plan. Every step a safe
 * plan can hold leaves the values as they are: a new optional field has no value yet, a wider enum still holds
 * the old ones, and an index lives beside the attributes. So this copies, and refuses anything unsafe rather
 * than guess at what a refused step would have lost.
 */
export function migrateRecordAttributes(
  plan: TypeMigrationPlan,
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  if (!plan.safe) throw new Error('OBJECT_MIGRATION_PLAN_UNSAFE');
  return { ...attributes };
}

export type IndexedValue = {
  fieldKey: string;
  valueText: string | null;
  valueNumber: string | null;
  valueTime: Date | null;
  valueBoolean: boolean | null;
};

/** The rows `record_values` should hold for a record, which is what filtering reads instead of its JSON. */
export function indexedValues(
  fields: readonly ObjectField[],
  attributes: Record<string, unknown>,
): readonly IndexedValue[] {
  const rows: IndexedValue[] = [];
  for (const field of fields) {
    if (!field.indexed || !Object.hasOwn(attributes, field.key)) continue;
    const value = attributes[field.key];
    if (value === null || value === undefined) continue;
    const row: IndexedValue = {
      fieldKey: field.key,
      valueText: null,
      valueNumber: null,
      valueTime: null,
      valueBoolean: null,
    };
    if (field.kind === 'number' && typeof value === 'number') row.valueNumber = String(value);
    else if (field.kind === 'boolean' && typeof value === 'boolean') row.valueBoolean = value;
    else if (field.kind === 'date' && typeof value === 'string') {
      row.valueTime = parseObjectDate(value);
    } else if (typeof value === 'string') row.valueText = value;
    rows.push(row);
  }
  return rows;
}

export type ObjectFilterValue =
  | { column: 'text'; value: string }
  | { column: 'number'; value: string }
  | { column: 'time'; value: Date }
  | { column: 'boolean'; value: boolean };

const PLAIN_NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** What someone typed into a filter, as the column that holds it. Null when it could not be of that kind. */
export function parseObjectFilter(field: ObjectField, equals: string): ObjectFilterValue | null {
  if (!isStorableText(equals)) return null;
  switch (field.kind) {
    case 'number': {
      const number = Number(equals);
      if (!PLAIN_NUMBER.test(equals) || !Number.isFinite(number)) return null;
      return { column: 'number', value: String(number) };
    }
    case 'boolean':
      if (equals === 'true') return { column: 'boolean', value: true };
      return equals === 'false' ? { column: 'boolean', value: false } : null;
    case 'date': {
      const moment = parseObjectDate(equals);
      return moment ? { column: 'time', value: moment } : null;
    }
    default:
      return { column: 'text', value: equals };
  }
}
