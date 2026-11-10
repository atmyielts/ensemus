import 'server-only';
import { createKnowledgeReadPorts } from '@ensemus/application/knowledge/egress';
import type { AppDatabase, TenantContext } from '@ensemus/database';

/** Request-bound actual M4/Knowledge readers and the shared pure policy. No credentials. */
export const getKnowledgeReadPorts = (database: AppDatabase, context: TenantContext) =>
  createKnowledgeReadPorts(database, context);
