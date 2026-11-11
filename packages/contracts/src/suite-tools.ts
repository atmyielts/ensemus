// What a model may ask each suite tool for (ADR-038 D6). Strict, like every tool's arguments: an extra
// field is a refusal. Each names the connection it means, and the gateway decides whether that connection
// may be used. For a change, everything here but `connection_id` is the payload an approval binds, so each
// shape carries every field a reviewer relies on: recipients, subject and body; attendees, times and time
// zone; the exact edit and the revision it applies to; the range and its values.
//
// Wire formats are unqualified until the owner runs them against test tenants. Field names here are ours,
// and the connectors map them to each provider's.
import { z } from 'zod';

/** Stops header injection at the door, as M3's email does. */
const noLineBreaks = (value: string) => !/[\r\n\0]/.test(value);

/**
 * A provider's own ID for a message, thread, file, event, team or channel. No slash, query, fragment,
 * percent or space, so a connector can put one in a path without it meaning anything else. Graph item IDs
 * use `!`, Teams channel IDs use `:` and `@`, and Google's are base64url.
 */
export const providerIdSchema = z.string().regex(/^[A-Za-z0-9._~:@!$=+-]{1,512}$/);

const connectionId = z.uuid();
const address = z.email().max(254).refine(noLineBreaks);
const MAX_RECIPIENTS = 50;
const instant = z.iso.datetime({ offset: true });
/** An IANA name such as Europe/London. Each provider checks it against its own list. */
const timeZone = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/)
  .max(64);
const query = z.string().min(1).max(500).refine(noLineBreaks);
const maxResults = (most: number) => z.int().min(1).max(most);
/** An A1 range, optionally with its sheet. Quoted sheet names may hold spaces. */
const a1Range = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(?:(?:'[^'\r\n]{1,100}'|[A-Za-z0-9_]{1,100})!)?[A-Za-z]{0,3}\d{0,7}(?::[A-Za-z]{0,3}\d{0,7})?$/,
  );
const cell = z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()]);
const values = z.array(z.array(cell).max(100)).min(1).max(1000);

// --- Mail.

const message = z
  .strictObject({
    to: z.array(address).min(1).max(MAX_RECIPIENTS),
    cc: z.array(address).max(MAX_RECIPIENTS).optional(),
    bcc: z.array(address).max(MAX_RECIPIENTS).optional(),
    subject: z.string().min(1).max(200).refine(noLineBreaks),
    text_body: z.string().min(1).max(200_000),
    /** The message this answers, by the provider's ID. Threading only: it changes no recipient. */
    in_reply_to: providerIdSchema.optional(),
  })
  .refine(
    (mail) => mail.to.length + (mail.cc?.length ?? 0) + (mail.bcc?.length ?? 0) <= MAX_RECIPIENTS,
    { path: ['to'] },
  );

const mailSearch = z.strictObject({
  connection_id: connectionId,
  query,
  max_results: maxResults(50),
});

export const gmailSearchArgsSchema = mailSearch;
export const gmailReadThreadArgsSchema = z.strictObject({
  connection_id: connectionId,
  thread_id: providerIdSchema,
});
export const gmailCreateDraftArgsSchema = z.strictObject({ connection_id: connectionId, message });
export const gmailSendArgsSchema = z.strictObject({ connection_id: connectionId, message });

export const outlookSearchArgsSchema = mailSearch;
export const outlookReadThreadArgsSchema = z.strictObject({
  connection_id: connectionId,
  conversation_id: providerIdSchema,
});
export const outlookCreateDraftArgsSchema = z.strictObject({
  connection_id: connectionId,
  message,
});
export const outlookSendArgsSchema = z.strictObject({ connection_id: connectionId, message });

// --- Calendar, the same for both providers.

const calendarId = providerIdSchema;
/**
 * Who the provider tells about a create or a change, so a reviewer sees it before approving. `all` tells
 * every attendee. `external_only` is Google's `externalOnly`: only guests who do not use Google Calendar.
 * `none` tells nobody. Microsoft Graph tells attendees of any create or change it makes and has no switch
 * for it, so on Microsoft only `all` is offered (`suitePayloadFits`), except a create with no attendees.
 */
