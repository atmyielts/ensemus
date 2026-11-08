import { and, eq, sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { memberships, sessions, organizations } from './schema';
import { webhookEndpoints } from './schema-integrations';
import {
  interactiveIdentity,
  isVerifiedInteractiveIdentity,
  type VerifiedInteractiveIdentity,
} from './interactive-identity';
import { billingAccounts } from './schema-saas';

const brand: unique symbol = Symbol('TenantContext');

/**
 * How far this person's tenant is being served (ADR-032 D5). Anything but `full` makes withTenantTx a
 * read-only transaction, so a write is refused by PostgreSQL itself even where a check was forgotten.
 */
export type TenantServing = 'full' | 'read_only' | 'suspended' | 'offboarding';

/** Proof that a user's active membership was checked. Only this module can create one. */
export type TenantContext = Readonly<{
  organizationId: string;
  userId: string;
  membershipId: string;
  role: string;
  actorType: 'user' | 'service' | 'agent' | 'delegated';
  /** Which run this is acting for. Set only on an agent's context. */
  agentRunId?: string;
  /** An opaque native-verifier handoff. JSON/Temporal cannot carry this symbol; no worker mints it. */
  [interactiveIdentity]?: VerifiedInteractiveIdentity;
  /** Missing means full for a worker acting on a prior durable intent. */
  serving?: TenantServing;
  [brand]: true;
}>;

/**
 * An agent acting with its initiator's authority, and no more (ADR-028 FD-3). Every Work Unit check runs
 * against the initiator's membership, because only a service context skips them.
 */
export type AgentContext = TenantContext & { actorType: 'agent'; agentRunId: string };

/** How audit rows and events name who acted. An agent is named as itself, with its run as the ID. */
export function actorOf(context: TenantContext): {
  actorType: 'user' | 'service' | 'agent';
  actorId?: string;
} {
  if (context.actorType === 'service') return { actorType: 'service' };
  if (context.actorType === 'delegated')
    return { actorType: 'agent', actorId: context.membershipId };
  if (context.actorType === 'agent') {
    return { actorType: 'agent', ...(context.agentRunId ? { actorId: context.agentRunId } : {}) };
  }
  return { actorType: 'user', actorId: context.membershipId };
}

/**
 * A worker acting for a tenant, with no person behind the transaction. Only workers may import
 * this (`@ensemus/database/service`, enforced by lint). The organization ID comes from the outbox
 * event, not from any model or request, and RLS still confines every query to that tenant.
 */
export function createServiceContext(organizationId: string): TenantContext {
  if (!UUID.test(organizationId)) throw new TenantAccessDenied();
  return {
    // One spelling, because it ends up in object keys and lock names, where case makes a difference.
    organizationId: organizationId.toLowerCase(),
    userId: '',
    membershipId: '',
    role: 'service',
    actorType: 'service',
    [brand]: true,
  };
}

export type Tx = Parameters<Parameters<EnsemusDrizzle['transaction']>[0]>[0];

/** The application handle. Queries only run through the helpers below, which bind context first. */
export class AppDatabase {
  readonly #db: EnsemusDrizzle;
  constructor(db: EnsemusDrizzle) {
    this.#db = db;
  }
  /** Runs with nothing bound, so RLS returns no tenant rows. Exists to test exactly that. */
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.transaction({}, fn);
  }
  transaction<T>(bindings: Record<string, string>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => {
      // set_config because SET LOCAL cannot take a bind parameter (ADR-024 D4).
      for (const [name, value] of Object.entries({
        'app.agent_input_protocol': '',
        'app.agent_scope_protocol': '',
        'app.outcome_draft_id': '',
        'app.portability_export_id': '',
        'app.portability_import_id': '',
        'app.portability_part_path': '',
        'app.portability_part_sha256': '',
        'app.interactive_session_id': '',
        'app.knowledge_model_protocol': '',
        'app.model_job_id': '',
        'objects.soft_delete_record_id': '',
        'app.process_start_run_id': '',
        'app.process_start_spec_id': '',
        'app.process_step_run_id': '',
        'app.process_step_key': '',
        'app.payment_customer_hash': '',
        'lifecycle.erasure_count_org': '',
        ...bindings,
      })) {
        await tx.execute(sql`select set_config(${name}, ${value}, true)`);
      }
      return fn(tx);
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TenantAccessDenied extends Error {
  override name = 'TenantAccessDenied';
  constructor() {
    // Same message whether the organization is missing or forbidden, so IDs cannot be probed.
    super('Not found or not permitted');
  }
}

function assertUuid(value: string) {
  if (!UUID.test(value)) throw new TenantAccessDenied();
}

export function openAppDatabase(url: string, options: { max?: number } = {}) {
  const { db, close } = openDatabase(url, options);
  return { db: new AppDatabase(db), close };
}

/** Binds only the user: their own memberships and organizations are visible, tenant data is not. */
export function withUserTx<T>(
  database: AppDatabase,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(userId);
  return database.transaction({ 'app.user_id': userId }, fn);
}

function tenantBindings(context: TenantContext): Record<string, string> {
  return {
    'app.organization_id': context.organizationId,
    'app.user_id': context.userId,
    'app.membership_id': context.membershipId,
    'app.actor_type': context.actorType,
    'app.agent_run_id': context.actorType === 'agent' ? (context.agentRunId ?? '') : '',
    'app.agent_input_protocol': context.actorType === 'agent' ? 'v1' : '',
    'app.interactive_session_id': interactiveSessionOf(context)?.sessionId ?? '',
  };
}

/** Binds one tenant. Keep it short: never span rendering or a model call. */
export async function withTenantTx<T>(
  database: AppDatabase,
  context: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (context[brand] !== true) throw new TenantAccessDenied();
  return database.transaction(
    tenantBindings(context),
    async (tx) => {
      if (context.serving && context.serving !== 'full') await tx.execute(sql`set transaction read only`);
      return fn(tx);
    },
  );
}

/** Billing, support, export and leaving stay available in restricted standing (ADR-032 D5). */
export async function withAccountTx<T>(database: AppDatabase, context: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (context[brand] !== true) throw new TenantAccessDenied();
  return database.transaction(
    tenantBindings(context),
    fn,
  );
}

/**
 * The same person, allowed to write, for one service another milestone wrote with withTenantTx that still has
 * to work in any standing. That is M6's export, today (ADR-032 D5). Lint keeps it where withAccountTx is.
 */
export function accountContextOf(context: TenantContext): TenantContext {
  if (context[brand] !== true) throw new TenantAccessDenied();
  return { ...context, serving: 'full' };
}

/**
 * A processor's event names a customer, and this binds only the hash of that reference, which reveals
 * that one billing account, and from its row binds the tenant, so nothing about the tenant comes from the
 * event (ADR-032 D4). Answers null, without calling `fn`, when nobody has that reference. Worker-only:
 * `@ensemus/database/payment-routing`, and lint blocks the web tier.
 */
export function withPaymentCustomerTx<T>(
  database: AppDatabase,
  customerRefHash: string,
  fn: (
    tx: Tx,
    scope: { account: typeof billingAccounts.$inferSelect; context: TenantContext },
  ) => Promise<T>,
): Promise<T | null> {
  return database.transaction({ 'app.payment_customer_hash': customerRefHash }, async (tx) => {
    const [account] = await tx
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.customerRefHash, customerRefHash));
    if (!account) return null;
    await tx.execute(
      sql`select set_config('app.organization_id', ${account.organizationId}, true),
        set_config('app.user_id','',true),set_config('app.membership_id','',true),
        set_config('app.actor_type','service',true),set_config('app.agent_run_id','',true)`,
    );
    return fn(tx, { account, context: createServiceContext(account.organizationId) });
  });
}

/** Binds a brand-new tenant, so row-level policies apply to its first inserts like any other. */
export function withNewTenantTx<T>(
  database: AppDatabase,
  organizationId: string,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(organizationId);
  assertUuid(userId);
  return database.transaction({ 'app.organization_id': organizationId, 'app.user_id': userId }, fn);
}

/** Binds only the hash of an invitation token, which reveals that one invitation and nothing else. */
export function withInvitationTx<T>(
  database: AppDatabase,
  tokenHash: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return database.transaction({ 'app.invitation_token_hash': tokenHash }, fn);
}

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;

/**
 * A public callback (ADR-024 D4, ADR-027 D4). Binds only the hash of the token in the URL, which reveals
 * that one endpoint, and from its row binds the tenant, so nothing about the tenant comes from the
 * request. Hands `fn` a context with no person behind it. Answers null, without calling `fn`, when no
 * active endpoint has that hash. This is the only way the web tier gets a context with no session.
 */
export function withWebhookEndpointTx<T>(
  database: AppDatabase,
  tokenHash: string,
  fn: (tx: Tx, scope: { endpoint: WebhookEndpointRow; context: TenantContext }) => Promise<T>,
): Promise<T | null> {
  return database.transaction({ 'app.webhook_token_hash': tokenHash }, async (tx) => {
    const [endpoint] = await tx
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.tokenHash, tokenHash), eq(webhookEndpoints.state, 'active')));
    if (!endpoint) return null;
    await tx.execute(
      sql`select set_config('app.organization_id', ${endpoint.organizationId}, true),
        set_config('app.user_id', '', true), set_config('app.membership_id', '', true),
        set_config('app.actor_type', 'service', true), set_config('app.agent_run_id', '', true),
        set_config('app.agent_input_protocol', '', true), set_config('app.interactive_session_id','',true),
        set_config('app.agent_scope_protocol','',true),
        set_config('app.outcome_draft_id','',true),
        set_config('app.portability_export_id','',true),set_config('app.portability_import_id','',true),
        set_config('app.portability_part_path','',true),set_config('app.portability_part_sha256','',true),
        set_config('app.knowledge_model_protocol','',true), set_config('app.model_job_id','',true)`,
    );
    return fn(tx, { endpoint, context: createServiceContext(endpoint.organizationId) });
  });
}

