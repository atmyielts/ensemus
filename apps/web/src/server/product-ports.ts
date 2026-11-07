import 'server-only';
import type { ProductPorts } from '@ensemus/application/product-ports';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import { getRuntime } from './runtime';

/**
 * Real metadata and authorized DAL effects. No provider transport or credential is present.
 */
export function webProductPorts(): ProductPorts {
  return createRuntimeProductPorts(getRuntime().app);
}
