import 'server-only';
// A member's own Google and Microsoft connections (ADR-038 D5), shared by the routes and the member's
// settings page, so a rule holds whichever way someone arrives. A member connects only through Ensemus's
// app, so nothing secret ever arrives here, and sees capabilities, never scopes.
import { getAuthorization } from '@ensemus/application';
import {
  listMemberConnections,
  listMyConnections,
  startMyConnection,
  type MemberConnectionView,
  type MyConnectionView,
} from '@ensemus/application/suite-settings';
import type { components } from '@ensemus/contracts/openapi';
import type { StartedOAuthAuthorizationDto } from '@ensemus/contracts/workspace-suites';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import {
  MEMBER_CONNECTABLE_CAPABILITIES,
  SUITE_CONNECTOR_TYPES,
} from '@ensemus/domain/workspace-suites';
import { z } from 'zod';
import { assertConnectorsEnabled } from './api';
import { oauthAuthorizationDto, oauthWebSide } from './oauth';

type MyConnectionDto = components['schemas']['MyConnection'];
type MemberConnectionDto = components['schemas']['MemberConnection'];

const memberCapabilitySchema = z.enum(MEMBER_CONNECTABLE_CAPABILITIES);

/** Starting a member's own consent. No client and no settings: those are the organization's to choose. */
export const startMyConnectionSchema = z.strictObject({
  connector_type: z.enum(SUITE_CONNECTOR_TYPES),
  display_name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => !/\p{Cc}/u.test(value)),
  capabilities: z.array(memberCapabilitySchema).min(1).max(4),
});
export type StartMyConnectionBody = z.infer<typeof startMyConnectionSchema>;

/** The whole list of what members may connect. Empty lets them connect nothing. */
export const memberConnectionCapabilitiesSchema = z.strictObject({
  capabilities: z
    .array(memberCapabilitySchema)
    .max(4)
    .refine((list) => new Set(list).size === list.length),
});

export function myConnectionDto(row: MyConnectionView): MyConnectionDto {
  return {
    id: row.id,
    connector_type: row.connectorType,
    display_name: row.displayName,
    state: row.state as MyConnectionDto['state'],
    capabilities: [...row.capabilities] as MyConnectionDto['capabilities'],
    created_at: row.createdAt.toISOString(),
  };
}

export function memberConnectionDto(row: MemberConnectionView): MemberConnectionDto {
  return {
    id: row.id,
    connector_type: row.connectorType,
    owner_membership_id: row.ownerMembershipId,
    owner_name: row.ownerName,
    state: row.state as MemberConnectionDto['state'],
    created_at: row.createdAt.toISOString(),
  };
}

export async function myConnectionDtos(database: AppDatabase, context: TenantContext) {
  return (await listMyConnections(database, context)).map(myConnectionDto);
}

export async function memberConnectionDtos(database: AppDatabase, context: TenantContext) {
  return (await listMemberConnections(database, context)).map(memberConnectionDto);
}

/**
 * Starts the signed-in member's own consent and answers where to send their browser, with the binding the
 * caller sets as the OAuth browser cookie, exactly as an admin's start does.
 */
export async function beginMyConnection(
  database: AppDatabase,
  context: TenantContext,
  body: StartMyConnectionBody,
): Promise<{ started: StartedOAuthAuthorizationDto; browserBinding: string }> {
  // So no attempt can wait for a worker that is not coming.
  assertConnectorsEnabled();
  const started = await startMyConnection(
    database,
    context,
    {
      connectorType: body.connector_type,
      displayName: body.display_name,
      capabilities: body.capabilities,
    },
    oauthWebSide(database, context),
  );
  const authorization = await getAuthorization(database, context, {
    authorizationId: started.authorizationId,
  });
  return {
    started: {
      authorization: oauthAuthorizationDto(authorization),
      authorize_url: started.authorizeUrl,
    },
    browserBinding: started.browserBinding,
  };
}
