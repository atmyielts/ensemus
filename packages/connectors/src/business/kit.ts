// What a CRM, ticketing or accounting connector has in common (ADR-033 D2). Each one is a spec: its manifest,
// its type and a parser per tool. Everything that decides whether a repeat is safe, what is stored and what an
// answer means is here, once, so a mistake gets fixed in one place and each connector is short to review.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  adapterChangeNoticeSchema,
  adapterOperationAnswerSchema,
  adapterPageSchema,
  ADAPTER_BASE_PATH,
} from '@ensemus/contracts/business-adapter';
import { businessConnectorConfigSchema } from '@ensemus/contracts/business-records';
import type { BusinessConnectorConfig } from '@ensemus/contracts/business-records';
import {
  BUSINESS_STREAMS,
  readScopeFor,
  recordClassification,
  selectRecordFields,
  writeScopeFor,
  type BusinessConnectorType,
  type RecordFields,
} from '@ensemus/domain/business-connector';
import type { SyncedResource, SyncPage } from '@ensemus/domain/connector';
import {
  CursorExpired,
  MalformedWebhook,
  NotSent,
  SyncUnavailable,
  type ActionRequest,
  type AttemptResult,
  type Connector,
  type ConnectorContext,
  type ReconcileResult,
  type SyncRequest,
  type VerifiedWebhook,
} from '../index';
import type { ConnectorManifest } from '../manifest';
import {
  adapterExchange,
  AdapterNoAnswer,
  AdapterNotContacted,
  type AdapterAnswer,
  type AdapterTransport,
} from './http';

/** One record's kept fields, handed to the sink before its page's cursor commits. */
export type BusinessRecordWrite = {
  externalId: string;
  externalVersion: string | null;
  displayName: string | null;
  fields: RecordFields;
  fieldsSha256: string;
  classification: NonNullable<SyncedResource['classification']>;
};

/**
 * Where kept fields go. A port, because a connector never sees the database: the connector worker backs it on
 * to applyBusinessRecordPage. Written before the cursor moves, and idempotent, so a crash repeats a page and
 * changes nothing. A record whose resource row is not there yet is readable by nobody (ADR-033 D3).
 */
export interface BusinessRecordSink {
  applyPage(page: {
    organizationId: string;
    connectionId: string;
    connectorType: BusinessConnectorType;
    stream: string;
    records: readonly BusinessRecordWrite[];
    deletedExternalIds: readonly string[];
  }): Promise<void>;
}

export type BusinessToolSpec = {
  version: string;
  /** Checks the stored payload again before sending. Throws for anything it does not accept. */
  parsePayload(raw: unknown): unknown;
};

export type BusinessConnectorSpec = {
  type: BusinessConnectorType;
  manifest: ConnectorManifest;
  tools: Readonly<Record<string, BusinessToolSpec>>;
};

export type BusinessConnectorOptions = {
  /** `required` unless an operator has said otherwise for an adapter on a trusted site network. */
  tls: 'required' | 'none';
  ca?: string;
  sink: BusinessRecordSink;
  /** Only a test changes these. */
  beforeCommitMs?: number;
  answerMs?: number;
};

/** Half of runSend's deadline, for the reason createEmailConnector gives. The rest is for the reply. */
export const ADAPTER_BEFORE_COMMIT_MS = 30_000;
export const ADAPTER_ANSWER_MS = 55_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const transportFor = (options: {
  tls: 'required' | 'none';
  ca?: string;
  beforeCommitMs?: number;
  answerMs?: number;
}): AdapterTransport => ({
  tls: options.tls,
  ...(options.ca ? { ca: options.ca } : {}),
  beforeCommitMs: options.beforeCommitMs ?? ADAPTER_BEFORE_COMMIT_MS,
  answerMs: options.answerMs ?? ADAPTER_ANSWER_MS,
});

/** Checks stored settings against this connector. Says nothing about what it was given. */
export function parseBusinessConfig(
  type: BusinessConnectorType,
  raw: unknown,
): BusinessConnectorConfig {
  const parsed = businessConnectorConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error('CONFIG_INVALID');
  const allowedStreams = BUSINESS_STREAMS[type];
  const allowedScopes = [readScopeFor(type), writeScopeFor(type)];
  if (
    parsed.data.streams.some((stream) => !Object.hasOwn(allowedStreams, stream)) ||
    parsed.data.scopes.some((scope) => !allowedScopes.includes(scope))
  ) {
    throw new Error('CONFIG_INVALID');
  }
  return parsed.data;
}

