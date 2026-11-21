// What a turn may leave out to fit a model, and what it says when it asks a model to try again. Both are
// fixed text chosen by code: nothing a model or a document wrote is ever repeated back, and no message the
// policy role carries is ever touched.
import type { AiClassification } from '@ensemus/domain/ai';
import type { ContextMessage, Malformation } from '../types';

/**
 * Which messages may go, in the order they go: earlier steps' tool output first, oldest first, then
 * evidence, last first. The policy and the task always stay, and so does the newest step's output, since
 * that is what the model is being asked to act on.
 */
function candidates(messages: readonly ContextMessage[]): number[] {
  const stepOf = (message: ContextMessage) => {
    const match = /^step:(\d{1,9}):/.exec(message.partId);
    return match ? Number(match[1]) : null;
  };
  const toolIndexes = messages.flatMap((message, index) =>
    message.role === 'tool_output' ? [index] : [],
  );
  const steps = toolIndexes.map((index) => stepOf(messages[index] as ContextMessage));
  const known = steps.filter((step): step is number => step !== null);
  const newest = known.length > 0 ? Math.max(...known) : null;
  const lastTool = toolIndexes.at(-1);
  const keep = (index: number) => {
    const step = stepOf(messages[index] as ContextMessage);
    return newest !== null && step !== null ? step === newest : index === lastTool;
  };
  const evidence = messages.flatMap((message, index) =>
    message.role === 'evidence' ? [index] : [],
  );
  return [...toolIndexes.filter((index) => !keep(index)), ...evidence.reverse()];
}

/** What the model is told about what was left out. Counts only, so it says nothing a document said. */
export function compactionNotice(
  dropped: number,
  classification: AiClassification,
): ContextMessage {
  return {
    role: 'task',
    partId: 'compaction',
    text: `Note: ${dropped} earlier part${dropped === 1 ? '' : 's'} of this run ${
      dropped === 1 ? 'was' : 'were'
    } left out so that the request fits the model's input limit.`,
    classification,
  };
}

/** The messages a call sends: everything not left out, the notice if anything was, then any correction. */
export function composeMessages(
  messages: readonly ContextMessage[],
  dropped: ReadonlySet<number>,
  extra: readonly ContextMessage[],
  classification: AiClassification,
): readonly ContextMessage[] {
  const kept = messages.filter((_, index) => !dropped.has(index));
  return [
    ...kept,
    ...(dropped.size > 0 ? [compactionNotice(dropped.size, classification)] : []),
    ...extra,
  ];
}

/**
 * Leaves out the fewest messages, in the order above, until `fits` says yes. Returns the indexes left out,
 * or null when everything that may go has gone and it still does not fit: then the turn fails with
 * CONTEXT_TOO_LONG rather than sending less than the policy and the task.
 */
export function compactToFit(
  messages: readonly ContextMessage[],
  fits: (dropped: ReadonlySet<number>) => boolean,
  already: ReadonlySet<number> = new Set(),
): ReadonlySet<number> | null {
  const dropped = new Set(already);
  if (fits(dropped)) return dropped;
  for (const index of candidates(messages)) {
    if (dropped.has(index)) continue;
    dropped.add(index);
    if (fits(dropped)) return dropped;
  }
  return null;
}

/**
 * One fixed correction for each way an answer can be misshapen. It names the rule that was broken, the
 * same way for every provider, and never quotes the answer: a model that was steered into a bad answer
 * gets no second look at what it wrote.
 */
const CORRECTIONS: Record<Malformation, string> = {
  multiple_tool_calls:
    'Your previous reply asked for more than one tool at once. Reply again with at most one tool call.',
  unknown_tool:
    'Your previous reply asked for a tool that is not offered. Use only the tools listed, or answer without one.',
  tool_args_not_json:
    'The arguments of your previous tool call were not valid JSON. Reply again with arguments that are one valid JSON object.',
  tool_args_not_object:
    'The arguments of your previous tool call were not a JSON object. Reply again with arguments that are one JSON object.',
  empty_output: 'Your previous reply was empty. Reply again with an answer or one tool call.',
  output_not_json:
    'Your previous reply was not valid JSON. Reply again with one JSON document that matches the required schema, and nothing else.',
  output_schema_mismatch:
    'Your previous reply did not match the required JSON schema. Reply again with one JSON document that matches it exactly.',
};

/** The correction, as a task message after everything else, at the class of the turn it belongs to. */
export function repairMessage(
  malformation: Malformation,
  classification: AiClassification,
): ContextMessage {
  return {
    role: 'task',
    partId: `repair:${malformation}`,
    text: CORRECTIONS[malformation],
    classification,
  };
}
