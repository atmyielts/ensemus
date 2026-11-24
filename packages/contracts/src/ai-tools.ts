// What a model may ask each tool for (ADR-028 FD-18). Strict: an extra argument is a refusal, not
// something ignored. The tool gateway parses with these before anything else runs. A model never names
// an approver, a budget, a profile or a connection's secret: those come from policy.
import { z } from 'zod';
import { emailSendPayloadSchema } from './external-actions';
import { SUITE_TOOL_ARGS_SCHEMAS } from './suite-tools';

export { SUITE_TOOL_ARGS_SCHEMAS, providerIdSchema } from './suite-tools';

export const workReadArgsSchema = z.strictObject({
  work_unit_id: z.uuid(),
});

export const artifactReadTextArgsSchema = z.strictObject({
  artifact_id: z.uuid(),
});

export const artifactDraftCreateArgsSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  /** Plain text. Stored as a draft artifact whose class is never below the run's. */
  text: z.string().min(1).max(200_000),
  /** Where the draft's claims came from. Each one is checked against what this run was allowed. */
  evidence: z
    .array(
      z.strictObject({
        source_type: z.enum(['work_unit', 'artifact']),
        source_id: z.uuid(),
      }),
    )
    .max(50),
});

/** The same bytes M3 freezes on the intent and hashes for the approval (ADR-027 D1). */
export const emailSendArgsSchema = z.strictObject({
  connection_id: z.uuid(),
  email: emailSendPayloadSchema,
});

export const agentDelegateArgsSchema = z.strictObject({
  agent_version_id: z.uuid(),
  title: z.string().trim().min(1).max(200),
  /** What the child may use. Refused if it is not a subset of this run's scopes. */
  tools: z.array(z.string()).max(50),
  max_cost_micros: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const TOOL_ARGS_SCHEMAS = {
  'work.read': workReadArgsSchema,
  'artifact.read_text': artifactReadTextArgsSchema,
  'artifact.draft.create': artifactDraftCreateArgsSchema,
  'email.send': emailSendArgsSchema,
  'agent.delegate': agentDelegateArgsSchema,
  ...SUITE_TOOL_ARGS_SCHEMAS,
} as const;

/**
 * What an intent freezes from a change's arguments: `email.send`'s `email`, as M3 always has, and for a
 * suite tool everything but `connection_id`, which becomes the intent's own connection. Null for a tool
 * that is not a change through a connection.
 */
export function actionPayloadOf(toolId: string, args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return null;
  if (toolId === 'email.send') return (args as { email?: unknown }).email ?? null;
  if (!(toolId in SUITE_TOOL_ARGS_SCHEMAS)) return null;
  const { connection_id: _connection, ...payload } = args as Record<string, unknown>;
  return payload;
}

/**
 * Checks a suite change's payload as the tool's own arguments would be, with the connection put back.
 * Answers the parsed payload, which is what gets frozen and hashed, or null when it does not fit.
 */
export function parseSuiteActionPayload(
  toolId: string,
  connectionId: string,
  payload: unknown,
): Record<string, unknown> | null {
  const schema = (SUITE_TOOL_ARGS_SCHEMAS as Record<string, z.ZodType>)[toolId];
  if (!schema || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  if ('connection_id' in payload) return null;
  const parsed = schema.safeParse({ ...payload, connection_id: connectionId });
  if (!parsed.success) return null;
  const { connection_id: _connection, ...frozen } = parsed.data as Record<string, unknown>;
  return frozen;
}
