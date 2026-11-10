import { getWorkWithCompletion, updateWorkUnit } from '@ensemus/application';
import type { components } from '@ensemus/contracts/openapi';
import { z } from 'zod';
import { apiRoute, etag, readIfMatch, readJson, workUnitDto, workUnitParams } from '@/server/api';

export const dynamic = 'force-dynamic';

type CompletionDto = components['schemas']['WorkCompletion'];

export const GET = apiRoute(workUnitParams, async ({ context, database, params }) => {
  const { work, completion } = await getWorkWithCompletion(database, context, params.workUnitId);
  return Response.json(
    {
      ...workUnitDto(work),
      ...(completion
        ? {
            completion: {
              basis: (completion.basis ?? 'not_recorded') as CompletionDto['basis'],
              confirmed_by_membership_id: completion.confirmedBy,
              confirmed_at: completion.confirmedAt.toISOString(),
            },
          }
        : {}),
    },
    { headers: { ETag: etag(work.version) } },
  );
});

const patchBody = z
  .strictObject({
    title: z.string().trim().min(1).max(300).optional(),
    objective: z.string().trim().max(10_000).optional(),
    due_at: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  // An empty patch would still move the version, and tell everyone watching that something changed.
  .refine((body) => Object.keys(body).length > 0);

export const PATCH = apiRoute(workUnitParams, async ({ request, context, database, params }) => {
  const version = readIfMatch(request);
  const body = await readJson(request, patchBody);
  const work = await updateWorkUnit(database, context, params.workUnitId, version, {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.objective !== undefined ? { objective: body.objective } : {}),
    ...(body.due_at !== undefined
      ? { dueAt: body.due_at === null ? null : new Date(body.due_at) }
      : {}),
  });
  return Response.json(workUnitDto(work), { headers: { ETag: etag(work.version) } });
});
