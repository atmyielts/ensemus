// What a tool that works through a connection needs from the gateway (ADR-038 D6). Plain data with no
// import, so the web tier, the policy package and the connector worker read the same list. The tools
// themselves are in `./ai-tools`: this file only says which connection each one may use and how.
//
// Scope strings are literals here, not `CAPABILITY_SCOPES` from `./workspace-suites`, because that file
// imports Node's crypto and this one reaches pages. A unit test holds every scope below to that table.

/** Connector types a tool can be bound to. `email_smtp` is M3's, and the other two are ADR-038's. */
export const TOOL_CONNECTOR_TYPES = ['email_smtp', 'google_workspace', 'microsoft_365'] as const;
export type ToolConnectorType = (typeof TOOL_CONNECTOR_TYPES)[number];

/** The two that a person connects by consent, and so the two whose tools depend on a person's grant. */
export const SUITE_TOOL_CONNECTOR_TYPES: readonly ToolConnectorType[] = [
  'google_workspace',
  'microsoft_365',
];

/** How far a provider's answer about an earlier try can be believed. Matches the connector SDK's. */
export type ToolReconcileKind = 'none' | 'best_effort' | 'authoritative';

/**
 * Whose connection a tool may use (ADR-038 D5). Never another member's, whatever this says: `member`
 * means the run's initiator's own, `organization` means one no member owns, and `either` means both.
 */
export type ToolOwnerRule = 'organization' | 'member' | 'either';

/** One connector type's terms for one tool. */
export type ToolBinding = {
  /** Every one of these must be in the connection's `granted_scopes`, or the tool refuses first. */
  scopes: readonly string[];
  /** After a timeout. `authoritative` only where the provider can prove a thing did not happen. */
  reconcile: ToolReconcileKind;
  /** The provider dedupes on a key we choose, so a repeat cannot make a second effect. */
  nativeIdempotency: boolean;
};

/** ADR-038 D3's capability a tool's scopes come from, or null for a connector with no capabilities. */
export type ToolCapability = 'files' | 'mail' | 'calendar' | 'documents' | 'chat';

export type ConnectionRule = {
  /** The connector types this tool can use. A test holds this equal to the keys of `bindings`. */
  connectorTypes: readonly ToolConnectorType[];
  bindings: Readonly<Partial<Record<ToolConnectorType, ToolBinding>>>;
  capability: ToolCapability | null;
  owner: ToolOwnerRule;
  /**
   * What the initiator must hold in the source's synced ACL for content the organization's connection
   * reaches. A member's own connection is their own account, so this applies to organization-owned
   * connections only. Null means the tool reaches no existing resource there.
   */
  resourceAccess: 'read' | 'write' | null;
  /**
   * The argument naming the one resource the tool reads or changes, checked before anything runs. Null with
   * `resourceAccess` set means the tool returns many (a search), and each result is checked instead. Its
   * value must be exactly the external ID the connector's sync stores: one argument is that ID as given
   * (a Google Drive file ID); several are the JSON array of their values in this order (a Microsoft drive
   * item, which the sync keys as `["drive", "item"]`).
   */
  resourceArg: string | readonly string[] | null;
  /** The most the tool's output may put in front of the next turn. Larger is refused, never cut. */
  maxOutputBytes: number;
};

const google = (scope: string) => `https://www.googleapis.com/auth/${scope}`;

const SEARCH_BYTES = 262_144;
const READ_BYTES = 1_048_576;
/** A change's output is only its status, so anything larger means something went wrong. */
const STATUS_BYTES = 4_096;

const bind = (
  scopes: readonly string[],
  reconcile: ToolReconcileKind = 'best_effort',
  nativeIdempotency = false,
): ToolBinding => ({ scopes, reconcile, nativeIdempotency });

const onGoogle = (
  rule: Omit<ConnectionRule, 'connectorTypes' | 'bindings'>,
  binding: ToolBinding,
): ConnectionRule => ({
  ...rule,
  connectorTypes: ['google_workspace'],
  bindings: { google_workspace: binding },
});

const onMicrosoft = (
  rule: Omit<ConnectionRule, 'connectorTypes' | 'bindings'>,
  binding: ToolBinding,
): ConnectionRule => ({
  ...rule,
  connectorTypes: ['microsoft_365'],
  bindings: { microsoft_365: binding },
});

const mine = (capability: ToolCapability, maxOutputBytes: number) => ({
  capability,
  owner: 'member' as const,
  resourceAccess: null,
  resourceArg: null,
  maxOutputBytes,
});

const shared = (
  capability: ToolCapability,
  access: 'read' | 'write' | null,
  resourceArg: string | readonly string[] | null,
  maxOutputBytes: number,
  owner: ToolOwnerRule = 'either',
) => ({ capability, owner, resourceAccess: access, resourceArg, maxOutputBytes });

/** `email.send`, on the rule like every other tool. SMTP has no scopes and no owner but the organization. */
export const EMAIL_SEND_CONNECTION: ConnectionRule = {
  connectorTypes: ['email_smtp'],
  bindings: { email_smtp: bind([], 'none') },
  capability: null,
  owner: 'organization',
  resourceAccess: null,
  resourceArg: null,
  maxOutputBytes: STATUS_BYTES,
};

/** A Microsoft drive item, as M5's drive sync keys it: `["drive", "item"]`. */
const DRIVE_ITEM = ['drive_id', 'item_id'] as const;

