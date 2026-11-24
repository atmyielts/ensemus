import { randomUUID } from 'node:crypto';
import {
  AppError,
  getSkillVersionReview,
  idSchema,
  refusalFromDatabase,
} from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { SANDBOX_INPUT_MAX_BYTES, sandboxAcceptsClassification } from '@ensemus/domain/sandbox';
import { z } from 'zod';
import { messageFor } from '@/lib/messages';
import { readBoundedBody } from '@/lib/webhook-limiter';
import { apiRoute } from '@/server/api';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import { queueSandboxTrial, trialDraft, type SandboxTrialFormState } from '../../trial-submission';

const params = z.object({ organizationId: idSchema, skillVersionId: idSchema });
const labels = { public: 'Public', internal: 'Internal', confidential: 'Confidential' } as const;
const formBytes = SANDBOX_INPUT_MAX_BYTES * 3 + 1024;

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function retryForm(
  organizationId: string,
  skillVersionId: string,
  requestToken: string,
  classifications: readonly (keyof typeof labels)[],
  state: SandboxTrialFormState,
  status: 408 | 413 | 422,
) {
  const classification =
    state.classification && classifications.includes(state.classification)
      ? state.classification
      : classifications.includes('internal')
        ? 'internal'
        : 'public';
  const options = classifications.map(
    (value) =>
      `<option value="${value}"${value === classification ? ' selected' : ''}>${labels[value]}</option>`,
  );
  const error = state.invalidJson ? 'Enter valid JSON.' : messageFor(state.code ?? 'INVALID_INPUT');
  return new Response(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandbox trial | Ensemus</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:1rem/1.5 system-ui,sans-serif}
main{box-sizing:border-box;margin:auto;max-width:36rem;padding:1.25rem}
form, label{display:grid;gap:.5rem} form{gap:1rem}
select,textarea,button{box-sizing:border-box;font:inherit;padding:.6rem}
textarea{width:100%;resize:vertical;font-family:monospace}
button{width:100%}
[aria-invalid="true"]{border:1px solid #bd5344}
</style></head>
<body><main>
<a href="/o/${organizationId}/skills/versions/${skillVersionId}">Skill version</a>
<h1>Sandbox trial</h1>
<p id="trial-error" role="alert">${escapeHtml(error)}</p>
<form method="post" action="/o/${organizationId}/sandbox/trials/${skillVersionId}">
<input type="hidden" name="requestToken" value="${requestToken}">
<label for="classification">Input classification</label>
<select id="classification" name="classification">${options.join('')}</select>
<label for="input">JSON input</label>
<textarea id="input" name="input" required rows="6" spellcheck="false" autocapitalize="off" autocomplete="off"
  aria-describedby="${state.invalidJson ? 'trial-error input-hint' : 'input-hint'}"${state.invalidJson ? ' aria-invalid="true"' : ''}>
${escapeHtml(state.input ?? '{}')}</textarea>
<small id="input-hint">Use JSON that matches this version’s input schema. Maximum 1 MiB.</small>
<button type="submit">Run trial</button>
</form></main></body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}

export const POST = apiRoute(params, async ({ request, context, database, params }) => {
  if (context.actorType !== 'user' || !can(context.role, 'sandbox.run'))
    throw new AppError('NOT_FOUND');
  if (!(await getSkillFeatureGate().isEnabled(context, 'sandbox')))
    throw new AppError('FEATURE_NOT_ENABLED');
  const { organizationId, skillVersionId } = params;
  const { version } = await getSkillVersionReview(database, context, skillVersionId);
  const maximum = version.maxClassification;
  if (version.executionKind !== 'sandbox' || !maximum) throw new AppError('NOT_FOUND');
  const classifications = (['public', 'internal', 'confidential'] as const).filter((value) =>
    sandboxAcceptsClassification(value, maximum),
  );
  if (classifications.length === 0) throw new AppError('NOT_FOUND');

  if (request.headers.get('content-type')?.split(';', 1)[0] !== 'application/x-www-form-urlencoded')
    return new Response(null, { status: 415 });
  const body = await readBoundedBody(request, { maxBytes: formBytes, deadlineMs: 15_000 });
  if (body.kind !== 'body') {
    const code = body.kind === 'too_large' ? 'SANDBOX_INPUT_TOO_LARGE' : 'INVALID_INPUT';
    return retryForm(
      organizationId,
      skillVersionId,
      randomUUID(),
      classifications,
      { code },
      body.kind === 'too_large' ? 413 : 408,
    );
  }
  const form = new URLSearchParams(new TextDecoder().decode(body.bytes));
  const token = idSchema.safeParse(form.get('requestToken'));
  const result = await queueSandboxTrial(
    database,
    context,
    skillVersionId,
    form.get('requestToken'),
    form,
  ).catch((error: unknown) => {
    const refusal = error instanceof AppError ? error : refusalFromDatabase(error);
    if (!refusal || refusal.code === 'NOT_FOUND' || refusal.code === 'RESTORE_PENDING') throw error;
    return { state: { ...trialDraft(form), code: refusal.code } };
  });
  if ('runId' in result) {
    return new Response(null, {
      status: 303,
      headers: { Location: `/o/${organizationId}/sandbox/runs/${result.runId}` },
    });
  }
  const retryToken =
    token.success && result.state.code !== 'IDEMPOTENCY_KEY_REUSED' ? token.data : randomUUID();
  return retryForm(organizationId, skillVersionId, retryToken, classifications, result.state, 422);
});
