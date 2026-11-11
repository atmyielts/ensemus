// What a reviewer sees of a change an agent wants to make through Google Workspace or Microsoft 365
// (ADR-038 D6). One view per suite tool that writes or drafts, built only from the payload the approval
// binds and this organization's own rows: never from anything a provider said. Pure, so every tool's view
// is tested without a page. The page writes each text out with `showInvisible`, and React keeps it text.
import { parseSuiteActionPayload } from '@ensemus/contracts/ai-tools';
import type { SuiteToolArgs } from '@ensemus/contracts/suite-tools';
import { toolManifest } from '@ensemus/domain/ai-tools';
import type { SuiteToolId } from '@ensemus/domain/suite-tools';

/** One address, and whether it belongs to no active member here. */
export type ViewAddress = { address: string; outside: boolean };

export type ViewField =
  | { kind: 'text'; label: string; text: string }
  | { kind: 'addresses'; label: string; addresses: readonly ViewAddress[] }
  /** Longer text, shown as written, line breaks and all. */
  | { kind: 'body'; label: string; text: string }
  /** Cells as text, bounded. What is left out is counted, and the stored action below holds it all. */
  | {
      kind: 'table';
      label: string;
      rows: readonly (readonly string[])[];
      hiddenRows: number;
      hiddenColumns: number;
    };

export type SuiteActionView = {
  /** The heading over the payload. */
  heading: string;
  /** One or two sentences on what this reaches, for the risk line. */
  reach: string;
  fields: readonly ViewField[];
};

/** What only this organization's rows can say. */
export type SuiteViewFacts = {
  connection: {
    connectorType: string;
    displayName: string;
    ownerKind: 'organization' | 'member';
    ownerName: string | null;
  } | null;
  /** Lower-cased addresses of active members here. Anyone else is outside the organization. */
  memberAddresses: ReadonlySet<string>;
};

/** Every suite tool that changes something or drafts, each with the view a reviewer relies on. */
export type SuiteWriteToolId = Exclude<
  SuiteToolId,
  | 'gmail.search'
  | 'gmail.read_thread'
  | 'drive.search'
  | 'docs.read'
  | 'sheets.read_range'
  | 'calendar.list_events'
  | 'outlook.search'
  | 'outlook.read_thread'
  | 'onedrive.search'
  | 'word.read'
  | 'excel.read_range'
>;

type Payload<Id extends SuiteWriteToolId> = Omit<SuiteToolArgs<Id>, 'connection_id'>;
type Build<Id extends SuiteWriteToolId> = (
  payload: Payload<Id>,
  facts: SuiteViewFacts,
) => Omit<SuiteActionView, 'fields'> & { fields: ViewField[] };

export const TABLE_MAX_ROWS = 50;
export const TABLE_MAX_COLUMNS = 20;
const CELL_MAX = 500;

const PROVIDERS: Readonly<Record<string, string>> = {
  google_workspace: 'Google Workspace',
  microsoft_365: 'Microsoft 365',
};

const text = (label: string, value: string): ViewField => ({ kind: 'text', label, text: value });
const body = (label: string, value: string): ViewField => ({ kind: 'body', label, text: value });

function addresses(label: string, list: readonly string[] | undefined, facts: SuiteViewFacts) {
  if (!list || list.length === 0) return [];
  return [
    {
      kind: 'addresses' as const,
      label,
      addresses: list.map((address) => ({
        address,
        outside: !facts.memberAddresses.has(address.toLowerCase()),
      })),
    },
  ];
}

function outsideCount(list: readonly string[], facts: SuiteViewFacts) {
  return list.filter((address) => !facts.memberAddresses.has(address.toLowerCase())).length;
}

const people = (count: number) => (count === 1 ? 'one person' : `${count} people`);

function outsideWords(list: readonly string[], facts: SuiteViewFacts) {
  const outside = outsideCount(list, facts);
  if (outside === 0) return 'all of them members here';
  if (outside === list.length)
    return list.length === 1 ? 'not a member here' : 'none of them members here';
  return `${outside} of them not members here`;
}

/** Whose account it is, from this organization's own record of the connection. */
function connectionField(facts: SuiteViewFacts): ViewField {
  const connection = facts.connection;
  if (!connection)
    return text('Through', 'A connection you cannot see. Deny it if you are not sure.');
  const provider = PROVIDERS[connection.connectorType] ?? 'An unknown provider';
  const whose =
    connection.ownerKind === 'organization'
      ? 'the organization’s connection'
      : `${connection.ownerName ?? 'someone no longer here'}’s own account`;
  return text('Through', `${provider}, ${whose}, named “${connection.displayName}”`);
}

function ownerWords(facts: SuiteViewFacts) {
  const connection = facts.connection;
  if (!connection || connection.ownerKind === 'organization') return 'the connected account’s';
  return `${connection.ownerName ?? 'someone no longer here'}’s`;
}

