// What a turn is offered. An offer is not a grant: the tool gateway checks everything again, because the
// model may ask for anything at all. Leaving a tool off only means a model is not told about it.
import type { LoadedRunBrief } from '@ensemus/application/ai-context-source';
import { TOOL_ARGS_SCHEMAS } from '@ensemus/contracts/ai-tools';
import { TOOL_MANIFESTS, type ToolId } from '@ensemus/domain/ai-tools';
import type { AdapterTool } from '@ensemus/intelligence';
import { z } from 'zod';

/** Fixed here, so a tool's description is never text a document or a tenant wrote. */
const DESCRIPTIONS: Record<ToolId, string> = {
  'work.read': 'Read a Work Unit that the person who started this run can read.',
  'artifact.read_text': 'Read the text of a file attached to this Work Unit.',
  'artifact.draft.create': 'Save a draft file on this Work Unit, listing the sources it relies on.',
  'email.send': 'Propose an email. A person has to approve the exact message before it is sent.',
  'agent.delegate': 'Ask another published agent to do part of this work, with narrower access.',
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

/** The manifest's order, so the list does not vary with how a spec happens to list its tools. */
export function offeredTools(
  brief: Pick<LoadedRunBrief, 'allowedTools' | 'deniedTools' | 'delegatedTools'>,
): readonly AdapterTool[] {
  return TOOL_MANIFESTS.filter(
    (tool) =>
      brief.allowedTools.includes(tool.id) &&
      brief.delegatedTools.includes(tool.id) &&
      !brief.deniedTools.includes(tool.id),
  ).map((tool) => ({
    id: tool.id,
    version: tool.version,
    description: DESCRIPTIONS[tool.id],
    parameters: parametersOf(tool.id),
  }));
}
