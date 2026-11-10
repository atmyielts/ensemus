import {
  createWorkUnit,
  idSchema,
  listWorkUnits,
  requestHash,
  runIdempotent,
} from '@ensemus/application';
import { WORK_STATES } from '@ensemus/domain/work-unit';
import { z } from 'zod';
import {
  apiRoute,
  etag,
  idempotencyKeyReused,
  organizationParams,
  readJson,
  readQuery,
  workUnitDto,
} from '@/server/api';

export const dynamic = 'force-dynamic';

const listQuery = z.object({
  status: z.enum(WORK_STATES).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

export const GET = apiRoute(organizationParams, async ({ request, context, database }) => {
  const { status, cursor } = readQuery(request, listQuery);
  const page = await listWorkUnits(database, context, {
    ...(status ? { status } : {}),
    ...(cursor ? { cursor } : {}),
  });
  return Response.json({ items: page.items.map(workUnitDto), next_cursor: page.nextCursor });
});

const createBody = z.strictObject({
  title: z.string().trim().min(1).max(300),
  objective: z.string().trim().min(1).max(10_000),
  project_id: idSchema.nullable().optional(),
  due_at: z.iso.datetime({ offset: true }).nullable().optional(),
  completion_criteria: z
    .strictObject({
      artifact_exists: z.boolean().optional(),
      reviewer_approved: z.boolean().optional(),
      // The service refuses this unless the tenant has a connection that can act (ADR-027 D6).
      external_receipt: z.boolean().optional(),
    })
    .optional(),
});

const CRITERIA = ['artifact_exists', 'reviewer_approved', 'external_receipt'] as const;

export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  const body = await readJson(request, createBody);
  const dueAt = body.due_at ? new Date(body.due_at) : undefined;
  const required = body.completion_criteria;
  const outcome = await runIdempotent(
    database,
    context,
    {
      key: request.headers.get('idempotency-key') ?? '',
      requestHash: requestHash(['POST', 'work-units', JSON.stringify(body)]),
    },
    (joined) =>
      createWorkUnit(joined, context, {
        title: body.title,
        objective: body.objective,
        // The service holds the real list, and decides whether this tenant may ask for each one.
        completionCriteria: CRITERIA.filter((kind) => required?.[kind]).map((kind) => ({
          kind,
        })) as Array<{ kind: 'artifact_exists' }>,
        ...(body.project_id ? { projectId: body.project_id } : {}),
        ...(dueAt ? { dueAt } : {}),
      }),
    (row) => ({ status: 201, body: workUnitDto(row) }),
  );
  if (outcome.kind === 'conflict') throw idempotencyKeyReused();
  const { version } = outcome.body as { version: number };
  return Response.json(outcome.body, {
    status: outcome.status,
    headers: { ETag: etag(version) },
  });
});