/** An instant as the payload gives it, and as a clock in the event's own zone reads it. */
export function timeWords(instant: string, zone: string | undefined): string {
  if (!zone) return `${instant}, in the event’s current time zone`;
  try {
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      dateStyle: 'full',
      timeStyle: 'long',
    }).format(new Date(instant));
    return `${local} (${instant}, ${zone})`;
  } catch {
    return `${instant} (${zone}, a time zone this server does not know)`;
  }
}

const SEND_UPDATES_WORDS = {
  all: 'Everyone invited is told by the provider',
  external_only: 'Only guests who do not use Google Calendar are told',
  none: 'Nobody is told',
} as const;

function calendarWords(calendarId: string) {
  return calendarId === 'primary' ? 'Their main calendar' : `Calendar ${calendarId}`;
}

function table(label: string, values: readonly (readonly unknown[])[], emptyMeans: string) {
  const width = Math.max(0, ...values.map((row) => row.length));
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return emptyMeans;
    const words = String(value);
    return words.length > CELL_MAX
      ? `${words.slice(0, CELL_MAX)}… (cut here, not in the change)`
      : words;
  };
  return {
    kind: 'table' as const,
    label,
    rows: values.slice(0, TABLE_MAX_ROWS).map((row) => row.slice(0, TABLE_MAX_COLUMNS).map(cell)),
    hiddenRows: Math.max(0, values.length - TABLE_MAX_ROWS),
    hiddenColumns: Math.max(0, width - TABLE_MAX_COLUMNS),
  };
}

function mailView(kind: 'send' | 'draft'): Build<'gmail.send'> {
  return (payload, facts) => {
    const { message } = payload;
    const everyone = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
    const reach =
      kind === 'send'
        ? `This sends an email to ${people(everyone.length)}, ${outsideWords(everyone, facts)}, and it cannot be recalled.`
        : `This saves a draft in ${ownerWords(facts)} mailbox, addressed to ${people(everyone.length)}, ${outsideWords(everyone, facts)}. Nobody receives it until someone sends it.`;
    return {
      heading:
        kind === 'send' ? 'The exact email that would go' : 'The exact draft that would be saved',
      reach,
      fields: [
        connectionField(facts),
        ...addresses('To', message.to, facts),
        ...addresses('Copied', message.cc, facts),
        ...addresses('Copied without the others seeing', message.bcc, facts),
        text('Subject', message.subject),
        ...(message.in_reply_to
          ? [text('Answers', `The message with ID ${message.in_reply_to}, in its conversation`)]
          : []),
        body('Text', message.text_body),
      ],
    };
  };
}

const createEvent: Build<'calendar.create_event'> = (payload, facts) => ({
  heading: 'The exact event that would be created',
  reach:
    payload.attendees.length === 0
      ? 'This adds an event to a calendar, with nobody invited.'
      : `This adds an event and invites ${people(payload.attendees.length)}, ${outsideWords(payload.attendees, facts)}. ${SEND_UPDATES_WORDS[payload.send_updates]}.`,
  fields: [
    connectionField(facts),
    text('Calendar', calendarWords(payload.calendar_id)),
    text('Title', payload.summary),
    text('Starts', timeWords(payload.start, payload.time_zone)),
    text('Ends', timeWords(payload.end, payload.time_zone)),
    text('Time zone', payload.time_zone),
    ...(payload.location !== undefined ? [text('Where', payload.location)] : []),
    ...(payload.attendees.length
      ? addresses('Invited', payload.attendees, facts)
      : [text('Invited', 'Nobody')]),
    text('Who is told', SEND_UPDATES_WORDS[payload.send_updates]),
    ...(payload.description !== undefined ? [body('Description', payload.description)] : []),
  ],
});

const updateEvent: Build<'calendar.update_event'> = (payload, facts) => {
  const { changes } = payload;
  const zone = changes.time_zone;
  const invited = changes.attendees;
  return {
    heading: 'The exact change to an event',
    reach: `This changes an existing event. Only the fields below change. ${SEND_UPDATES_WORDS[payload.send_updates]}.`,
    fields: [
      connectionField(facts),
      text('Calendar', calendarWords(payload.calendar_id)),
      text('Event', payload.event_id),
      ...(changes.summary !== undefined ? [text('New title', changes.summary)] : []),
      ...(changes.start !== undefined ? [text('New start', timeWords(changes.start, zone))] : []),
      ...(changes.end !== undefined ? [text('New end', timeWords(changes.end, zone))] : []),
      ...(zone !== undefined ? [text('New time zone', zone)] : []),
      ...(changes.location !== undefined ? [text('New place', changes.location)] : []),
      ...(invited !== undefined
        ? invited.length
          ? addresses('Invited from now on, and only these', invited, facts)
          : [text('Invited from now on', 'Nobody: everyone invited is removed')]
        : []),
      text('Who is told', SEND_UPDATES_WORDS[payload.send_updates]),
      ...(changes.description !== undefined ? [body('New description', changes.description)] : []),
    ],
  };
};

