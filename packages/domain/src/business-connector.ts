// CRM, ticketing and accounting connectors (EXP-02, ADR-033 D2 and D3). Pure data and small rules, so the
// web tier, the application services and the connectors all read one list of what each stream holds and
// what may be changed. No vendor appears here: a connector speaks the adapter protocol in
// @ensemus/contracts/business-adapter, and the external system stays authoritative.
import type { Classification } from './policy';

export const CRM_CONNECTOR_TYPE = 'crm_http';
export const TICKETING_CONNECTOR_TYPE = 'ticketing_http';
export const ACCOUNTING_CONNECTOR_TYPE = 'accounting_http';

export const BUSINESS_CONNECTOR_TYPES = [
  CRM_CONNECTOR_TYPE,
  TICKETING_CONNECTOR_TYPE,
  ACCOUNTING_CONNECTOR_TYPE,
] as const;
export type BusinessConnectorType = (typeof BUSINESS_CONNECTOR_TYPES)[number];

export const isBusinessConnectorType = (value: string): value is BusinessConnectorType =>
  (BUSINESS_CONNECTOR_TYPES as readonly string[]).includes(value);

export type BusinessFieldType = 'text' | 'decimal' | 'integer' | 'boolean' | 'date' | 'datetime';

export type BusinessFieldRule = {
  type: BusinessFieldType;
  /** Longest stored text. Past this the page is refused rather than cut, so nothing is half true. */
  maxLength?: number;
  /** Whether a person can propose changing it. Everything else is read only here. */
  writable: boolean;
};

export type BusinessStreamRule = {
  /** The record's name in a list. It has to be one of `fields`. */
  titleField: string;
  fields: Readonly<Record<string, BusinessFieldRule>>;
};

const text = (maxLength: number, writable = false): BusinessFieldRule => ({
  type: 'text',
  maxLength,
  writable,
});
const decimal = (): BusinessFieldRule => ({ type: 'decimal', writable: false });
const date = (writable = false): BusinessFieldRule => ({ type: 'date', writable });

/**
 * What each stream keeps. The allowlist is the point: "selected records" in the capability catalog means a
 * field nobody listed is never stored, however much a source sends. Money fields are read only in every
 * stream, and a test holds that.
 */
export const BUSINESS_STREAMS: Readonly<
  Record<BusinessConnectorType, Readonly<Record<string, BusinessStreamRule>>>
> = {
  [CRM_CONNECTOR_TYPE]: {
    'crm.accounts': {
      titleField: 'name',
      fields: {
        name: text(300),
        status: text(64, true),
        owner_ref: text(200),
        next_step: text(1000, true),
      },
    },
    'crm.contacts': {
      titleField: 'name',
      fields: {
        name: text(300),
        email: text(254),
        phone: text(64),
        company_ref: text(200),
        job_title: text(200, true),
        status: text(64, true),
      },
    },
    'crm.deals': {
      titleField: 'name',
      fields: {
        name: text(300),
        stage: text(64, true),
        amount: decimal(),
        currency: text(3),
        close_on: date(true),
        owner_ref: text(200),
        next_step: text(1000, true),
      },
    },
  },
  [TICKETING_CONNECTOR_TYPE]: {
    'ticketing.tickets': {
      titleField: 'subject',
      fields: {
        subject: text(300),
        status: text(64, true),
        priority: text(64, true),
        assignee_ref: text(200, true),
        requester_ref: text(200),
        due_on: date(true),
      },
    },
    'ticketing.comments': {
      titleField: 'author_ref',
      fields: {
        ticket_ref: text(200),
        author_ref: text(200),
        visibility: text(16),
        body: text(8000),
        posted_at: { type: 'datetime', writable: false },
      },
    },
  },
  [ACCOUNTING_CONNECTOR_TYPE]: {
    'accounting.invoices': {
      titleField: 'number',
      fields: {
        number: text(64),
        status: text(64),
        customer_ref: text(200),
        total: decimal(),
        currency: text(3),
        due_on: date(),
        memo: text(1000, true),
        reference: text(200, true),
      },
    },
    'accounting.bills': {
      titleField: 'number',
      fields: {
        number: text(64),
        status: text(64),
        vendor_ref: text(200),
        total: decimal(),
        currency: text(3),
        due_on: date(),
        memo: text(1000, true),
        reference: text(200, true),
      },
    },
    'accounting.payments': {
      titleField: 'reference',
      fields: {
        reference: text(200),
        direction: text(16),
        amount: decimal(),
        currency: text(3),
        paid_on: date(),
      },
    },
  },
};

/** The stream's owner, or undefined for a name no connector declares. */
export function connectorTypeOfStream(stream: string): BusinessConnectorType | undefined {
  return BUSINESS_CONNECTOR_TYPES.find((type) =>
    Object.prototype.hasOwnProperty.call(BUSINESS_STREAMS[type], stream),
  );
}

export const streamRuleFor = (stream: string): BusinessStreamRule | undefined => {
  const type = connectorTypeOfStream(stream);
  return type ? BUSINESS_STREAMS[type][stream] : undefined;
};

export const CRM_RECORD_UPDATE_TOOL = 'crm.record.update';
export const TICKETING_RECORD_UPDATE_TOOL = 'ticketing.record.update';
/** An internal note. A customer-facing reply is an email or a later tool, and has no path here. */
export const TICKETING_COMMENT_ADD_TOOL = 'ticketing.comment.add';
export const ACCOUNTING_RECORD_UPDATE_TOOL = 'accounting.record.update';
/** A draft in the accounting system, for a person there to review. It posts and pays nothing. */
export const ACCOUNTING_INVOICE_DRAFT_TOOL = 'accounting.invoice_draft.create';
export const BUSINESS_TOOL_VERSION = '1';

