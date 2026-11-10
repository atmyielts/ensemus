// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md. Runs in the connector worker,
// which holds the credential. It stages bytes and does not parse them: reading what a stranger wrote is the
// knowledge worker's, which holds no credential (ADR-029 D4).
import type { ConnectorActivityDeps } from './connector-deps';
import { recordConnectorContent } from '@ensemus/application/knowledge/ingest';
import { isKnowledgeConnector } from '@ensemus/connectors/knowledge';
import { connections, externalResources, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { MAX_DOCUMENT_BYTES } from '@ensemus/domain/knowledge';
import { eq } from 'drizzle-orm';

export type FetchInput = { organizationId: string; externalResourceId: string };
export type FetchOutcome = { outcome: 'staged' | 'unchanged' | 'gone' | 'failed'; bytes: number };

export function createKnowledgeConnectorActivities(deps: ConnectorActivityDeps) {
  return {
    async fetchConnectorContent(input: FetchInput): Promise<FetchOutcome> {
      const context = createServiceContext(input.organizationId);
      const loaded = await withTenantTx(deps.database, context, async (tx) => {
        const [resource] = await tx
          .select()
          .from(externalResources)
          .where(eq(externalResources.id, input.externalResourceId));
        if (!resource || resource.deletedAt || resource.aclState === 'unmapped') return null;
        const [connection] = await tx
          .select()
          .from(connections)
          .where(eq(connections.id, resource.connectionId));
        return connection?.state === 'active' ? { resource, connection } : null;
      });
      if (!loaded) return { outcome: 'gone', bytes: 0 };
      const connector = deps.registry.get(loaded.connection.connectorType);
      if (!connector || !isKnowledgeConnector(connector)) return { outcome: 'failed', bytes: 0 };
      try {
        const parsed: unknown = connector.parseConfig(loaded.connection.config);
        const secretId = loaded.connection.credentialSecretId;
        const content = await connector.content.readContent(
          {
            organizationId: context.organizationId,
            connectionId: loaded.connection.id,
            config: parsed,
            grantedScopes: loaded.connection.grantedScopes,
            network: deps.network,
            signal: AbortSignal.timeout(60_000),
            credentials: {
              withCredential: async (use) => {
                if (!secretId) throw new Error('CREDENTIAL_UNAVAILABLE');
                return deps.secrets.withSecret(
                  {
                    organizationId: context.organizationId,
                    secretId,
                    purpose: connector.manifest.credential.purpose,
                  },
                  use,
                );
              },
            },
          },
          {
            externalId: loaded.resource.externalId,
            resourceType: loaded.resource.resourceType,
            maxBytes: MAX_DOCUMENT_BYTES,
          },
        );
        if (content.bytes.length > MAX_DOCUMENT_BYTES) return { outcome: 'failed', bytes: 0 };
        const recorded = await recordConnectorContent(deps.database, context, {
          externalResourceId: loaded.resource.id,
          title: content.title,
          sourceVersion: content.sourceVersion,
          sourceUrl: content.sourceUrl,
          sourceModifiedAt: content.sourceModifiedAt,
          mediaType: content.mediaType,
          body: content.bytes,
        });
        return {
          outcome: recorded ? 'staged' : 'unchanged',
          bytes: recorded ? content.bytes.length : 0,
        };
      } catch {
        // Provider exceptions may quote a response or the credential. Only a fixed code is recorded.
        await withTenantTx(deps.database, context, (tx) =>
          tx
            .update(connections)
            .set({ lastErrorCode: 'CONNECTOR_READ_FAILED', lastErrorAt: new Date() })
            .where(eq(connections.id, loaded.connection.id)),
        );
        return { outcome: 'failed', bytes: 0 };
      }
    },
  };
}
export type KnowledgeConnectorActivities = ReturnType<typeof createKnowledgeConnectorActivities>;
