// Workspace suites' additions to the connector SDK (ADR-038 D2, D4, D6). Kept apart from the SDK's contract
// and from M5's knowledge additions, so neither file changes for them.
import { parseSuiteActionPayload, SUITE_TOOL_ARGS_SCHEMAS } from '@ensemus/contracts/ai-tools';
import type { AiClassification } from '@ensemus/domain/ai';
import { toolManifest } from '@ensemus/domain/ai-tools';
import type { DirectoryPage } from '@ensemus/domain/workspace-suites';
import type { ZodType } from 'zod';
import {
  NotSent,
  type ActionConnector,
  type ActionRequest,
  type AttemptResult,
  type Connector,
  type ConnectorContext,
  type ReconcileResult,
} from './index';

export type {
  DirectoryGroup,
  DirectoryMember,
  DirectoryPage,
} from '@ensemus/domain/workspace-suites';
export { CursorExpired, SyncUnavailable } from './index';

export type PlatformOAuthProvider = 'google' | 'microsoft';

/** The operator's own app for one provider. The secret lives in memory only, for one token request. */
export type PlatformOAuthClient = { client_id: string; client_secret: string };

/**
 * The operator's apps, from the connector worker's configuration and nowhere else (ADR-038 D2). The web
 * tier never holds this: it knows only the public client ID, to build the authorize URL. A credential
 * naming `client: 'platform'` for a provider this answers null for is refused as CREDENTIAL_INVALID.
 */
export interface PlatformOAuthClients {
  get(provider: PlatformOAuthProvider): PlatformOAuthClient | null;
}

/**
 * Reads a provider's groups and their direct members, one page at a time (ADR-038 D4). No effect at the
 * source, and repeating it with the same cursor is safe. A null cursor starts a full pass, and the page
 * says whether it belongs to one. When the provider says the cursor no longer works it throws
 * CursorExpired, and the stream goes back to a full pass, as a sync stream does. Any other failure is a
 * SyncUnavailable with a code and no provider text. Nested groups come back as `group` members, and the
 * application flattens them.
 */
export interface DirectoryConnector<TConfig = unknown> {
  readGroups(context: ConnectorContext<TConfig>, cursor: string | null): Promise<DirectoryPage>;
}

export type DirectoryCapableConnector<TConfig = unknown> = Connector<TConfig> & {
  readonly directory: DirectoryConnector<TConfig>;
};

export const hasDirectory = (connector: Connector): connector is DirectoryCapableConnector =>
  'directory' in connector && (connector as { directory?: unknown }).directory !== undefined;

// --- Suite tools for agents (ADR-038 D6, "D6 in detail"). Reads come through `suiteReads`. Changes are
// ADR-027 intents and come through the connector's ordinary `actions`. Both dispatch by the tool's ID to a
// handler, so a provider's connector only fills in handlers.

/** Which tool a read is for, as its manifest names it. A version the connector does not know is refused. */
export type SuiteReadTool = { id: string; version: string };

export type SuiteReadResult = {
  /** UTF-8 text, JSON or plain. Anything else is refused when the answer is collected. */
  bytes: Buffer;
  mediaType: 'application/json' | 'text/plain';
  /** The class the source's content carries. The worker raises it to every resource's own class. */
  classification: AiClassification;
  /**
   * Every resource of the organization's content this output contains, by the provider's ID. Through the
   * organization's connection the worker checks each against the initiator's source ACL and refuses the
   * whole output if any is not theirs. Empty for a member's own account.
   */
  resourceExternalIds: readonly string[];
};

/**
 * Asks which of these resources the run's initiator may have, through the organization's connection. A
 * search uses it to drop results before they are kept. A port, so the connector needs no database. Null
 * for a member's own connection, where everything is theirs.
 */
