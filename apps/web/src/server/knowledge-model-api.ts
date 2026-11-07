import 'server-only';
import { idSchema } from '@ensemus/application';
import {
  getKnowledgeModelJob,
  requestKnowledgeModelJob,
  type KnowledgeModelJobView,
} from '@ensemus/application/knowledge/model-jobs';
import { requestSemanticQuerySchema } from '@ensemus/contracts/knowledge-models';
import { apiRoute, organizationParams, readJson } from './api';
const jobParams = organizationParams.extend({ jobId: idSchema });
const dto = (job: KnowledgeModelJobView) => ({
  job_id: job.id,
  kind: job.kind,
  state: job.state,
  code: job.code,
  cost_micros: job.costMicros,
  result: job.result
    ? {
        package_id: job.result.packageId,
        strongest_classification: job.result.classification,
        engine: job.result.engine,
        items: job.result.items.map((item) => ({
          chunk_id: item.chunkId,
          source_id: item.sourceId,
          document_id: item.documentId,
          title: item.title,
          excerpt: item.excerpt,
        })),
      }
    : null,
});
/** Request commits a bounded durable job; HTTP has no model, key, private payload read or Temporal client. */
export const modelJobsPOST = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const input = await readJson(request, requestSemanticQuerySchema);
    const job = await requestKnowledgeModelJob(database, context, {
      ...input,
      kind: 'query',
      answerId: null,
    });
    return Response.json(dto(await getKnowledgeModelJob(database, context, job.jobId)), {
      status: 202,
    });
  },
);
export const modelJobGET = apiRoute(jobParams, async ({ database, context, params }) =>
  Response.json(dto(await getKnowledgeModelJob(database, context, params.jobId))),
);
