import { auditRefusal } from '@ensemus/application';
import {
  AgentSpecRefused,
  getAgentPolicyVersion,
  isPublishGateRefusal,
  listAgentVersions,
  publishAgentVersion,
} from '@ensemus/application/ai-agents';
import type { components } from '@ensemus/contracts/openapi';
import { errorCode } from '@ensemus/telemetry';
import { z } from 'zod';
import { apiLog, apiRoute, organizationParams, readJson } from '@/server/api';

export const dynamic = 'force-dynamic';

type ApiErrorBody = components['schemas']['Error'];

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  const items = await listAgentVersions(database, context);
  return Response.json({ items });
});

// Only the outer shape here. The service parses both parts itself, so a refused spec and a missing report
// get their own codes and go on the record, instead of looking like a mistyped request.
const publishBody = z.strictObject({
  spec: z.unknown(),
  evaluation_report: z.unknown(),
});

export const POST = apiRoute(
  organizationParams,
  async ({ request, requestId, context, database }) => {
    const body = await readJson(request, publishBody);
    try {
      const version = await publishAgentVersion(database, context, {
        spec: body.spec,
        evaluationReport: body.evaluation_report,
        // The server's own answer, and it is read again inside the publish: a caller names no policy.
        policyVersion: await getAgentPolicyVersion(database, context),
      });
      return Response.json(version, { status: 201 });
    } catch (error) {
      if (!isPublishGateRefusal(error)) throw error;
      // This is how grants get set, so an attempt past the gate is worth finding later. Failing to write
      // the record never changes what the caller hears.
      await auditRefusal(database, context, { code: error.code, surface: 'api' }).catch(
        (failure: unknown) =>
          apiLog.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
      );
      if (!(error instanceof AgentSpecRefused)) throw error;
      // Rule codes and field names from our own schema. Nothing the caller sent is repeated back.
      const refused: ApiErrorBody = {
        code: error.code,
        message: error.message,
        request_id: requestId,
        retryable: false,
        details: { lint_codes: error.lintCodes, fields: error.fields },
      };
      return Response.json(refused, { status: 400 });
    }
  },
);
