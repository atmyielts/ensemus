import 'server-only';
import {
  AppError,
  idSchema,
  requestHash,
  requestSandboxRun,
  runIdempotent,
} from '@ensemus/application';
import { requestSandboxTestRunSchema } from '@ensemus/contracts/skills';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { canonicalJson } from '@ensemus/domain/approval';
import { SANDBOX_INPUT_MAX_BYTES } from '@ensemus/domain/sandbox';
import { getSandboxCeilings, getSkillFeatureGate } from '@/server/skill-runtime';

export type SandboxTrialFormState = {
  code?: string;
  invalidJson?: true;
  input?: string;
  classification?: 'public' | 'internal' | 'confidential';
};

export function trialDraft(form: Pick<FormData, 'get'>): SandboxTrialFormState {
  const draft: SandboxTrialFormState = {};
  const input = form.get('input');
  if (typeof input === 'string' && Buffer.byteLength(input, 'utf8') <= SANDBOX_INPUT_MAX_BYTES)
    draft.input = input;
  const classification = form.get('classification');
  if (
    classification === 'public' ||
    classification === 'internal' ||
    classification === 'confidential'
  )
    draft.classification = classification;
  return draft;
}

export async function queueSandboxTrial(
  database: AppDatabase,
  context: TenantContext,
  skillVersionId: string,
  requestToken: unknown,
  form: Pick<FormData, 'get'>,
): Promise<{ runId: string } | { state: SandboxTrialFormState }> {
  const key = idSchema.safeParse(requestToken);
  if (!key.success) return { state: { code: 'INVALID_INPUT' } };
  const raw = form.get('input');
  if (typeof raw !== 'string') return { state: { invalidJson: true } };
  if (Buffer.byteLength(raw, 'utf8') > SANDBOX_INPUT_MAX_BYTES)
    return { state: { code: 'SANDBOX_INPUT_TOO_LARGE' } };
  const draft = trialDraft(form);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { state: { ...draft, invalidJson: true } };
  }
  const body = requestSandboxTestRunSchema.safeParse({
    classification: draft.classification,
    input: json,
  });
  if (!body.success) return { state: { ...draft, code: 'INVALID_INPUT' } };

  const gate = getSkillFeatureGate();
  if (!(await gate.isEnabled(context, 'sandbox'))) throw new AppError('FEATURE_NOT_ENABLED');
  const result = await runIdempotent(
    database,
    context,
    {
      key: key.data,
      requestHash: requestHash([
        'sandbox.operator_test.workspace',
        skillVersionId,
        canonicalJson(body.data),
      ]),
    },
    (db) =>
      requestSandboxRun(
        db,
        context,
        { gate, agentGuard: null },
        {
          ...body.data,
          purpose: 'operator_test',
          skillVersionId,
          ceilings: getSandboxCeilings(),
        },
      ),
    (run) => ({ status: 202, body: { id: run.id } }),
  );
  if (result.kind === 'conflict') return { state: { ...draft, code: 'IDEMPOTENCY_KEY_REUSED' } };
  const queued = idSchema.safeParse((result.body as { id?: unknown } | null)?.id);
  if (!queued.success) throw new AppError('INVALID_STATE');
  return { runId: queued.data };
}