/**
 * Checks an active membership and returns the context needed to reach that tenant's data. The ID in
 * the context is the one the row holds, never the one that was asked for: a UUID column matches any
 * case, but object keys and lock names are text, so a request in capitals would otherwise reach the
 * same data while looking in a different place for what protects it.
 */
export async function resolveTenantContext(
  database: AppDatabase,
  userId: string,
  organizationId: string,
): Promise<TenantContext> {
  assertUuid(organizationId);
  const [membership] = await withUserTx(database, userId, (tx) =>
    tx
      .select({
        id: memberships.id,
        role: memberships.role,
        organizationId: memberships.organizationId,
        lifecycle: organizations.lifecycle,
      })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      ),
  );
  // A tenant that has gone is the same as one that never existed.
  if (!membership || membership.lifecycle === 'deleted') throw new TenantAccessDenied();
  return {
    organizationId: membership.organizationId,
    userId,
    membershipId: membership.id,
    role: membership.role,
    actorType: 'user',
    serving: membership.lifecycle === 'active' ? 'full' : (membership.lifecycle as TenantServing),
    [brand]: true,
  };
}

/** A readable ID is not a native verified session. Only auth's in-process handoff can bind one. */
export function interactiveSessionOf(context: TenantContext): VerifiedInteractiveIdentity | null {
  const identity = context[interactiveIdentity];
  return context.actorType === 'user' &&
    isVerifiedInteractiveIdentity(identity) &&
    identity.userId === context.userId
    ? identity
    : null;
}

