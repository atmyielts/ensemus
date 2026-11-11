// Runtime contracts for connecting Google Workspace and Microsoft 365 by consent (ADR-038 D1-D3). The lists
// match @ensemus/domain/workspace-suites, and tests/unit/workspace-suites-contracts.test.ts keeps them the
// same. The routes' entries in docs/specifications/openapi.yaml arrive with the routes, because the spec
// may hold no operation without one.
import { z } from 'zod';

const uuid = z.uuid().toLowerCase();
const noControl = (value: string) => !/\p{Cc}/u.test(value);

export const suiteConnectorTypeSchema = z.enum(['google_workspace', 'microsoft_365']);
export const suiteCapabilitySchema = z.enum([
  'files',
  'directory',
  'mail',
  'calendar',
  'documents',
  'chat',
]);
export const oauthAuthorizationStatusSchema = z.enum([
  'pending',
  'code_received',
  'exchanging',
  'connected',
  'denied',
  'failed',
  'expired',
]);
export type OAuthAuthorizationStatusDto = z.infer<typeof oauthAuthorizationStatusSchema>;

/** A Microsoft directory: a GUID or a verified domain. It goes in a path, so it is held to this shape. */
export const microsoftTenantSchema = z
  .string()
  .regex(
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?!.*\.\.)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})$/i,
  );

/**
 * Whose app the consent goes through (ADR-038 D2). The operator's needs nothing from the admin. A
 * customer's own app's ID and secret are sealed on arrival, and never returned, logged or stored as sent.
 */
export const oauthClientChoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('platform') }),
  z.strictObject({
    kind: z.literal('customer'),
    client_id: z.string().trim().min(1).max(512).refine(noControl),
    client_secret: z.string().min(1).max(2048).refine(noControl),
    /** Microsoft only: the customer's own directory. Their app consents through it. */
    tenant: microsoftTenantSchema.optional(),
  }),
]);
export type OAuthClientChoice = z.infer<typeof oauthClientChoiceSchema>;

/**
 * Starting a consent. An admin chooses capabilities, never scopes: the server maps them (ADR-038 D3) and
 * shows both. The settings are checked against the connector's own, on the server, and never name a host.
 */
export const startOAuthAuthorizationSchema = z.strictObject({
  connector_type: suiteConnectorTypeSchema,
  display_name: z.string().trim().min(1).max(120).refine(noControl),
  config: z.record(z.string(), z.unknown()),
  capabilities: z.array(suiteCapabilitySchema).min(1).max(6),
  client: oauthClientChoiceSchema,
});
export type StartOAuthAuthorizationBody = z.infer<typeof startOAuthAuthorizationSchema>;

/**
 * A consent attempt as a person sees it. No state, no verifier, no code, no client secret and no
 * provider text: only what was asked for, where it got to, and a code from a fixed list if it stopped.
 */
export const oauthAuthorizationSchema = z.strictObject({
  id: uuid,
  connector_type: suiteConnectorTypeSchema,
  display_name: z.string(),
  client_kind: z.enum(['platform', 'customer']),
  capabilities: z.array(suiteCapabilitySchema),
  scopes: z.array(z.string()),
  status: oauthAuthorizationStatusSchema,
  error_code: z.string().nullable(),
  connection_id: uuid.nullable(),
  owner_membership_id: uuid.nullable(),
  started_by_membership_id: uuid,
  expires_at: z.iso.datetime({ offset: true }),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type OAuthAuthorizationDto = z.infer<typeof oauthAuthorizationSchema>;

/** What starting one answers: the attempt, and the provider's own page to send the admin's browser to. */
export const startedOAuthAuthorizationSchema = z.strictObject({
  authorization: oauthAuthorizationSchema,
  authorize_url: z.url({ protocol: /^https$/ }),
});
export type StartedOAuthAuthorizationDto = z.infer<typeof startedOAuthAuthorizationSchema>;

/**
 * The only query parameters the callback reads (ADR-038 D1). Providers send others, such as `scope`,
 * `session_state` or `iss`, which are dropped unread. Every one is bounded, and none is ever shown.
 */
export const oauthCallbackQuerySchema = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(4096).optional(),
  /** Mapped to a fixed code by deniedCodeFor in @ensemus/domain/workspace-suites, and never kept. */
  error: z.string().min(1).max(256).optional(),
  admin_consent: z.enum(['True', 'False', 'true', 'false']).optional(),
  tenant: microsoftTenantSchema.optional(),
});
export type OAuthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;