const calendarBindings = (write: boolean, create: boolean) => ({
  connectorTypes: ['google_workspace', 'microsoft_365'] as const,
  bindings: {
    // Google takes an event ID we choose, so a create that timed out can be looked up by that ID, and
    // not finding it proves it was not made (ADR-038 D6).
    google_workspace: write
      ? bind([google('calendar.events')], create ? 'authoritative' : 'best_effort', create)
      : bind([google('calendar.events')], 'none'),
    // Microsoft dedupes a create on `transactionId`, but has no lookup that can prove absence.
    microsoft_365: write
      ? bind(['Calendars.ReadWrite'], 'best_effort', create)
      : bind(['Calendars.ReadWrite'], 'none'),
  },
});

/**
 * Every suite tool's connection rule, by tool ID (ADR-038 D6). IDs are provider-neutral where both
 * providers take the same arguments (calendar), and provider-specific otherwise.
 */
export const SUITE_CONNECTION_RULES = {
  // --- Google Workspace.
  'gmail.search': onGoogle(mine('mail', SEARCH_BYTES), bind([google('gmail.readonly')], 'none')),
  'gmail.read_thread': onGoogle(mine('mail', READ_BYTES), bind([google('gmail.readonly')], 'none')),
  'gmail.create_draft': onGoogle(mine('mail', STATUS_BYTES), bind([google('gmail.compose')])),
  'gmail.send': onGoogle(mine('mail', STATUS_BYTES), bind([google('gmail.send')])),
  'drive.search': onGoogle(
    shared('files', 'read', null, SEARCH_BYTES, 'organization'),
    bind([google('drive.metadata.readonly')], 'none'),
  ),
  // Through the organization's connection a new file lands in a folder everyone's content shares, so the
  // initiator must hold write on that folder by the source's synced ACL. No folder, or one never synced,
  // is refused there. A member's own connection is their own Drive.
  'drive.create_file': onGoogle(
    shared('documents', 'write', 'parent_id', STATUS_BYTES),
    bind([google('drive.file')]),
  ),
  'docs.read': onGoogle(
    shared('documents', 'read', 'document_id', READ_BYTES),
    bind([google('documents')], 'none'),
  ),
  'docs.edit': onGoogle(
    shared('documents', 'write', 'document_id', STATUS_BYTES),
    bind([google('documents')]),
  ),
  'sheets.read_range': onGoogle(
    shared('documents', 'read', 'spreadsheet_id', READ_BYTES),
    bind([google('spreadsheets')], 'none'),
  ),
  'sheets.write_range': onGoogle(
    shared('documents', 'write', 'spreadsheet_id', STATUS_BYTES),
    bind([google('spreadsheets')]),
  ),

  // --- Both, where the arguments are the same.
  'calendar.list_events': { ...mine('calendar', READ_BYTES), ...calendarBindings(false, false) },
  'calendar.create_event': { ...mine('calendar', STATUS_BYTES), ...calendarBindings(true, true) },
  'calendar.update_event': { ...mine('calendar', STATUS_BYTES), ...calendarBindings(true, false) },

  // --- Microsoft 365, through Graph.
  'outlook.search': onMicrosoft(mine('mail', SEARCH_BYTES), bind(['Mail.ReadWrite'], 'none')),
  'outlook.read_thread': onMicrosoft(mine('mail', READ_BYTES), bind(['Mail.ReadWrite'], 'none')),
  'outlook.create_draft': onMicrosoft(mine('mail', STATUS_BYTES), bind(['Mail.ReadWrite'])),
  'outlook.send': onMicrosoft(mine('mail', STATUS_BYTES), bind(['Mail.Send'])),
  'onedrive.search': onMicrosoft(
    shared('files', 'read', null, SEARCH_BYTES, 'organization'),
    bind(['Files.Read.All'], 'none'),
  ),
  // As Drive's: through the organization's connection, write on the parent folder, named by its drive and
  // ID as the drive sync keys it.
  'onedrive.create_file': onMicrosoft(
    shared('documents', 'write', ['drive_id', 'parent_id'], STATUS_BYTES),
    bind(['Files.ReadWrite']),
  ),
  'word.read': onMicrosoft(
    shared('documents', 'read', DRIVE_ITEM, READ_BYTES),
    bind(['Files.ReadWrite'], 'none'),
  ),
  'excel.read_range': onMicrosoft(
    shared('documents', 'read', DRIVE_ITEM, READ_BYTES),
    bind(['Files.ReadWrite'], 'none'),
  ),
  'excel.write_range': onMicrosoft(
    shared('documents', 'write', DRIVE_ITEM, STATUS_BYTES),
    bind(['Files.ReadWrite']),
  ),
  // A channel message takes no key of ours, and reading the channel back needs a scope this tool does
  // not ask for, so nothing can ever be looked up: a timeout is `unknown`, for a person to check.
  'teams.post_message': onMicrosoft(
    mine('chat', STATUS_BYTES),
    bind(['ChannelMessage.Send'], 'none'),
  ),
} as const satisfies Readonly<Record<string, ConnectionRule>>;

export type SuiteToolId = keyof typeof SUITE_CONNECTION_RULES;

export const isSuiteConnectorType = (type: string): boolean =>
  (SUITE_TOOL_CONNECTOR_TYPES as readonly string[]).includes(type);

/** A rule whose tool depends on a person's grant at Google or Microsoft, not on an SMTP relay. */
export const isSuiteRule = (rule: ConnectionRule): boolean =>
  rule.connectorTypes.some(isSuiteConnectorType);