/** Called by HTTP/page boundaries with the result of native getSession, never with form IDs. */
export async function resolveInteractiveTenantContext(
  database: AppDatabase,
  identity: VerifiedInteractiveIdentity,
  organizationId: string,
): Promise<TenantContext> {
  if (!isVerifiedInteractiveIdentity(identity)) throw new TenantAccessDenied();
  const live = await withUserTx(database, identity.userId, async (tx) => {
    const [session] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, identity.sessionId),
          eq(sessions.userId, identity.userId),
          sql`${sessions.expiresAt}>clock_timestamp()`,
        ),
      );
    return !!session;
  });
  if (!live) throw new TenantAccessDenied();
  const context = await resolveTenantContext(database, identity.userId, organizationId);
  return { ...context, [interactiveIdentity]: identity };
}

/**
 * For a worker's agent process only (`@ensemus/database/agent`, enforced by lint). Reads the initiator's
 * membership now, so a disabled or removed initiator stops the run at its next step (04-security/04 §6).
 * Call it again for every model turn and tool call rather than keeping the result. Throws
 * TenantAccessDenied when the membership is not active.
 */
export async function createAgentContext(
  database: AppDatabase,
  input: { organizationId: string; initiatorMembershipId: string; agentRunId: string },
): Promise<AgentContext> {
  assertUuid(input.organizationId);
  assertUuid(input.initiatorMembershipId);
  assertUuid(input.agentRunId);
  const [membership] = await database.transaction(
    { 'app.organization_id': input.organizationId },
    (tx) =>
      tx
        .select({
          id: memberships.id,
          role: memberships.role,
          userId: memberships.userId,
          organizationId: memberships.organizationId,
        })
        .from(memberships)
        .where(
          and(eq(memberships.id, input.initiatorMembershipId), eq(memberships.status, 'active')),
        ),
  );
  if (!membership) throw new TenantAccessDenied();
  return {
    organizationId: membership.organizationId,
    userId: membership.userId,
    membershipId: membership.id,
    role: membership.role,
    actorType: 'agent',
    agentRunId: input.agentRunId.toLowerCase(),
    [brand]: true,
  };
}

/**
 * Binds one tenant with no person and no context, to find a queued run and read kill switches before
 * any initiator is known. It hands back only the transaction: no service code can be called with it,
 * because every application service takes a context. Same import rule as above.
 */
export function withRunLookupTx<T>(
  database: AppDatabase,
  organizationId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertUuid(organizationId);
  return database.transaction({ 'app.organization_id': organizationId.toLowerCase() }, fn);
}

/** Confirms the database answers. Reads no tenant data. */
export async function pingDatabase(database: AppDatabase): Promise<void> {
  await database.run((tx) => tx.execute(sql`select 1`));
}

/** Worker acting for a named person, with that person's fresh membership and source ACL. */
export async function createDelegatedContext(
  database: AppDatabase,
  organizationId: string,
  membershipId: string,
): Promise<TenantContext> {
  assertUuid(membershipId);
  const service = createServiceContext(organizationId);
  const [membership] = await withTenantTx(database, service, (tx) =>
    tx
      .select({
        id: memberships.id,
        role: memberships.role,
        userId: memberships.userId,
        organizationId: memberships.organizationId,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, service.organizationId),
          eq(memberships.id, membershipId),
          eq(memberships.status, 'active'),
        ),
      ),
  );
  if (!membership) throw new TenantAccessDenied();
  return {
    organizationId: membership.organizationId,
    userId: membership.userId,
    membershipId: membership.id,
    role: membership.role,
    actorType: 'delegated',
    [brand]: true,
  };
}
