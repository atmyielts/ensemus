// The shared part of the business connectors (ADR-033 D2), for the connector worker only (lint blocks it from
// the web tier).
export {
  adapterExchange,
  AdapterNoAnswer,
  AdapterNotContacted,
  MAX_ADAPTER_RESPONSE_BYTES,
  type AdapterAnswer,
  type AdapterRequest,
  type AdapterTransport,
} from './http';
export {
  ADAPTER_ANSWER_MS,
  ADAPTER_BEFORE_COMMIT_MS,
  createBusinessConnector,
  parseBusinessConfig,
  transportFor,
  type BusinessConnectorOptions,
  type BusinessConnectorSpec,
  type BusinessRecordSink,
  type BusinessRecordWrite,
  type BusinessToolSpec,
} from './kit';
export { routeConnector } from './route';
