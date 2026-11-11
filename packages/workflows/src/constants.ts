export const PLATFORM_TASK_QUEUE = 'ensemus-platform';

/**
 * Activities that hold a credential or touch what a stranger sent. Only the connector worker polls this,
 * and it has no route out except the egress gateway (ADR-027 D5). If it is not running, they wait.
 */
export const CONNECTOR_TASK_QUEUE = 'ensemus-connectors';

/**
 * The code exchange holds a client secret and reaches the provider's token route, so it runs where every
 * other credential does (ADR-038 D1). It is tried once: a code is single use, and a retry could only
 * fail at the provider or, worse, look like a replay.
 */
export const OAUTH_EXCHANGE_TASK_QUEUE = CONNECTOR_TASK_QUEUE;
export const OAUTH_EXCHANGE_MAX_ATTEMPTS = 1;

/**
 * Model calls and tool steps (ADR-028 FD-2). Only agent-worker polls this, and only it holds the sealing
 * key, the agent database role and any route to a model. Workflow code stays on the platform queue.
 */
export const AGENT_TASK_QUEUE = 'ensemus-agent';

/** A wake-up to look at `ai.run_controls`. It carries nothing: PostgreSQL has the answer. */
export const AGENT_RUN_CONTROL_SIGNAL = 'agentRunControl';
/** How often a workflow re-checks a send M3 is carrying out, on a durable timer. */
export const TOOL_WAIT_POLL = '30 seconds';
/** How long an Activity waits for agent-worker to pick it up before the run says so (FD-2). */
export const AGENT_SCHEDULE_TO_START = '5 minutes';

/**
 * Parsing what strangers wrote, and removing what was derived from it. Only the knowledge worker polls
 * this. It holds no credential and no sealing key, and has no route out (ADR-029 D4).
 */
export const KNOWLEDGE_TASK_QUEUE = 'ensemus-knowledge';

/**
 * Knowledge's model calls. The name is M4's agent queue (M4 FD-2): only that worker holds model keys and
 * can reach a model. If it is not running, ingest finishes lexical-only and answers say why.
 */
export const KNOWLEDGE_MODEL_TASK_QUEUE = 'ensemus-agent';

/**
 * For every gRPC client connection to Temporal. By default the client looks up a DNS TXT record for
 * the server's name, to fetch a service config we do not use. Docker cannot answer that for a
 * container name, so it forwards the query to the host's resolver and it leaves the network, which
 * an air-gapped install must never do. The air-gap gate caught exactly this.
 */
export const TEMPORAL_CHANNEL_ARGS = { 'grpc.service_config_disable_resolution': 1 };