function syncFailure(answer: AdapterAnswer): Error {
  if (answer.status === 401 || answer.status === 403)
    return new SyncUnavailable('SYNC_AUTH_FAILED');
  if (answer.status === 410) return new CursorExpired();
  if (answer.status === 429) return new SyncUnavailable('SYNC_RATE_LIMITED');
  return new SyncUnavailable('SYNC_UNAVAILABLE');
}

const emptyPage = (cursor: string | null): SyncPage => ({
  resources: [],
  deletedExternalIds: [],
  nextCursor: cursor,
  hasMore: false,
});

/** Turns a read's failure into the only error a sync pass may show an administrator. */
function syncError(error: unknown): Error {
  if (error instanceof SyncUnavailable || error instanceof CursorExpired) return error;
  if (error instanceof AdapterNotContacted && error.code === 'CREDENTIAL_UNAVAILABLE') {
    return new SyncUnavailable('CREDENTIAL_UNAVAILABLE');
  }
  if (error instanceof AdapterNoAnswer && error.code === 'TIMEOUT_AFTER_COMMIT') {
    return new SyncUnavailable('SYNC_TIMEOUT');
  }
  return new SyncUnavailable('SYNC_UNAVAILABLE');
}

async function readPage(
  spec: BusinessConnectorSpec,
  options: BusinessConnectorOptions,
  context: ConnectorContext<BusinessConnectorConfig>,
  request: SyncRequest,
): Promise<SyncPage> {
  const { config } = context;
  const rules = BUSINESS_STREAMS[spec.type];
  if (!Object.hasOwn(rules, request.stream)) throw new SyncUnavailable('SYNC_UNAVAILABLE');
  // Not selected, so nothing goes out and nothing comes back. A page saying so has no effect.
  if (!config.streams.includes(request.stream)) return emptyPage(request.cursor);
  if (!config.scopes.includes(readScopeFor(spec.type))) {
    throw new SyncUnavailable('SYNC_AUTH_FAILED');
  }

  const query = new URLSearchParams({ limit: String(request.pageSize) });
  if (request.cursor !== null) query.set('cursor', request.cursor);
  if (request.fullSync) query.set('full', '1');
  let answer: AdapterAnswer;
  try {
    answer = await adapterExchange(context, transportFor(options), {
      method: 'GET',
      path: `${ADAPTER_BASE_PATH}/streams/${encodeURIComponent(request.stream)}/records?${query}`,
      serverName: config.tlsServerName ?? null,
    });
  } catch (error) {
    throw syncError(error);
  }
  if (answer.status !== 200) throw syncFailure(answer);
  const parsed = adapterPageSchema.safeParse(answer.json);
  if (!parsed.success) throw new SyncUnavailable('SYNC_PAGE_INVALID');
  const { records, deleted, next_cursor: nextCursor, has_more: hasMore } = parsed.data;
  const titleField = (rules[request.stream] as { titleField: string }).titleField;

  const writes: BusinessRecordWrite[] = [];
  const resources: SyncedResource[] = [];
  for (const record of records) {
    const kept = selectRecordFields(request.stream, record.fields);
    if (!kept.ok) throw new SyncUnavailable('SYNC_PAGE_INVALID');
    const classification = recordClassification(spec.type, record.classification);
    const title = kept.fields[titleField];
    const displayName = typeof title === 'string' && title.length > 0 ? title : null;
    const fieldsSha256 = sha256(canonicalJson(kept.fields));
    writes.push({
      externalId: record.id,
      externalVersion: record.version,
      displayName,
      fields: kept.fields,
      fieldsSha256,
      classification,
    });
    resources.push({
      externalId: record.id,
      resourceType: request.stream,
      externalVersion: record.version,
      ...(displayName ? { displayName: displayName.slice(0, 500) } : {}),
      contentSha256: fieldsSha256,
      classification,
      acl: record.acl.map((grant) => ({
        principalKind: grant.principal_kind,
        principalExternalId: grant.principal_external_id,
        access: grant.access,
      })),
    });
  }

  await options.sink.applyPage({
    organizationId: context.organizationId,
    connectionId: context.connectionId,
    connectorType: spec.type,
    stream: request.stream,
    records: writes,
    deletedExternalIds: deleted,
  });
  return { resources, deletedExternalIds: deleted, nextCursor, hasMore };
}

/**
 * Reads what an operation's answer means. 429 and 503 are the protocol's way of saying "not done, try later".
 * Anything else that is not a clear yes or no reads as "it may have happened": a connector must not cause a
 * second effect by guessing (ADR-027 D2).
 */