export interface SuiteResourceAccess {
  permitted(externalIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export const SUITE_READ_REFUSALS = [
  'TOOL_ARGS_INVALID',
  'TOOL_UNKNOWN',
  'SCOPE_NOT_GRANTED',
  'RESOURCE_NOT_PERMITTED',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_REFUSED',
  'PROVIDER_UNAVAILABLE',
  'TOOL_OUTPUT_TOO_LARGE',
  'NOT_IMPLEMENTED',
] as const;
export type SuiteReadRefusal = (typeof SUITE_READ_REFUSALS)[number];

/** A read that will not succeed by asking again. A code, never the provider's words. */
export class SuiteReadRefused extends Error {
  override name = 'SuiteReadRefused';
  constructor(readonly code: SuiteReadRefusal) {
    super(code);
  }
}

export interface SuiteReadConnector<TConfig = unknown> {
  /**
   * One read, with no effect at the source and safe to repeat. The arguments were parsed by the tool's
   * schema before the gateway passed them, and are parsed again here. Throws SuiteReadRefused or
   * SyncUnavailable with a code, and nothing with provider text.
   */
  read(
    context: ConnectorContext<TConfig>,
    tool: SuiteReadTool,
    args: unknown,
    access: SuiteResourceAccess | null,
  ): Promise<SuiteReadResult>;
}

export type SuiteCapableConnector<TConfig = unknown> = Connector<TConfig> & {
  readonly suiteReads: SuiteReadConnector<TConfig>;
};

export const hasSuiteReads = (connector: Connector): connector is SuiteCapableConnector =>
  'suiteReads' in connector && (connector as { suiteReads?: unknown }).suiteReads !== undefined;

/** A read handler, given the provider's own helpers and arguments already parsed by the tool's schema. */
export type SuiteReadHandler<TDeps> = (
  deps: TDeps,
  context: ConnectorContext,
  args: Record<string, unknown>,
  access: SuiteResourceAccess | null,
) => Promise<SuiteReadResult>;

/** A change's handlers. `send` follows ActionConnector's rules exactly: NotSent only when certain. */
export type SuiteActionHandler<TDeps> = {
  send(
    deps: TDeps,
    context: ConnectorContext,
    request: ActionRequest<Record<string, unknown>>,
  ): Promise<AttemptResult>;
  reconcile(
    deps: TDeps,
    context: ConnectorContext,
    request: ActionRequest<Record<string, unknown>>,
  ): Promise<ReconcileResult>;
};

/**
 * Thrown by a change whose handler is not written yet. It is NotSent on purpose: nothing was contacted,
 * so the intent ends failed and never unknown, and nobody is asked to look for an effect that cannot
 * have happened.
 */
export class NotImplementedSend extends NotSent {
  override name = 'NotImplementedSend';
  constructor() {
    super('CONNECTOR_UNAVAILABLE', false);
  }
}

/** A read or reconcile whose handler is not written yet. */
export const notImplemented = (): never => {
  throw new Error('NOT_IMPLEMENTED');
};

/**
 * The connector's `suiteReads` and `actions` over a provider's handler maps. Each re-parses what it is
 * given against the tool's own schema, so a handler only ever sees a shape it was written for.
 */
export function createSuiteToolDispatch<TDeps>(input: {
  deps: TDeps;
  reads: Readonly<Record<string, SuiteReadHandler<TDeps>>>;
  actions: Readonly<Record<string, SuiteActionHandler<TDeps>>>;
}): { suiteReads: SuiteReadConnector; actions: ActionConnector } {
  const { deps, reads, actions } = input;
  const known = (id: string, version: string) =>
    Object.hasOwn(SUITE_TOOL_ARGS_SCHEMAS, id) && toolManifest(id)?.version === version;

  const actionFor = (request: ActionRequest, context: ConnectorContext) => {
    const handler = Object.hasOwn(actions, request.toolName)
      ? actions[request.toolName]
      : undefined;
    // Each fails the same way every time and contacts nobody, so none is retryable. A payload that no
    // longer fits its tool is the closest fixed code M3 has.
    if (!handler || !known(request.toolName, request.toolVersion)) {
      throw new NotSent('PAYLOAD_CHANGED', false);
    }
    const payload = parseSuiteActionPayload(
      request.toolName,
      context.connectionId,
      request.payload,
    );
    if (!payload) throw new NotSent('PAYLOAD_CHANGED', false);
    return { handler, request: { ...request, payload } };
  };

  return {
    suiteReads: {
      async read(context, tool, args, access) {
        const handler = Object.hasOwn(reads, tool.id) ? reads[tool.id] : undefined;
        if (!handler || !known(tool.id, tool.version)) throw new SuiteReadRefused('TOOL_UNKNOWN');
        const schema = (SUITE_TOOL_ARGS_SCHEMAS as Record<string, ZodType>)[tool.id];
        const parsed = schema?.safeParse(args);
        if (!parsed?.success) throw new SuiteReadRefused('TOOL_ARGS_INVALID');
        return handler(deps, context, parsed.data as Record<string, unknown>, access);
      },
    },
    actions: {
      async send(context, request) {
        const found = actionFor(request, context);
        return found.handler.send(deps, context, found.request);
      },
      async reconcile(context, request) {
        const found = actionFor(request, context);
        return found.handler.reconcile(deps, context, found.request);
      },
    },
  };
}