/** Every effect these connectors can have. Nothing that moves money is on it, and a test holds that. */
export const BUSINESS_TOOLS: Readonly<Record<BusinessConnectorType, readonly string[]>> = {
  [CRM_CONNECTOR_TYPE]: [CRM_RECORD_UPDATE_TOOL],
  [TICKETING_CONNECTOR_TYPE]: [TICKETING_RECORD_UPDATE_TOOL, TICKETING_COMMENT_ADD_TOOL],
  [ACCOUNTING_CONNECTOR_TYPE]: [ACCOUNTING_RECORD_UPDATE_TOOL, ACCOUNTING_INVOICE_DRAFT_TOOL],
};

export const isToolOf = (connectorType: string, toolName: string): boolean =>
  isBusinessConnectorType(connectorType) && BUSINESS_TOOLS[connectorType].includes(toolName);

/** The provider scope each kind asks for. `granted_scopes` on the connection says what it was given. */
export const readScopeFor = (type: BusinessConnectorType) => `${type}.read`;
export const writeScopeFor = (type: BusinessConnectorType) => `${type}.write`;

/** Whether this connection may do that at all. Checked when proposing and again before sending. */
export const hasWriteScope = (type: BusinessConnectorType, granted: readonly string[]): boolean =>
  granted.includes(writeScopeFor(type));

const RANK: Readonly<Record<Classification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** What a stored record starts from when its source says less. Accounting is never below this. */
const CLASSIFICATION_FLOOR: Readonly<Record<BusinessConnectorType, Classification>> = {
  [CRM_CONNECTOR_TYPE]: 'internal',
  [TICKETING_CONNECTOR_TYPE]: 'internal',
  [ACCOUNTING_CONNECTOR_TYPE]: 'confidential',
};

/** A source can raise a record's class and cannot lower it past the floor (security blueprint §3). */
export function recordClassification(
  type: BusinessConnectorType,
  reported: Classification | undefined,
): Classification {
  const floor = CLASSIFICATION_FLOOR[type];
  return reported !== undefined && RANK[reported] > RANK[floor] ? reported : floor;
}

/** Matches the CHECK on integrations.business_records. */
export const MAX_RECORD_FIELDS_BYTES = 65_536;

export type RecordFieldValue = string | number | boolean | null;
export type RecordFields = Readonly<Record<string, RecordFieldValue>>;

const DECIMAL = /^-?\d{1,18}(\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validValue(rule: BusinessFieldRule, value: RecordFieldValue): boolean {
  if (value === null) return true;
  switch (rule.type) {
    case 'text':
      return (
        typeof value === 'string' &&
        value.length <= (rule.maxLength ?? 0) &&
        // A null byte cannot be stored, and nothing a source says needs one.
        !value.includes('\0')
      );
    // Money stays a string, so a float never rounds what an accounting system said.
    case 'decimal':
      return typeof value === 'string' && DECIMAL.test(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return (
        typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}Z`))
      );
    case 'datetime':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
  }
}

export type RecordFieldsCheck = { ok: true; fields: RecordFields } | { ok: false };

/**
 * Keeps the fields this stream lists and drops any other, then refuses the whole record if a listed one is
 * the wrong shape. A field nobody listed is not an error, since sources add fields without asking.
 */
export function selectRecordFields(
  stream: string,
  raw: Readonly<Record<string, unknown>>,
): RecordFieldsCheck {
  const rule = streamRuleFor(stream);
  if (!rule) return { ok: false };
  const fields: Record<string, RecordFieldValue> = {};
  for (const [name, fieldRule] of Object.entries(rule.fields)) {
    const value = raw[name];
    if (value === undefined) continue;
    if (!validValue(fieldRule, value as RecordFieldValue)) return { ok: false };
    fields[name] = value as RecordFieldValue;
  }
  if (Buffer.byteLength(JSON.stringify(fields)) > MAX_RECORD_FIELDS_BYTES) return { ok: false };
  return { ok: true, fields };
}

export type RecordChangeCheck = { ok: true } | { ok: false };

/** A proposed change names only writable fields of this stream, each the right shape, and at least one. */
export function checkRecordChange(
  stream: string,
  changes: Readonly<Record<string, unknown>>,
): RecordChangeCheck {
  const rule = streamRuleFor(stream);
  if (!rule) return { ok: false };
  const entries = Object.entries(changes);
  if (entries.length === 0) return { ok: false };
  for (const [name, value] of entries) {
    if (!Object.prototype.hasOwnProperty.call(rule.fields, name)) return { ok: false };
    const fieldRule = rule.fields[name] as BusinessFieldRule;
    if (!fieldRule.writable) return { ok: false };
    if (!validValue(fieldRule, value as RecordFieldValue)) return { ok: false };
  }
  return { ok: true };
}

/**
 * Who may read a stored record's fields (ADR-033 D3). The source's own permissions, mapped to people here,
 * and nothing else: being an owner or admin of the organization gives no way in, because the external
 * system never said so. A record with no mapped grant is readable by nobody, which is how a source with
 * no permissions, or a stream that has not synced yet, fails closed.
 */
export type RecordAccessFacts = {
  aclState: 'mapped' | 'partial' | 'unmapped' | null;
  /** A source grant that maps to this person, or to a team they are on. */
  viewerHasGrant: boolean;
  deleted: boolean;
};

export const canReadBusinessRecord = (facts: RecordAccessFacts): boolean =>
  !facts.deleted &&
  facts.aclState !== null &&
  facts.aclState !== 'unmapped' &&
  facts.viewerHasGrant;