export const SEND_UPDATES = ['all', 'external_only', 'none'] as const;
export type SendUpdates = (typeof SEND_UPDATES)[number];
const sendUpdates = z.enum(SEND_UPDATES);
const eventFields = {
  summary: z.string().min(1).max(500).refine(noLineBreaks),
  description: z.string().max(20_000).optional(),
  location: z.string().max(500).refine(noLineBreaks).optional(),
  start: instant,
  end: instant,
  time_zone: timeZone,
  attendees: z.array(address).max(100),
};

export const calendarListEventsArgsSchema = z
  .strictObject({
    connection_id: connectionId,
    calendar_id: calendarId,
    time_min: instant,
    time_max: instant,
    max_results: maxResults(100),
  })
  .refine((args) => Date.parse(args.time_min) < Date.parse(args.time_max), {
    path: ['time_max'],
  });

export const calendarCreateEventArgsSchema = z
  .strictObject({
    connection_id: connectionId,
    calendar_id: calendarId,
    ...eventFields,
    send_updates: sendUpdates,
  })
  .refine((args) => Date.parse(args.start) < Date.parse(args.end), { path: ['end'] });

export const calendarUpdateEventArgsSchema = z.strictObject({
  connection_id: connectionId,
  calendar_id: calendarId,
  event_id: providerIdSchema,
  send_updates: sendUpdates,
  /** Only what changes. What is absent stays as it is at the provider. */
  changes: z
    .strictObject({
      summary: eventFields.summary.optional(),
      description: eventFields.description,
      location: eventFields.location,
      start: instant.optional(),
      end: instant.optional(),
      time_zone: timeZone.optional(),
      attendees: eventFields.attendees.optional(),
    })
    .refine((changes) => Object.keys(changes).length > 0)
    .refine(
      (changes) =>
        changes.start === undefined ||
        changes.end === undefined ||
        Date.parse(changes.start) < Date.parse(changes.end),
      { path: ['end'] },
    ),
});

// --- Files.

const fileSearch = z.strictObject({
  connection_id: connectionId,
  query,
  max_results: maxResults(50),
});
const newFile = {
  connection_id: connectionId,
  name: z
    .string()
    .min(1)
    .max(255)
    .refine(noLineBreaks)
    .refine((name) => !/[\\/]/.test(name)),
  media_type: z.enum(['text/plain', 'text/markdown', 'text/csv']),
  text: z.string().max(1_000_000),
  /** The folder it goes in, by the provider's ID. Absent means the account's root. */
  parent_id: providerIdSchema.optional(),
};

export const driveSearchArgsSchema = fileSearch;
export const driveCreateFileArgsSchema = z.strictObject(newFile);
export const onedriveSearchArgsSchema = fileSearch;
export const onedriveCreateFileArgsSchema = z.strictObject(newFile);

// --- Documents and sheets.

/** One change to a Google document, in the order given, against the revision named beside it. */
const docEdit = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('insert_text'),
    index: z.int().min(1),
    text: z.string().min(1).max(100_000),
  }),
  z.strictObject({
    kind: z.literal('replace_all_text'),
    find: z.string().min(1).max(1_000),
    replace: z.string().max(100_000),
    match_case: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('delete_range'),
    start_index: z.int().min(1),
    end_index: z.int().min(2),
  }),
]);

export const docsReadArgsSchema = z.strictObject({
  connection_id: connectionId,
  document_id: providerIdSchema,
});
export const docsEditArgsSchema = z.strictObject({
  connection_id: connectionId,
  document_id: providerIdSchema,
  /** Docs refuses the edit if the document changed since this revision, so a reviewer's view holds. */
  required_revision_id: providerIdSchema,
  edits: z.array(docEdit).min(1).max(100),
});
export const sheetsReadRangeArgsSchema = z.strictObject({
  connection_id: connectionId,
  spreadsheet_id: providerIdSchema,
  range: a1Range,
});
export const sheetsWriteRangeArgsSchema = z.strictObject({
  connection_id: connectionId,
  spreadsheet_id: providerIdSchema,
  range: a1Range,
  values,
  /** `raw` stores exactly these values. `user_entered` lets the sheet read formulas, as a person typing. */
  value_input: z.enum(['raw', 'user_entered']),
});

