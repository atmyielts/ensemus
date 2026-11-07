import { AppError, idSchema } from '@ensemus/application';
import { agentDraftAnswersSchema } from '@ensemus/contracts/studio';
import type { ProcessGraphBody } from '@ensemus/contracts/studio';
import type { ProcessGraph } from '@ensemus/domain/process-spec';
import { microsFromUsdText, type AgentDraftAnswers } from '@ensemus/domain/agent-draft';
export type StudioFormState = {
  code?: string;
  values?: Record<string, string[]>;
  revision?: number;
};
export const studioText = (form: FormData, key: string) => {
  const value = form.get(key);
  if (value === null) return '';
  if (typeof value !== 'string') throw new AppError('INVALID_INPUT');
  return value;
};
const strings = (form: FormData, key: string) =>
  form.getAll(key).map((value) => {
    if (typeof value !== 'string') throw new AppError('INVALID_INPUT');
    return value;
  });
const identifier = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
const count = (form: FormData, key: string) => {
  const value = studioText(form, key);
  if (!/^(0|[1-9]\d{0,9})$/.test(value)) throw new AppError('INVALID_INPUT');
  return Number(value);
};
export function agentFormAnswers(form: FormData): AgentDraftAnswers {
  const money = studioText(form, 'maxCostUsd').trim(),
    maxCostMicros = money ? microsFromUsdText(money) : null;
  if (money && maxCostMicros === null) throw new AppError('INVALID_INPUT');
  const parsed = agentDraftAnswersSchema.safeParse({
    role: studioText(form, 'role'),
    intendedOutcome: studioText(form, 'intendedOutcome'),
    boundaries: studioText(form, 'boundaries')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    knowledgeSourceIds: strings(form, 'knowledgeSourceIds').map(identifier),
    toolIds: strings(form, 'toolIds'),
    triggerKind: 'manual',
    maxCostMicros,
    maxTurns: count(form, 'maxTurns'),
    maxToolCalls: count(form, 'maxToolCalls'),
    maxTotalTokens: count(form, 'maxTotalTokens'),
    timeoutSeconds: count(form, 'timeoutSeconds'),
    qualityTier: studioText(form, 'qualityTier'),
    autonomy: studioText(form, 'autonomy'),
    memoryWrite: studioText(form, 'memoryWrite'),
    outputFormat: studioText(form, 'outputFormat'),
    dataClasses: [studioText(form, 'dataCeiling')],
    ownerMembershipId: identifier(studioText(form, 'ownerMembershipId')),
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}
const RETAIN = [
  'name',
  'role',
  'intendedOutcome',
  'boundaries',
  'knowledgeSourceIds',
  'toolIds',
  'ownerMembershipId',
  'maxCostUsd',
  'maxTurns',
  'maxToolCalls',
  'maxTotalTokens',
  'timeoutSeconds',
  'qualityTier',
  'autonomy',
  'memoryWrite',
  'outputFormat',
  'dataCeiling',
];
export const studioFormValues = (form: FormData) =>
  Object.fromEntries(RETAIN.map((key) => [key, strings(form, key)]));

/** Omit absent optional fields explicitly; exact domain types do not admit an undefined grant. */
export const processGraphInput = (graph: ProcessGraphBody): ProcessGraph => ({
  schemaVersion: graph.schemaVersion,
  nodes: graph.nodes.map(({ agentDefinitionId, toolId, approverRole, evidence, ...node }) => ({
    ...node,
    ...(agentDefinitionId === undefined ? {} : { agentDefinitionId }),
    ...(toolId === undefined ? {} : { toolId }),
    ...(approverRole === undefined ? {} : { approverRole }),
    ...(evidence === undefined ? {} : { evidence }),
  })),
  edges: graph.edges.map((edge) => ({ ...edge })),
});
