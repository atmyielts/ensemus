// Custom objects (KNOW-07, docs/02-architecture/02-domain-model.md section 5). Fixed field kinds, explicit
// limits, and nothing that could become billing, grants, approvals or Work Unit state. The objects slice
// fills in the three functions at the end.

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

export function validateObjectSchema(
  _input: { slug: string; fields: readonly ObjectField[]; relations: readonly ObjectRelationDefinition[] },
): readonly ObjectSchemaIssue[] {
  throw new Error('NOT_IMPLEMENTED');
}

export type RecordIssue = {
  path: string;
  code: 'REQUIRED' | 'WRONG_KIND' | 'UNKNOWN_FIELD' | 'TOO_LONG' | 'NOT_AN_OPTION' | 'TOO_LARGE';
};

/** Unknown keys are refused, so a record can never carry a field its type does not declare. */
export function validateRecordAttributes(
  _fields: readonly ObjectField[],
  _attributes: Record<string, unknown>,
): readonly RecordIssue[] {
  throw new Error('NOT_IMPLEMENTED');
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

/** What moving from one shape to the next would do. A step that could lose data is refused. */
export function planTypeMigration(
  _from: readonly ObjectField[],
  _to: readonly ObjectField[],
): TypeMigrationPlan {
  throw new Error('NOT_IMPLEMENTED');
}

/** Moves one record's attributes to the new shape. Pure, and only called after a `safe` plan. */
export function migrateRecordAttributes(
  _plan: TypeMigrationPlan,
  _attributes: Record<string, unknown>,
): Record<string, unknown> {
  throw new Error('NOT_IMPLEMENTED');
}
