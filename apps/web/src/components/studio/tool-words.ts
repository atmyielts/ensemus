import type { ToolFacts } from '@ensemus/domain/agent-draft';
import { studioToolName } from '@/lib/studio-present';

/** What a tool lets an assistant do, in a builder's words. The exact name stays in Technical details. */
const TOOL_WORDS: Record<string, readonly [string, string]> = {
  'work.read': ['Can read the work it is given', 'The title, details and progress of that work.'],
  'artifact.read_text': ['Can read attached files', 'The text of files attached to that work.'],
  'artifact.draft.create': ['Can prepare draft files', 'It saves a draft file on the work.'],
  'email.send': ['Can propose emails', 'It writes the exact email; it never sends one itself.'],
  'agent.delegate': [
    'Can ask another assistant for help',
    'It can pass part of the task to another assistant.',
  ],
};
const CLASS_WORDS: Record<ToolFacts['class'], readonly [string, string]> = {
  read_only: ['Can read information', 'It reads only; it changes nothing.'],
  draft_only: ['Can prepare drafts', 'It writes drafts; it does not send or change anything.'],
  external_write: [
    'Can propose changes outside Ensemus',
    'It lines up a change in another system.',
  ],
  delegation: ['Can hand work to another assistant', 'It can pass part of the task on.'],
};
/** Abilities inside a connected Google Workspace or Microsoft 365 account, named after the app. */
const SUITE_NAMES: Record<string, string> = {
  'gmail.search': 'Can search Gmail',
  'gmail.read_thread': 'Can read Gmail conversations',
  'gmail.create_draft': 'Can prepare Gmail drafts',
  'gmail.send': 'Can propose Gmail emails',
  'drive.search': 'Can search Google Drive',
  'drive.create_file': 'Can propose new Google Drive files',
  'docs.read': 'Can read Google Docs',
  'docs.edit': 'Can propose edits to Google Docs',
  'sheets.read_range': 'Can read Google Sheets',
  'sheets.write_range': 'Can propose changes to Google Sheets',
  'calendar.list_events': 'Can read Google Calendar',
  'calendar.create_event': 'Can propose new Google Calendar events',
  'calendar.update_event': 'Can propose Google Calendar changes',
  'outlook.search': 'Can search Outlook',
  'outlook.read_thread': 'Can read Outlook conversations',
  'outlook.create_draft': 'Can prepare Outlook drafts',
  'outlook.send': 'Can propose Outlook emails',
  'onedrive.search': 'Can search OneDrive',
  'onedrive.create_file': 'Can propose new OneDrive files',
  'word.read': 'Can read Word documents',
  'excel.read_range': 'Can read Excel workbooks',
  'excel.write_range': 'Can propose changes to Excel workbooks',
  'teams.post_message': 'Can propose Teams messages',
};

/** The name and a one-line explanation of a tool offered by the current catalog. */
export function toolWords(tool: ToolFacts): readonly [string, string] {
  const known = TOOL_WORDS[tool.id];
  if (known) return known;
  const byClass = CLASS_WORDS[tool.class];
  return [SUITE_NAMES[tool.id] ?? byClass[0], byClass[1]];
}

/** The name of a saved tool, when only its identifier is known. Unknown ones keep the shared name. */
export const toolName = (id: string) =>
  TOOL_WORDS[id]?.[0] ?? SUITE_NAMES[id] ?? studioToolName(id);

const GOOGLE = /^(gmail|drive|docs|sheets|calendar)\./,
  MICROSOFT = /^(outlook|onedrive|word|excel|teams)\./;

/** Everyday abilities first, then those inside each connected suite. */
export function toolGroups(tools: readonly ToolFacts[]) {
  return [
    {
      key: 'everyday',
      title: null,
      tools: tools.filter((tool) => !GOOGLE.test(tool.id) && !MICROSOFT.test(tool.id)),
    },
    {
      key: 'google',
      title: 'In Google Workspace',
      tools: tools.filter((tool) => GOOGLE.test(tool.id)),
    },
    {
      key: 'microsoft',
      title: 'In Microsoft 365',
      tools: tools.filter((tool) => MICROSOFT.test(tool.id)),
    },
  ].filter((group) => group.tools.length > 0);
}