function fileView(): Build<'drive.create_file'> {
  return (payload, facts) => {
    const bytes = new TextEncoder().encode(payload.text).length;
    return {
      heading: 'The exact file that would be created',
      reach: `This creates a new file in ${ownerWords(facts)} files. It replaces nothing.`,
      fields: [
        connectionField(facts),
        text('File name', payload.name),
        text('Kind', payload.media_type),
        text('Size', bytes === 1 ? '1 byte' : `${bytes.toLocaleString('en-GB')} bytes`),
        text(
          'Folder',
          payload.parent_id ? `The folder with ID ${payload.parent_id}` : 'The top folder',
        ),
        body('Contents', payload.text),
      ],
    };
  };
}

const docsEdit: Build<'docs.edit'> = (payload, facts) => ({
  heading: 'The exact edit to a document',
  reach: `This makes ${payload.edits.length === 1 ? 'one change' : `${payload.edits.length} changes`} to a document, in this order. Google refuses it if the document has changed since revision ${payload.required_revision_id}.`,
  fields: [
    connectionField(facts),
    text('Document', payload.document_id),
    text('Only if the document is still at revision', payload.required_revision_id),
    ...payload.edits.map((edit, index) => {
      const step = `Change ${index + 1}`;
      if (edit.kind === 'insert_text')
        return body(`${step}: insert at position ${edit.index}`, edit.text);
      if (edit.kind === 'delete_range')
        return text(`${step}: delete`, `Positions ${edit.start_index} up to ${edit.end_index}`);
      return body(
        `${step}: replace every “${edit.find}”${edit.match_case ? ', matching case,' : ''} with`,
        edit.replace === '' ? '(nothing: each is deleted)' : edit.replace,
      );
    }),
  ],
});

const sheetsWrite: Build<'sheets.write_range'> = (payload, facts) => ({
  heading: 'The exact cells that would change',
  reach: `This writes ${payload.values.length === 1 ? 'one row' : `${payload.values.length} rows`} of a spreadsheet, replacing what is there.`,
  fields: [
    connectionField(facts),
    text('Spreadsheet', payload.spreadsheet_id),
    text('Range', payload.range),
    text(
      'Read as',
      payload.value_input === 'raw'
        ? 'Exactly as written, nothing worked out'
        : 'As if a person typed it, so formulas and dates are worked out',
    ),
    table('Values', payload.values, '(left as it is)'),
  ],
});

const excelWrite: Build<'excel.write_range'> = (payload, facts) => ({
  heading: 'The exact cells that would change',
  reach: `This writes ${payload.values.length === 1 ? 'one row' : `${payload.values.length} rows`} of a workbook, replacing what is there.`,
  fields: [
    connectionField(facts),
    text('Drive', payload.drive_id),
    text('Workbook', payload.item_id),
    text('Worksheet', payload.worksheet),
    text('Range', payload.range),
    table('Values', payload.values, '(left as it is)'),
  ],
});

const teamsPost: Build<'teams.post_message'> = (payload, facts) => ({
  heading: 'The exact message that would be posted',
  reach:
    'This posts a message to a Teams channel, where everyone in the channel can read it, and it cannot be taken back.',
  fields: [
    connectionField(facts),
    text('Team', payload.team_id),
    text('Channel', payload.channel_id),
    ...(payload.subject !== undefined ? [text('Subject', payload.subject)] : []),
    body('Message', payload.text_body),
  ],
});

/** One view for every suite tool that writes or drafts. A test holds this to the manifests. */
export const SUITE_ACTION_VIEWS: { readonly [Id in SuiteWriteToolId]: Build<Id> } = {
  'gmail.send': mailView('send'),
  'gmail.create_draft': mailView('draft'),
  'outlook.send': mailView('send'),
  'outlook.create_draft': mailView('draft'),
  'calendar.create_event': createEvent,
  'calendar.update_event': updateEvent,
  'drive.create_file': fileView(),
  'onedrive.create_file': fileView(),
  'docs.edit': docsEdit,
  'sheets.write_range': sheetsWrite,
  'excel.write_range': excelWrite,
  'teams.post_message': teamsPost,
};

/**
 * The view of one stored suite action, or null: a tool with no view, a tool that is not a change, or a
 * payload that no longer fits its tool's schema. Null sends the page to the stored action as JSON, and the
 * page says nobody should approve what does not add up.
 */
export function suiteActionView(
  toolId: string,
  connectionId: string,
  payload: unknown,
  facts: SuiteViewFacts,
): SuiteActionView | null {
  if (!Object.hasOwn(SUITE_ACTION_VIEWS, toolId)) return null;
  const manifest = toolManifest(toolId);
  if (manifest?.class !== 'external_write' && manifest?.class !== 'draft_only') return null;
  // Parsed to check its shape only: the reviewer sees the payload exactly as stored and as it would go.
  if (!parseSuiteActionPayload(toolId, connectionId, payload)) return null;
  const build = SUITE_ACTION_VIEWS[toolId as SuiteWriteToolId] as Build<SuiteWriteToolId>;
  return build(payload as Payload<SuiteWriteToolId>, facts);
}
