// EXP-02, ADR-033 D2: metadata about fixed operator routes; never a tenant-supplied address.
import type { BusinessConnectorType } from '@ensemus/domain/business-connector';
import { ConfigError } from './index';
const SETTINGS = {
  crm_http: 'ENSEMUS_EGRESS_GATEWAY_CRM',
  ticketing_http: 'ENSEMUS_EGRESS_GATEWAY_TICKETING',
  accounting_http: 'ENSEMUS_EGRESS_GATEWAY_ACCOUNTING',
  meeting_notes_http: 'ENSEMUS_EGRESS_GATEWAY_MEETING_NOTES',
} as const satisfies Record<BusinessConnectorType | 'meeting_notes_http', string>;
type AdapterRoute = keyof typeof SETTINGS;
export function loadBusinessConnectorRoutes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Partial<Record<AdapterRoute, string>> {
  const routes: Partial<Record<AdapterRoute, string>> = {};
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
    routes[type as AdapterRoute] = address;
  }
  return routes;
}
