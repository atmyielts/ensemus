// Owned by the mcp slice (CONNECT-03). See docs/06-delivery/m5-slices.md and ADR-029 D11. JSON-RPC over the
// gateway, and nothing that server says is trusted. Tested against a local fake only.
import { SyncUnavailable, type Connector, type ConnectorContext } from '../index';
import type { McpToolDescription, ProviderHttpClient } from '../knowledge';
import { MCP_SERVER_MANIFEST } from '../knowledge-manifests';
import { mcpConnectorConfigSchema } from '@ensemus/contracts/knowledge';
import { canonicalJson } from '@ensemus/domain/approval';
import { createHash, randomUUID } from 'node:crypto';

export type McpServerConfig = {
  /** A path on the operator's one configured server. It can never name a host. */
  endpointPath: string;
};

export type McpCallResult = {
  /** Bounded, and treated as untrusted tool output by M4's gateway. */
  content: unknown;
  isError: boolean;
};

export interface McpClient {
  listTools(context: ConnectorContext<McpServerConfig>): Promise<readonly McpToolDescription[]>;
  listToolsWithReport(
    context: ConnectorContext<McpServerConfig>,
  ): Promise<{ tools: readonly McpToolDescription[]; skipped: number }>;
  /** M4's tool gateway is the only caller, once `loadCallableMcpTool` has allowed it. */
  callTool(
    context: ConnectorContext<McpServerConfig>,
    call: { name: string; arguments: unknown; timeoutMs: number; definitionSha256?: string },
  ): Promise<McpCallResult>;
}

type Session = { version: '2026-07-28' | '2025-11-25' | '2025-06-18'; id?: string };
type Reply = {
  status: number;
  headers: Readonly<Record<string, string>>;
  message: Record<string, unknown> | null;
};
const CURRENT = '2026-07-28',
  LEGACY = ['2025-11-25', '2025-06-18'] as const;

