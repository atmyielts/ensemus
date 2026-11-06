export const PLATFORM_TASK_QUEUE = 'ensemus-platform';

/**
 * Activities that hold a credential or touch what a stranger sent. Only the connector worker polls this,
 * and it has no route out except the egress gateway (ADR-027 D5). If it is not running, they wait.
 */
export const CONNECTOR_TASK_QUEUE = 'ensemus-connectors';

/**
 * Activities that use the one role that crosses tenants. Only the federation worker polls this, and it
 * runs only where an operator turned cross-organization work on (ADR-035 D2). If it is not running, they
 * wait, and nothing crosses.
 */
export const FEDERATION_TASK_QUEUE = 'ensemus-federation';

/**
 * For every gRPC client connection to Temporal. By default the client looks up a DNS TXT record for
 * the server's name, to fetch a service config we do not use. Docker cannot answer that for a
 * container name, so it forwards the query to the host's resolver and it leaves the network, which
 * an air-gapped install must never do. The air-gap gate caught exactly this.
 */
export const TEMPORAL_CHANNEL_ARGS = { 'grpc.service_config_disable_resolution': 1 };
