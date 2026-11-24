import {
  AppError,
  idSchema,
  requestHash,
  requestSandboxRun,
  runIdempotent,
} from '@ensemus/application';
import { requestSandboxTestRunSchema } from '@ensemus/contracts/skills';
import { canonicalJson } from '@ensemus/domain/approval';
import { can } from '@ensemus/domain/policy';
import { SANDBOX_INPUT_MAX_BYTES } from '@ensemus/domain/sandbox';
import { apiRoute, etag, idempotencyKeyReused, organizationParams, readJson } from '@/server/api';
import { sandboxRunDto } from '@/server/sandbox-api';
import { getSandboxCeilings, getSkillFeatureGate } from '@/server/skill-runtime';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(
  organizationParams.extend({ skillVersionId: idSchema }),
  async ({ database, context, request, params }) => {
    if (context.actorType !== 'user' || !can(context.role, 'sandbox.run'))
      throw new AppError('FORBIDDEN');
    const gate = getSkillFeatureGate();
    if (!(await gate.isEnabled(context, 'sandbox'))) throw new AppError('FEATURE_NOT_ENABLED');
    const body = await readJson(
      request,
      requestSandboxTestRunSchema,
      SANDBOX_INPUT_MAX_BYTES + 4096,
    );
    let serialized: string;
    try {
      serialized = canonicalJson(body);
    } catch {
      throw new AppError('INVALID_INPUT');
    }
    const result = await runIdempotent(
      database,
      context,
      {
        key: request.headers.get('idempotency-key') ?? '',
        requestHash: requestHash(['sandbox.operator_test', params.skillVersionId, serialized]),
      },
      (db) =>
        requestSandboxRun(
          db,
          context,
          { gate, agentGuard: null },
          {
            skillVersionId: params.skillVersionId,
            classification: body.classification,
            input: body.input,
            purpose: 'operator_test',
            ceilings: getSandboxCeilings(),
          },
        ),
      (run) => ({ status: 202, body: sandboxRunDto(run) }),
    );
    if (result.kind === 'conflict') throw idempotencyKeyReused();
    const run = result.body as ReturnType<typeof sandboxRunDto>;
    return Response.json(run, { status: result.status, headers: { ETag: etag(run.version) } });
  },
);
