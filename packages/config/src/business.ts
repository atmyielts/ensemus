// EXP-02, ADR-033 D2: metadata about fixed operator routes; never a tenant-supplied address.
import type { BusinessConnectorType } from '@ensemus/domain/business-connector';
import { ConfigError } from './index';
const SETTINGS = {
  crm_http: 'ENSEMUS_EGRESS_GATEWAY_CRM',
  ticketing_http: 'ENSEMUS_EGRESS_GATEWAY_TICKETING',
  accounting_http: 'ENSEMUS_EGRESS_GATEWAY_ACCOUNTING',
} as const;
export function loadBusinessConnectorRoutes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Partial<Record<BusinessConnectorType, string>> {
  const routes: Partial<Record<BusinessConnectorType, string>> = {};
  for (const [type, setting] of Object.entries(SETTINGS)) {
    const address = env[setting]?.trim();
    if (!address) continue;
    if (env.ENSEMUS_MODE === 'cloud')
      throw new ConfigError(
        'Business adapter routes require BYOM or Sovereign until tenant routing is qualified',
      );
    let url: URL;
    try {
      url = new URL(`tcp://${address}`);
    } catch {
      throw new ConfigError(`Invalid ${setting}`);
    }
    if (
      !url.hostname ||
      !url.port ||
      Number(url.port) < 1 ||
      Number(url.port) > 65535 ||
      url.username ||
      url.password ||
      url.pathname ||
      url.search ||
      url.hash
    )
      throw new ConfigError(`Invalid ${setting}`);
    routes[type as BusinessConnectorType] = address;
  }
  return routes;
}
