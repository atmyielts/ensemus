import Link from 'next/link';
import { listSsoConnections, listScimTokens } from '@ensemus/application/sso';
import { getSecurityPolicy } from '@ensemus/application/security-policy';
import { canProduct } from '@ensemus/domain/product-policy';
import { PageHead, formatDateTime } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { TokenForm } from '@/components/security-sso/token-form';
import styles from '@/components/security/security.module.css';
import {
  createSsoConnectionAction,
  issueScimTokenAction,
  updateSsoConnectionAction,
  replaceSsoMetadataAction,
  revokeScimTokenAction,
} from '@/server/sso-actions';
import { updateSecurityPolicyAction } from '@/server/security-actions';
import { requireTenant, orNotFound } from '@/server/tenant';
import { getRuntime } from '@/server/runtime';
export const metadata = { title: 'Company sign-in | Ensemus' };
const errors: Record<string, string> = {
  METADATA:
    'This metadata could not be used. Paste one complete SAML identity provider descriptor with a current signing certificate and secure sign-in address.',
  MFA_REQUIRED: 'Confirm your identity before changing company sign-in.',
  SSO_DOMAIN_NOT_VERIFIED:
    'The current provider configuration needs the installation operator’s domain review before activation.',
  VERSION_CONFLICT: 'These settings changed. Refresh the page before saving again.',
  INVALID_INPUT: 'Check the company sign-in fields and try again.',
  UNAVAILABLE: 'Company sign-in could not be updated. Refresh the page before trying again.',
};
export default async function SsoSettings({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireTenant(organizationId),
    query = await searchParams;
  const connections = await orNotFound(listSsoConnections(database, context)),
    tokens = await listScimTokens(database, context),
    policy = await getSecurityPolicy(database, context),
    runtime = getRuntime();
  const rows = await Promise.all(
    connections.map(async (connection) => {
      const status = await runtime.sso.status(connection.providerId);
      return {
        ...connection,
        ready: connection.domainState === 'verified' && status.ready,
        configurationSha256: status.configurationSha256,
      };
    }),
  );
  const notice =
    query.notice === 'created'
      ? 'Connection saved. Ask your installation operator to review the domain and provider before activation.'
      : query.notice === 'metadata'
        ? 'Metadata saved and connection disabled. Changed provider settings need the installation operator’s review.'
        : query.notice === 'revoked'
          ? 'Provisioning token revoked.'
          : query.notice === 'saved'
            ? 'Company sign-in settings saved.'
            : null;
  const origin = new URL(runtime.config.publicUrl).origin;
  return (
    <>
      <PageHead
        title="Company sign-in"
        description="Connect your company’s identity provider and remove company access when someone leaves."
        actions={
          <Link className="button quiet" href={`/o/${organizationId}/security`}>
            Security settings
          </Link>
        }
      />
      {query.error && (
        <p className="notice error" role="alert">
          {errors[query.error] ?? errors.UNAVAILABLE}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <section className={styles.section}>
        <h2>Who must use company sign-in</h2>
        <p>
          Owners keep a password or authenticator recovery path. A company without an active
          provider stays accessible.
        </p>
        {canProduct(context.role, 'security_policy.manage') ? (
          <form className="fields" action={updateSecurityPolicyAction.bind(null, organizationId)}>
            <input type="hidden" name="version" value={policy.version} />
            <input
              type="hidden"
              name="mfaForAdministration"
              value={policy.mfaForAdministration ? 'on' : ''}
            />
            <input type="hidden" name="mfaMaxAgeSeconds" value={policy.mfaMaxAgeSeconds} />
            <label>
              Company sign-in requirement
              <select name="ssoEnforcement" defaultValue={policy.ssoEnforcement}>
                <option value="optional">Optional</option>
                <option value="required">Required for members and administrators</option>
              </select>
            </label>
            <div>
              <SubmitButton working="Saving">Save sign-in requirement</SubmitButton>
            </div>
          </form>
        ) : (
          <p className="muted">
            A company owner can change this requirement. It is currently{' '}
            {policy.ssoEnforcement === 'required' ? 'required' : 'optional'}.
          </p>
        )}
      </section>
      {rows.map((connection) => (
        <section
          key={connection.id}
          className={styles.section}
          aria-labelledby={`connection-${connection.id}`}
        >
          <div className="row spread">
            <div>
              <h2 id={`connection-${connection.id}`}>{connection.displayName}</h2>
              <p>{connection.domain}</p>
            </div>
            <span
              className={`badge ${connection.ready && connection.state === 'active' ? 'done' : 'attention'}`}
            >
              {!connection.ready
                ? 'Needs operator review'
                : connection.state === 'active'
                  ? 'Active'
                  : 'Ready to activate'}
            </span>
          </div>
          {!connection.ready && (
            <p>
              Ask your installation operator to verify this domain after checking the current
              provider. Activation stays unavailable until that review is complete. You cannot claim
              or verify a domain here.
            </p>
          )}
          <details>
            <summary>Provider setup details</summary>
            <div className="fields">
              <label>
                Service provider entity ID
                <input
                  readOnly
                  value={
                    new URL(
                      `/api/auth/sso/saml2/sp/metadata?providerId=${connection.providerId}`,
                      origin,
                    ).href
                  }
                />
              </label>
              <label>
                Assertion consumer address
                <input
                  readOnly
                  value={
                    new URL(`/api/auth/sso/saml2/sp/acs/${connection.providerId}`, origin).href
                  }
                />
              </label>
              <label>
                Connection reference
                <input readOnly value={connection.providerId} />
              </label>
              {connection.configurationSha256 && (
                <label>
                  Configuration fingerprint for operator review
                  <input readOnly value={connection.configurationSha256} />
                </label>
              )}
              <p className="link-line">
                <a href={`/api/auth/sso/saml2/sp/metadata?providerId=${connection.providerId}`}>
                  Open service provider metadata
                </a>
              </p>
            </div>
          </details>
          <form
            className="fields"
            action={updateSsoConnectionAction.bind(null, organizationId, connection.id)}
          >
            <input type="hidden" name="version" value={connection.version} />
            <label>
              Connection name
              <input
                name="displayName"
                required
                maxLength={120}
                defaultValue={connection.displayName}
              />
            </label>
            <label>
              Connection status
              <select
                name="state"
                defaultValue={
                  connection.state === 'active' && connection.ready ? 'active' : 'disabled'
                }
              >
                <option value="disabled">Disabled</option>
                <option value="active" disabled={!connection.ready}>
                  Active
                </option>
              </select>
            </label>
            <label className={styles.check}>
              <input type="checkbox" name="autoJoin" defaultChecked={connection.autoJoin} />
              Let people in this verified domain join as members
            </label>
            <p className="muted">
              New people receive the member role. Provider claims cannot make an administrator or
              owner. Removed people cannot rejoin by signing in.
            </p>
            <div>
              <SubmitButton working="Saving">Save connection</SubmitButton>
            </div>
          </form>
          <details>
            <summary>Replace provider metadata</summary>
            <p>
              This disables the connection before changing its settings. Changed authentication
              settings need the installation operator’s review again.
            </p>
            <form
              className="fields"
              action={replaceSsoMetadataAction.bind(null, organizationId, connection.id)}
            >
              <input type="hidden" name="version" value={connection.version} />
              <label>
                New identity provider metadata (XML)
                <textarea
                  name="metadata"
                  rows={7}
                  maxLength={200000}
                  required
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div>
                <SubmitButton working="Saving metadata">Disable and replace metadata</SubmitButton>
              </div>
            </form>
          </details>
          <h3>Remove access through your provider</h3>
          <p>
            Provisioning supports listing people and turning their company access off or back on.
            Creating people, changing roles and groups are unavailable.
          </p>
          <label>
            Provisioning base address
            <input readOnly value={new URL('/api/scim/v2', origin).href} />
          </label>
          {connection.ready && connection.state === 'active' ? (
            <TokenForm
              issueAction={issueScimTokenAction.bind(null, organizationId, connection.id)}
            />
          ) : (
            <p className="muted">
              Activate the reviewed connection before creating a provisioning token.
            </p>
          )}
          <ul>
            {tokens
              .filter((token) => token.connectionId === connection.id)
              .map((token) => (
                <li key={token.id}>
                  <div className="row spread">
                    <div>
                      Token created {formatDateTime(token.createdAt)} ·{' '}
                      {token.state === 'active' ? 'Active' : 'Revoked'}
                      {token.lastUsedAt && (
                        <span className="muted">
                          {' '}
                          · Last used {formatDateTime(token.lastUsedAt)}
                        </span>
                      )}
                    </div>
                    {token.state === 'active' && (
                      <form action={revokeScimTokenAction.bind(null, organizationId, token.id)}>
                        <SubmitButton working="Revoking">Revoke token</SubmitButton>
                      </form>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ))}
      <section className={styles.section}>
        <h2>Add an identity provider</h2>
        <p>
          Use SAML metadata supplied by your provider. Paste the file here; Ensemus does not
          download metadata or contact a tenant-configured server.
        </p>
        <form className="fields" action={createSsoConnectionAction.bind(null, organizationId)}>
          <label>
            Connection name
            <input name="displayName" maxLength={120} required placeholder="Company sign-in" />
          </label>
          <label>
            Company email domain
            <input
              name="domain"
              required
              maxLength={253}
              autoCapitalize="none"
              placeholder="example.com"
            />
          </label>
          <label>
            Identity provider metadata (XML)
            <textarea
              name="metadata"
              rows={7}
              maxLength={200000}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p className="muted">
            Your installation operator must check domain ownership and the current provider before
            this connection can be activated.
          </p>
          <div>
            <SubmitButton working="Saving connection">Save connection for review</SubmitButton>
          </div>
        </form>
      </section>
    </>
  );
}
