import 'server-only';
import { unavailablePorts, type ProductPorts } from '@ensemus/application/product-ports';

/**
 * The one place the web tier gets M7's ports (ADR-031 D2). The final merge replaces entries here with M4's and
 * M5's real ones. Until then each says the capability is not available, and each page words that plainly.
 */
export function webProductPorts(): ProductPorts {
  return unavailablePorts();
}
