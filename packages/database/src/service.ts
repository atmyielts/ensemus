// For worker processes only (lint blocks this from the web tier).
export {
  assertLoginRole,
  createDelegatedContext,
  createServiceContext,
  type WorkerLoginRole,
} from './tenant';