function attemptResultOf(answer: AdapterAnswer): AttemptResult {
  const { status } = answer;
  if (status === 429 || status === 503) throw new NotSent('RELAY_BUSY', true);
  if (status === 401 || status === 403) {
    return { outcome: 'rejected', code: 'AUTH_FAILED', providerStatus: status };
  }
  if (status >= 400 && status < 500) {
    return { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER', providerStatus: status };
  }
  if (status >= 200 && status < 300) {
    const parsed = adapterOperationAnswerSchema.safeParse(answer.json);
    if (parsed.success && parsed.data.status === 'applied') {
      return {
        outcome: 'accepted',
        code: 'ACCEPTED_BY_PROVIDER',
        providerStatus: status,
        ...(parsed.data.operation_id ? { externalId: parsed.data.operation_id } : {}),
      };
    }
    if (parsed.success) {
      return { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER', providerStatus: status };
    }
  }
  return { outcome: 'indeterminate', code: 'CONNECTION_LOST_AFTER_COMMIT', providerStatus: status };
}

async function send(
  spec: BusinessConnectorSpec,
  options: BusinessConnectorOptions,
  context: ConnectorContext<BusinessConnectorConfig>,
  request: ActionRequest,
): Promise<AttemptResult> {
  const { config } = context;
  // Each of these fails the same way every time, so none is retryable and none contacts anyone.
  const tool = spec.tools[request.toolName];
  if (!tool || tool.version !== request.toolVersion) throw new NotSent('PAYLOAD_CHANGED', false);
  let payload: unknown;
  try {
    payload = tool.parsePayload(request.payload);
  } catch {
    throw new NotSent('PAYLOAD_CHANGED', false);
  }
  if (!config.scopes.includes(writeScopeFor(spec.type))) throw new NotSent('AUTH_FAILED', false);

  try {
    const answer = await adapterExchange(context, transportFor(options), {
      method: 'POST',
      path: `${ADAPTER_BASE_PATH}/operations`,
      serverName: config.tlsServerName ?? null,
      idempotencyKey: request.idempotencyKey,
      body: {
        tool: request.toolName,
        tool_version: request.toolVersion,
        idempotency_key: request.idempotencyKey,
        request_hash: request.requestHash,
        payload,
      },
    });
    return attemptResultOf(answer);
  } catch (error) {
    if (error instanceof AdapterNotContacted) throw new NotSent(error.code, error.retryable);
    if (error instanceof AdapterNoAnswer) return { outcome: 'indeterminate', code: error.code };
    throw error;
  }
}

/** Asks whether the operation happened, by our own key. Read-only, and never sends anything. */
async function reconcile(
  options: BusinessConnectorOptions,
  context: ConnectorContext<BusinessConnectorConfig>,
  request: ActionRequest,
): Promise<ReconcileResult> {
  try {
    const answer = await adapterExchange(context, transportFor(options), {
      method: 'GET',
      path: `${ADAPTER_BASE_PATH}/operations/${encodeURIComponent(request.idempotencyKey)}`,
      serverName: context.config.tlsServerName ?? null,
    });
    if (answer.status === 404) return { answer: 'not_found' };
    if (answer.status !== 200) return { answer: 'cannot_answer' };
    const parsed = adapterOperationAnswerSchema.safeParse(answer.json);
    if (!parsed.success) return { answer: 'cannot_answer' };
    if (parsed.data.status === 'rejected') return { answer: 'refused', providerStatus: 200 };
    return {
      answer: 'found',
      providerStatus: 200,
      ...(parsed.data.operation_id ? { externalId: parsed.data.operation_id } : {}),
    };
  } catch {
    return { answer: 'cannot_answer' };
  }
}

/**
 * A signed "something changed". It can only ask for a sync, whatever else a sender puts in it, and it runs
 * after the signature has passed.
 */
function interpret(_context: ConnectorContext<BusinessConnectorConfig>, webhook: VerifiedWebhook) {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(webhook.body));
  } catch {
    throw new MalformedWebhook();
  }
  if (!adapterChangeNoticeSchema.safeParse(body).success) throw new MalformedWebhook();
  return [{ kind: 'sync_requested' as const }];
}

/** Builds a connector from its spec. The list of what it can do comes from the manifest and nowhere else. */
export function createBusinessConnector(
  spec: BusinessConnectorSpec,
  options: BusinessConnectorOptions,
): Connector<BusinessConnectorConfig> {
  return {
    manifest: spec.manifest,
    parseConfig: (raw) => parseBusinessConfig(spec.type, raw),
    actions: {
      send: (context, request) => send(spec, options, context, request),
      reconcile: (context, request) => reconcile(options, context, request),
    },
    sync: { readPage: (context, request) => readPage(spec, options, context, request) },
    webhooks: { interpret },
  };
}