/** Current stateless Streamable HTTP plus bounded legacy initialization. No server-initiated request,
 * sampling, elicitation or annotation can create a privilege or a second tool invocation.
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http */
export function createMcpConnector(deps: {
  http: ProviderHttpClient;
}): Connector<McpServerConfig> & { readonly mcp: McpClient } {
  const rpc = async (
    context: ConnectorContext<McpServerConfig>,
    session: Session,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000,
    extra: Readonly<Record<string, string>> = {},
    notification = false,
  ): Promise<Reply> => {
    const id = randomUUID(),
      modern = session.version === CURRENT;
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        ...(notification ? {} : { id }),
        method,
        params: {
          ...params,
          ...(modern
            ? {
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': CURRENT,
                  'io.modelcontextprotocol/clientInfo': { name: 'Ensemus', version: '1' },
                  'io.modelcontextprotocol/clientCapabilities': {},
                },
              }
            : {}),
        },
      }),
    );
    if (body.length > 1_048_576) throw new SyncUnavailable('MCP_REQUEST_TOO_LARGE');
    let response;
    try {
      response = await deps.http.request({
        route: 'mcp_server',
        method: 'POST',
        path: context.config.endpointPath,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': session.version,
          'mcp-method': method,
          ...(session.id ? { 'mcp-session-id': session.id } : {}),
          ...extra,
        },
        body,
        timeoutMs,
        maxResponseBytes: 2_097_152,
        signal: context.signal,
      });
    } catch {
      throw new SyncUnavailable(context.signal.aborted ? 'MCP_TIMEOUT' : 'MCP_UNAVAILABLE');
    }
    if (response.status >= 300 && response.status < 400) throw new SyncUnavailable('MCP_REDIRECT');
    if (response.body.length > 2_097_152) throw new SyncUnavailable('MCP_RESPONSE_TOO_LARGE');
    if (notification) {
      if (response.status !== 202 && response.status !== 204)
        throw new SyncUnavailable('MCP_PROTOCOL_INVALID');
      return { status: response.status, headers: response.headers, message: null };
    }
    let message: Record<string, unknown> | null = null;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
      if (response.headers['content-type']?.split(';')[0]?.trim() === 'text/event-stream') {
        const events = text.replaceAll('\r\n', '\n').split('\n\n');
        if (events.length > 1000) throw new Error('TOO_MANY_EVENTS');
        for (const event of events) {
          const data = event
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const value = plain(JSON.parse(data));
          if (value.method !== undefined) {
            if (value.id !== undefined) throw new Error('SERVER_REQUEST');
            continue;
          }
          if (value.id === id) {
            if (message) throw new Error('DUPLICATE_RESPONSE');
            message = value;
          } else if (value.id !== undefined) throw new Error('WRONG_RESPONSE');
        }
      } else if (text.trim()) message = plain(JSON.parse(text));
    } catch {
      if (response.status === 400) message = null;
      else throw new SyncUnavailable('MCP_PROTOCOL_INVALID');
    }
    if (
      message &&
      (message.jsonrpc !== '2.0' ||
        (message.id !== id && (message.id !== undefined || Object.hasOwn(message, 'result'))) ||
        message.method !== undefined ||
        (Object.hasOwn(message, 'result') && Object.hasOwn(message, 'error')))
    )
      throw new SyncUnavailable('MCP_PROTOCOL_INVALID');
    return { status: response.status, headers: response.headers, message };
  };
  const result = (reply: Reply): Record<string, unknown> => {
    if (
      reply.status < 200 ||
      reply.status >= 300 ||
      !reply.message ||
      reply.message.error ||
      !Object.hasOwn(reply.message, 'result')
    )
      throw new SyncUnavailable('MCP_RPC_FAILED');
    const value = plain(reply.message.result);
    if (value.resultType !== undefined && value.resultType !== 'complete')
      throw new SyncUnavailable('MCP_INPUT_REQUIRED');
    return value;
  };
  const open = async (context: ConnectorContext<McpServerConfig>): Promise<Session> => {
    const probe = await rpc(context, { version: CURRENT }, 'server/discover', {});
    if (probe.status >= 200 && probe.status < 300 && !probe.message?.error) {
      result(probe);
      return { version: CURRENT };
    }
    const error = probe.message?.error ? plain(probe.message.error) : null,
      code = error?.code;
    const advertised = code === -32022 && error?.data ? plain(error.data).supported : null;
    if (
      code === -32020 ||
      code === -32021 ||
      code === -32602 ||
      (code === -32022 &&
        (!Array.isArray(advertised) ||
          !advertised.some((value) => (LEGACY as readonly unknown[]).includes(value))))
    )
      throw new SyncUnavailable('MCP_PROTOCOL_UNSUPPORTED');
    if (probe.status !== 400 && !(probe.status === 404 && code === -32601))
      throw new SyncUnavailable('MCP_PROTOCOL_UNSUPPORTED');
    const initialized = await rpc(context, { version: '2025-11-25' }, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'Ensemus', version: '1' },
    });
    const value = result(initialized),
      version = value.protocolVersion;
    if (!(LEGACY as readonly unknown[]).includes(version))
      throw new SyncUnavailable('MCP_PROTOCOL_UNSUPPORTED');
    const sessionId = initialized.headers['mcp-session-id'];
    if (sessionId && !/^[\x21-\x7e]{1,512}$/.test(sessionId))
      throw new SyncUnavailable('MCP_PROTOCOL_INVALID');
    const session: Session = {
      version: version as Session['version'],
      ...(sessionId ? { id: sessionId } : {}),
    };
    await rpc(context, session, 'notifications/initialized', {}, 30_000, {}, true);
    return session;
  };
  const close = async (context: ConnectorContext<McpServerConfig>, session: Session) => {
    if (!session.id || context.signal.aborted) return;
    try {
      await deps.http.request({
        route: 'mcp_server',
        method: 'DELETE',
        path: context.config.endpointPath,
        headers: { 'mcp-protocol-version': session.version, 'mcp-session-id': session.id },
        timeoutMs: 3000,
        maxResponseBytes: 1024,
        signal: context.signal,
      });
    } catch {
      /* Session cleanup has no business effect and never retries a tool. */
    }
  };
  const collect = async (context: ConnectorContext<McpServerConfig>, session: Session) => {
    const tools: McpToolDescription[] = [],
      names = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | undefined,
      skipped = 0,
      seen = 0;
    for (let page = 0; page < 20; page++) {
      const data = result(await rpc(context, session, 'tools/list', cursor ? { cursor } : {}));
      if (!Array.isArray(data.tools) || data.tools.length > 1000 || seen + data.tools.length > 1000)
        throw new SyncUnavailable('MCP_TOOL_LIMIT');
      seen += data.tools.length;
      for (const raw of data.tools) {
        try {
          const definition = plain(raw),
            name = definition.name;
          if (
            typeof name !== 'string' ||
            !name ||
            name.length > 128 ||
            /[\0\r\n]/.test(name) ||
            !definition.inputSchema
          )
            throw new Error('INVALID_TOOL');
          if (names.has(name)) throw new SyncUnavailable('MCP_DUPLICATE_TOOL');
          names.add(name);
          mcpDefinitionHash(definition);
          headerFields(definition.inputSchema);
          tools.push({ name, definition });
        } catch (error) {
          if (error instanceof SyncUnavailable && error.code === 'MCP_DUPLICATE_TOOL') throw error;
          skipped++;
        }
      }
      if (data.nextCursor === undefined) return { tools, skipped };
      if (
        typeof data.nextCursor !== 'string' ||
        !data.nextCursor ||
        data.nextCursor.length > 8192 ||
        cursors.has(data.nextCursor)
      )
        throw new SyncUnavailable('MCP_PROTOCOL_INVALID');
      cursor = data.nextCursor;
      cursors.add(cursor);
    }
    throw new SyncUnavailable('MCP_TOOL_LIMIT');
  };
  const list = async (context: ConnectorContext<McpServerConfig>) => {
    const session = await open(context);
    try {
      return await collect(context, session);
    } finally {
      await close(context, session);
    }
  };
  return {
    manifest: MCP_SERVER_MANIFEST,
    parseConfig(raw) {
      const result = mcpConnectorConfigSchema.safeParse(raw);
      if (!result.success) throw new SyncUnavailable('CONFIG_INVALID');
      return { endpointPath: result.data.endpoint_path };
    },
    mcp: {
      async listTools(context) {
        return (await list(context)).tools;
      },
      listToolsWithReport: list,
      async callTool(context, call) {
        // The root gateway passes the approved definition hash from loadCallableMcpTool. An absent proof
        // refuses before any network operation; external_write still requires an M3 approved attempt.
        if (!call.definitionSha256 || !/^[0-9a-f]{64}$/.test(call.definitionSha256))
          throw new SyncUnavailable('MCP_TOOL_NOT_APPROVED');
        if (!Number.isInteger(call.timeoutMs) || call.timeoutMs < 1 || call.timeoutMs > 120_000)
          throw new SyncUnavailable('MCP_REQUEST_INVALID');
        const args = plain(call.arguments);
        validateJson(args);
        if (Buffer.byteLength(canonicalJson(args)) > 65536)
          throw new SyncUnavailable('MCP_REQUEST_TOO_LARGE');
        const session = await open(context);
        try {
          const listed = await collect(context, session),
            tool = listed.tools.find((tool) => tool.name === call.name);
          if (!tool || mcpDefinitionHash(tool.definition) !== call.definitionSha256)
            throw new SyncUnavailable('MCP_TOOL_NOT_APPROVED');
          const headers: Record<string, string> = { 'mcp-name': headerValue(call.name) };
          if (session.version === CURRENT)
            for (const field of headerFields(plain(tool.definition).inputSchema)) {
              let value: unknown = args;
              for (const key of field.path) {
                if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
                  value = undefined;
                  break;
                }
                value = (value as Record<string, unknown>)[key];
              }
              if (value === null || value === undefined) continue;
              if (
                typeof value !== field.type ||
                (field.type === 'number' && !Number.isSafeInteger(value))
              )
                throw new SyncUnavailable('MCP_ARGUMENT_INVALID');
              headers[`mcp-param-${field.name}`] = headerValue(String(value));
            }
          const response = result(
            await rpc(
              context,
              session,
              'tools/call',
              { name: call.name, arguments: args },
              call.timeoutMs,
              headers,
            ),
          );
          if (response.isError !== undefined && typeof response.isError !== 'boolean')
            throw new SyncUnavailable('MCP_PROTOCOL_INVALID');
          return {
            content:
              response.content !== undefined && response.structuredContent !== undefined
                ? { content: response.content, structuredContent: response.structuredContent }
                : (response.content ?? response.structuredContent ?? null),
            isError: response.isError === true,
          };
        } finally {
          await close(context, session);
        }
      },
    },
  };
}

