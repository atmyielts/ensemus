import {
  addTrustedSigner,
  listTrustedSigners,
  runIdempotent,
  requestHash,
  AppError,
  type SkillSignerView,
} from '@ensemus/application';
import { addTrustedSignerSchema } from '@ensemus/contracts/skills';
import { can } from '@ensemus/domain/policy';
import { apiRoute, organizationParams, etag, idempotencyKeyReused, readJson } from '@/server/api';
import { getSkillFeatureGate } from '@/server/skill-runtime';
export const dynamic = 'force-dynamic';
function signerDto(row: SkillSignerView) {
  return {
    id: row.id,
    display_name: row.displayName,
    key_id: row.keyId,
    state: row.state,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    revoked_at: row.revokedAt?.toISOString() ?? null,
  };
}
export const GET = apiRoute(organizationParams, async ({ context, database }) =>
  Response.json({ items: (await listTrustedSigners(database, context)).map(signerDto) }),
);
export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  if (context.actorType !== 'user' || !can(context.role, 'skill.manage'))
    throw new AppError('FORBIDDEN');
  const body = await readJson(request, addTrustedSignerSchema);
  const publicKey = Buffer.from(body.public_key_base64, 'base64');
  if (publicKey.toString('base64') !== body.public_key_base64)
    throw new AppError('SKILL_SIGNER_KEY_INVALID');
  const result = await runIdempotent(
    database,
    context,
    {
      key: request.headers.get('idempotency-key') ?? '',
      requestHash: requestHash([
        'POST',
        'skill-signers',
        body.display_name,
        body.public_key_base64,
      ]),
    },
    (joined) =>
      addTrustedSigner(joined, context, getSkillFeatureGate(), {
        displayName: body.display_name,
        publicKey,
      }),
    (row) => ({ status: 201, body: signerDto(row) }),
  );
  if (result.kind === 'conflict') throw idempotencyKeyReused();
  const bodyOut = result.body as ReturnType<typeof signerDto>;
  return Response.json(bodyOut, {
    status: result.status,
    headers: { ETag: etag(bodyOut.version) },
  });
});