/**
 * A drive item is named by its drive and its ID together, as the drive sync keys it, so the gateway can
 * check the initiator's source ACL for exactly the item the connector then reaches.
 */
const driveItem = { drive_id: providerIdSchema, item_id: providerIdSchema };

export const wordReadArgsSchema = z.strictObject({
  connection_id: connectionId,
  ...driveItem,
});
const worksheet = z.string().min(1).max(31).refine(noLineBreaks);
export const excelReadRangeArgsSchema = z.strictObject({
  connection_id: connectionId,
  ...driveItem,
  worksheet,
  range: a1Range,
});
export const excelWriteRangeArgsSchema = z.strictObject({
  connection_id: connectionId,
  ...driveItem,
  worksheet,
  range: a1Range,
  values,
});

// --- Teams.

export const teamsPostMessageArgsSchema = z.strictObject({
  connection_id: connectionId,
  team_id: providerIdSchema,
  channel_id: providerIdSchema,
  subject: z.string().min(1).max(200).refine(noLineBreaks).optional(),
  text_body: z.string().min(1).max(28_000),
});

export const SUITE_TOOL_ARGS_SCHEMAS = {
  'gmail.search': gmailSearchArgsSchema,
  'gmail.read_thread': gmailReadThreadArgsSchema,
  'gmail.create_draft': gmailCreateDraftArgsSchema,
  'gmail.send': gmailSendArgsSchema,
  'drive.search': driveSearchArgsSchema,
  'drive.create_file': driveCreateFileArgsSchema,
  'docs.read': docsReadArgsSchema,
  'docs.edit': docsEditArgsSchema,
  'sheets.read_range': sheetsReadRangeArgsSchema,
  'sheets.write_range': sheetsWriteRangeArgsSchema,
  'calendar.list_events': calendarListEventsArgsSchema,
  'calendar.create_event': calendarCreateEventArgsSchema,
  'calendar.update_event': calendarUpdateEventArgsSchema,
  'outlook.search': outlookSearchArgsSchema,
  'outlook.read_thread': outlookReadThreadArgsSchema,
  'outlook.create_draft': outlookCreateDraftArgsSchema,
  'outlook.send': outlookSendArgsSchema,
  'onedrive.search': onedriveSearchArgsSchema,
  'onedrive.create_file': onedriveCreateFileArgsSchema,
  'word.read': wordReadArgsSchema,
  'excel.read_range': excelReadRangeArgsSchema,
  'excel.write_range': excelWriteRangeArgsSchema,
  'teams.post_message': teamsPostMessageArgsSchema,
} as const;

export type SuiteToolArgs<Id extends keyof typeof SUITE_TOOL_ARGS_SCHEMAS> = z.infer<
  (typeof SUITE_TOOL_ARGS_SCHEMAS)[Id]
>;

/**
 * Whether one provider can do exactly what a payload (or a tool's arguments) says, where the shared schema
 * allows more than that provider can. Asked when a change is proposed, so nobody approves what could only
 * be refused, and again by the connector before it sends. Microsoft Graph tells every attendee of an event
 * it creates or changes, so a payload saying otherwise is refused rather than sent with a different effect.
 */
export function suitePayloadFits(toolId: string, connectorType: string, payload: unknown): boolean {
  if (connectorType !== 'microsoft_365' || typeof payload !== 'object' || payload === null)
    return true;
  const fields = payload as { send_updates?: unknown; attendees?: unknown };
  if (toolId === 'calendar.create_event') {
    const nobody = Array.isArray(fields.attendees) && fields.attendees.length === 0;
    return fields.send_updates === 'all' || nobody;
  }
  if (toolId === 'calendar.update_event') return fields.send_updates === 'all';
  return true;
}