/** SHA-256 over canonical JSON of a tool's whole description, so any change at all loses its approval. */
export function mcpDefinitionHash(definition: unknown): string {
  validateJson(definition);
  const canonical = canonicalJson(definition);
  if (Buffer.byteLength(canonical) > 65536) throw new SyncUnavailable('MCP_DEFINITION_TOO_LARGE');
  return createHash('sha256').update(canonical).digest('hex');
}

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SyncUnavailable('MCP_PROTOCOL_INVALID');
  return value as Record<string, unknown>;
}
function validateJson(value: unknown) {
  const stack = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++count > 20000 || item.depth > 64) throw new SyncUnavailable('MCP_DEFINITION_TOO_LARGE');
    if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean')
      continue;
    if (typeof item.value === 'number' && Number.isFinite(item.value)) continue;
    if (
      !item.value ||
      typeof item.value !== 'object' ||
      (!Array.isArray(item.value) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(item.value)))
    )
      throw new SyncUnavailable('MCP_PROTOCOL_INVALID');
    for (const child of Array.isArray(item.value) ? item.value : Object.values(item.value))
      stack.push({ value: child, depth: item.depth + 1 });
  }
}
function headerValue(value: string) {
  const encoded =
    !/^[\x20-\x7e]*$/.test(value) ||
    value.trim() !== value ||
    (value.startsWith('=?base64?') && value.endsWith('?='));
  const result = encoded ? `=?base64?${Buffer.from(value).toString('base64')}?=` : value;
  if (result.length > 16000) throw new SyncUnavailable('MCP_REQUEST_TOO_LARGE');
  return result;
}
function headerFields(
  schema: unknown,
): readonly { name: string; path: readonly string[]; type: 'string' | 'number' | 'boolean' }[] {
  const fields: { name: string; path: readonly string[]; type: 'string' | 'number' | 'boolean' }[] =
      [],
    seen = new Set<string>();
  const visit = (raw: unknown, path: readonly string[], reachable: boolean, depth: number) => {
    if (depth > 64) throw new SyncUnavailable('MCP_PROTOCOL_INVALID');
    if (typeof raw === 'boolean') return;
    const node = plain(raw);
    if (node['x-mcp-header'] !== undefined) {
      const name = node['x-mcp-header'];
      if (
        !reachable ||
        !path.length ||
        typeof name !== 'string' ||
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) ||
        seen.has(name.toLowerCase()) ||
        !['string', 'integer', 'boolean'].includes(String(node.type))
      )
        throw new SyncUnavailable('MCP_PROTOCOL_INVALID');
      seen.add(name.toLowerCase());
      fields.push({
        name,
        path,
        type: node.type === 'integer' ? 'number' : (node.type as 'string' | 'boolean'),
      });
    }
    if (node.properties)
      for (const [key, child] of Object.entries(plain(node.properties)))
        visit(child, [...path, key], reachable, depth + 1);
    for (const key of [
      'items',
      'additionalProperties',
      'not',
      'if',
      'then',
      'else',
      'contains',
      'propertyNames',
    ])
      if (node[key] && typeof node[key] === 'object') visit(node[key], path, false, depth + 1);
    for (const key of ['oneOf', 'anyOf', 'allOf', 'prefixItems'])
      if (Array.isArray(node[key]))
        for (const child of node[key] as unknown[]) visit(child, path, false, depth + 1);
    for (const key of ['$defs', 'definitions', 'patternProperties', 'dependentSchemas'])
      if (node[key])
        for (const child of Object.values(plain(node[key]))) visit(child, path, false, depth + 1);
  };
  visit(schema, [], true, 0);
  return fields;
}
