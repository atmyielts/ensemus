// A suite read on the connector queue (ADR-038 D6, "D6 in detail"). Only IDs come in and only a status code
// goes out (ADR-024): the arguments and the output stay in PostgreSQL and in this worker's memory, and a
// provider's words reach no log, no error and no Temporal payload.
import {
  claimSuiteRead,
  finishSuiteRead,
  permittedSuiteResources,
  refuseSuiteRead,
  type PreparedSuiteRead,
} from '@ensemus/application/suite-reads';
import { isKnowledgeConnector } from '@ensemus/connectors/knowledge';
import {
  hasSuiteReads,
  SUITE_READ_REFUSALS,
  type SuiteResourceAccess,
} from '@ensemus/connectors/suites';
import { createServiceContext } from '@ensemus/database/service';
import { createLogger, errorCode } from '@ensemus/telemetry';
import { ApplicationFailure } from '@temporalio/common';
import { suiteReadInputSchema, type SuiteReadInput, type SuiteReadStatus } from './agent-schemas';
import type { ConnectorActivityDeps } from './connector-deps';

const log = createLogger('suite-read');

/** Well inside the Activity's two minutes, so a refusal is still written when a provider stalls. */
const READ_DEADLINE_MS = 60_000;

const REFUSALS: ReadonlySet<string> = new Set(SUITE_READ_REFUSALS);

/** A refusal's own code, or nothing. Never an error's message. */
function refusalCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== 'SuiteReadRefused') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && REFUSALS.has(code) ? code : 'SUITE_READ_REFUSED';
}

export function createSuiteReadActivities(deps: ConnectorActivityDeps) {
  /** The connector's context: this connection's credential on lease, and only the gateway as a way out. */
  const contextFor = (organizationId: string, read: PreparedSuiteRead, purpose: string) => {
    const secretId = read.connection.credentialSecretId;
    return {
      organizationId,
      connectionId: read.connection.id,
      grantedScopes: read.connection.grantedScopes,
      network: deps.network,
      signal: AbortSignal.timeout(READ_DEADLINE_MS),
      credentials: {
        withCredential: async <T>(use: (secret: Buffer) => Promise<T>): Promise<T> => {
          if (!secretId) throw new Error('CREDENTIAL_UNAVAILABLE');
          return deps.secrets.withSecret({ organizationId, secretId, purpose }, use);
        },
      },
    };
  };

  return {
    /**
     * Reloads the request by ID, checks ADR-038 D5 and D6's rule again, reads through the connector, and
     * keeps the output only after checking everything once more. Read-only at the provider, so a retry is
     * safe, and a request already answered is not read again.
     */
    async runSuiteRead(input: SuiteReadInput): Promise<SuiteReadStatus> {
      const { organizationId, runId, proposalId } = suiteReadInputSchema.parse(input);
      const context = createServiceContext(organizationId);
      const claim = await claimSuiteRead(deps.database, context, { runId, proposalId });
      if (claim.kind === 'gone') return 'gone';
      if (claim.kind === 'refused') return 'refused';
      const { read } = claim;
      const refuse = async (code: string) => {
        await refuseSuiteRead(deps.database, context, { runId, proposalId, code });
        return 'refused' as const;
      };

      const connector = deps.registry.get(read.connection.connectorType);
      if (!connector || !hasSuiteReads(connector)) return refuse('CONNECTOR_UNAVAILABLE');
      let config: unknown;
      try {
        config = connector.parseConfig(read.connection.config);
      } catch {
        return refuse('CONNECTION_CONFIG_INVALID');
      }
      if (connector.manifest.credential.required && !read.connection.credentialSecretId) {
        return refuse('CREDENTIAL_UNAVAILABLE');
      }
      const access: SuiteResourceAccess | null = read.checkEachResult
        ? {
            permitted: (externalIds) =>
              permittedSuiteResources(deps.database, context, {
                connectionId: read.connection.id,
                membershipId: read.initiatorMembershipId,
                externalIds,
                needed: read.resourceAccess ?? 'read',
              }),
          }
        : null;
      const connectorContext = {
        ...contextFor(organizationId, read, connector.manifest.credential.purpose),
        config,
        // From the rule just checked, so a handler classes a member's own content as theirs.
        ownerKind: read.ownerKind,
      };

      let output;
      try {
        output = await connector.suiteReads.read(
          connectorContext,
          { id: read.toolId, version: read.toolVersion },
          read.args,
          access,
        );
      } catch (error) {
        const refused = refusalCode(error);
        if (refused) return refuse(refused);
        // Anything else may be an outage, so the Activity tries again. Only a code is kept.
        const code = errorCode(error);
        log.warn('suite_read.failed', { errorCode: code });
        throw ApplicationFailure.create({ type: code, message: 'Suite read failed' });
      } finally {
        if (isKnowledgeConnector(connector)) {
          connector.disposeAuthSession?.(connectorContext.credentials);
        }
      }
      return finishSuiteRead(deps.database, context, {
        runId,
        proposalId,
        output: {
          bytes: output.bytes,
          mediaType: output.mediaType,
          classification: output.classification,
          resourceExternalIds: output.resourceExternalIds,
        },
      });
    },
  };
}

export type SuiteReadActivities = ReturnType<typeof createSuiteReadActivities>;
