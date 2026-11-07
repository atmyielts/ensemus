// The one place the worker gets M7's ports (ADR-031 D2). The final merge replaces entries here with M4's and
// M5's real ones. Until then each says the capability is not available, and a step that needs one stops.
import { unavailablePorts, type ProductPorts } from '@ensemus/application/product-ports';

export function workerProductPorts(): ProductPorts {
  return unavailablePorts();
}
