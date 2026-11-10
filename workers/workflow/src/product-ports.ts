// Actual database adapters. Durable process agent starts retain the saved initiator boundary.
import type { ProductPorts } from '@ensemus/application/product-ports';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import type { AppDatabase } from '@ensemus/database';

export function workerProductPorts(database: AppDatabase): ProductPorts {
  return createRuntimeProductPorts(database);
}
