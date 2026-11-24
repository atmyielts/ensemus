// What a turn is offered. An offer is not a grant: the tool gateway checks everything again, because the
// model may ask for anything at all. Leaving a tool off only means a model is not told about it.
import type { LoadedRunBrief } from '@ensemus/application/ai-context-source';
import { TOOL_ARGS_SCHEMAS } from '@ensemus/contracts/ai-tools';
import {
  isSuiteRule,
  TOOL_MANIFESTS,
  type ToolId,
  type ToolManifest,
} from '@ensemus/domain/ai-tools';
import type { AdapterTool } from '@ensemus/intelligence';
import { z } from 'zod';

const APPROVED = 'A person has to approve the exact change before it happens.';

/** Fixed here, so a tool's description is never text a document or a tenant wrote. */
const DESCRIPTIONS: Record<ToolId, string> = {
  'work.read': 'Read a Work Unit that the person who started this run can read.',
  'artifact.read_text': 'Read the text of a file attached to this Work Unit.',
  'artifact.draft.create': 'Save a draft file on this Work Unit, listing the sources it relies on.',
  'email.send': 'Propose an email. A person has to approve the exact message before it is sent.',
  'agent.delegate': 'Ask another published agent to do part of this work, with narrower access.',
  'gmail.search': 'Search mail in a connected Gmail account.',
  'gmail.read_thread': 'Read one mail thread in a connected Gmail account.',
  'gmail.create_draft': 'Save a draft email in a connected Gmail account. Nothing is sent.',
  'gmail.send': `Propose sending an email from a connected Gmail account. ${APPROVED}`,
  'drive.search':
    'Search files in a connected Google Drive that the person who started this can see.',
  'drive.create_file': `Propose creating a file in a connected Google Drive. ${APPROVED}`,
  'docs.read': 'Read a Google Doc in a connected account.',
  'docs.edit': `Propose an exact edit to a Google Doc at a given revision. ${APPROVED}`,
  'sheets.read_range': 'Read a range of a Google Sheet in a connected account.',
  'sheets.write_range': `Propose writing values to a range of a Google Sheet. ${APPROVED}`,
  'calendar.list_events': 'List events in a connected calendar between two times.',
  'calendar.create_event': `Propose a new event in a connected calendar. ${APPROVED}`,
  'calendar.update_event': `Propose a change to an event in a connected calendar. ${APPROVED}`,
  'outlook.search': 'Search mail in a connected Outlook account.',
  'outlook.read_thread': 'Read one mail conversation in a connected Outlook account.',
  'outlook.create_draft': 'Save a draft email in a connected Outlook account. Nothing is sent.',
  'outlook.send': `Propose sending an email from a connected Outlook account. ${APPROVED}`,
  'onedrive.search': 'Search files in a connected OneDrive or SharePoint that the person can see.',
  'onedrive.create_file': `Propose creating a file in a connected OneDrive. ${APPROVED}`,
  'word.read': 'Read a Word document in a connected account.',
  'excel.read_range': 'Read a range of an Excel workbook in a connected account.',
  'excel.write_range': `Propose writing values to a range of an Excel workbook. ${APPROVED}`,
  'teams.post_message': `Propose posting a message to a Teams channel. ${APPROVED}`,
};

const schemas = new Map<ToolId, Record<string, unknown>>();

function parametersOf(id: ToolId): Record<string, unknown> {
  let schema = schemas.get(id);
  if (!schema) {
    // What a model sends is what gets parsed, so this describes the input side of the schema.
    schema = z.toJSONSchema(TOOL_ARGS_SCHEMAS[id], { io: 'input' }) as Record<string, unknown>;
    schemas.set(id, schema);
  }
  return schema;
}

/**
 * A suite tool is offered only when the initiator has a connection it could use: the organization's or
 * their own, of the right type, owner and scopes (ADR-038 D5). The gateway decides again on the one the
 * model names. Every other tool is offered as before.
 */
function hasConnectionFor(
  tool: ToolManifest,
  brief: Pick<LoadedRunBrief, 'usableConnections'>,
): boolean {
  if (!tool.connection || !isSuiteRule(tool.connection)) return true;
  return (brief.usableConnections ?? []).some((connection) => connection.toolIds.includes(tool.id));
}

/** The manifest's order, so the list does not vary with how a spec happens to list its tools. */
export function offeredTools(
  brief: Pick<
    LoadedRunBrief,
    'allowedTools' | 'deniedTools' | 'delegatedTools' | 'usableConnections'
  >,
): readonly AdapterTool[] {
  return (TOOL_MANIFESTS as readonly (ToolManifest & { id: ToolId })[])
    .filter(
      (tool) =>
        brief.allowedTools.includes(tool.id) &&
        brief.delegatedTools.includes(tool.id) &&
        !brief.deniedTools.includes(tool.id) &&
        hasConnectionFor(tool, brief),
    )
    .map((tool) => ({
      id: tool.id,
      version: tool.version,
      description: DESCRIPTIONS[tool.id],
      parameters: parametersOf(tool.id),
    }));
}
