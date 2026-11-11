import { listSsoConnections, listScimTokens } from '@ensemus/application/sso';
import { getSecurityPolicy } from '@ensemus/application/security-policy';
import { canProduct } from '@ensemus/domain/product-policy';
import { BackLink, PageHead, formatDateTime } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { TokenForm } from '@/components/security-sso/token-form';
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
    'This metadata could not be used. Paste the complete SAML metadata file from your sign-in service, with a current signing certificate and a secure (https) sign-in address.',
  MFA_REQUIRED: 'Confirm your identity before changing company sign-in.',
  SSO_DOMAIN_NOT_VERIFIED:
    'Before this can be turned on, whoever set up Ensemus for your company needs to check your domain and sign-in service.',
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
      ? 'Connection saved. Next, whoever set up Ensemus for your company checks the domain and sign-in service, and then you can turn it on.'
      : query.notice === 'metadata'
        ? 'Metadata saved, and the connection is turned off. Changed settings need checking again by whoever set up Ensemus for your company.'
        : query.notice === 'revoked'
          ? 'Provisioning token revoked.'
          : query.notice === 'saved'
            ? 'Company sign-in settings saved.'
            : null;
  const origin = new URL(runtime.config.publicUrl).origin;
  return (
    <>
      <BackLink href={`/o/${organizationId}/security`}>Back to security</BackLink>
      <PageHead
        title="Company sign-in"
        description="Let people sign in through your company’s own sign-in service (an identity provider, using SAML), and take away their access when they leave."
      />
      {query.error && (
        <p className="notice error" role="alert">
          {errors[query.error] ?? errors.UNAVAILABLE}
        </p>
      )}
      {notice && (
        <p className="notice good" role="status">
          {notice}
        </p>
      )}
      <div className="stack">
        <section className="card" aria-labelledby="sso-requirement">
          <h2 id="sso-requirement">Who must use company sign-in</h2>
          <p>
            Owners always keep a password or authenticator app as a way back in. If no sign-in
            service is turned on, people can still sign in as before.
          </p>
          {canProduct(context.role, 'security_policy.manage') ? (
            <form
              className="fields gap-above"
              action={updateSecurityPolicyAction.bind(null, organizationId)}
            >
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
            <p className="muted gap-above-small">
              A company owner can change this requirement. It is currently{' '}
              {policy.ssoEnforcement === 'required' ? 'required' : 'optional'}.
            </p>
          )}
        </section>
        {rows.map((connection) => (
          <section
            key={connection.id}
            className="card stack"
            aria-labelledby={`connection-${connection.id}`}
          >
            <div className="spread">
              <div>
                <h2 id={`connection-${connection.id}`}>{connection.displayName}</h2>
                <p className="muted">{connection.domain}</p>
              </div>
              <span
                className={`badge ${connection.ready && connection.state === 'active' ? 'done' : 'attention'}`}
              >
                {!connection.ready
                  ? 'Waiting for a domain check'
                  : connection.state === 'active'
                    ? 'Active'
                    : 'Ready to activate'}
              </span>
            </div>
            {!connection.ready && (
              <p>
                Whoever set up Ensemus for your company checks this domain and the current sign-in
                service. Until then, the connection can’t be turned on. Domains can’t be claimed or
                verified on this page.
              </p>
            )}
            <details>
              <summary>Provider setup details</summary>
              <p className="muted gap-above-small">
                What your sign-in service asks for when you add Ensemus to it.
              </p>
              <div className="field-group gap-above">
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
                    Configuration fingerprint, for the domain check
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
              <label className="choice">
                <input type="checkbox" name="autoJoin" defaultChecked={connection.autoJoin} />
                <strong>Let people in this verified domain join as members</strong>
                <small>
                  New people join as members. The sign-in service can’t make anyone an administrator
                  or owner, and people who were removed can’t rejoin by signing in.
                </small>
              </label>
              <div>
                <SubmitButton working="Saving">Save connection</SubmitButton>
              </div>
            </form>
            <details>
              <summary>Replace provider metadata</summary>
              <p className="gap-above-small">
                This turns the connection off before changing its settings. Changed settings need
                checking again by whoever set up Ensemus for your company.
              </p>
              <form
                className="fields gap-above"
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
                  <SubmitButton className="secondary" working="Saving metadata">
                    Disable and replace metadata
                  </SubmitButton>
                </div>
              </form>
            </details>
            <div className="divided stack">
              <h3>Remove access through your sign-in service</h3>
              <p>
                Provisioning (SCIM) lets your sign-in service list people and turn their access off
                or back on. It can’t create people or change roles or groups.
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
              <ul className="list">
                {tokens
                  .filter((token) => token.connectionId === connection.id)
                  .map((token) => (
                    <li key={token.id}>
                      <div className="spread">
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
                            <SubmitButton className="danger" working="Revoking">
                              Revoke token
                            </SubmitButton>
                          </form>
                        )}
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          </section>
        ))}
        <section className="card" aria-labelledby="sso-add">
          <h2 id="sso-add">Add an identity provider</h2>
          <p>
            Paste the SAML metadata file your sign-in service gives you. Ensemus doesn’t download it
            or contact any server you name.
          </p>
          <form
            className="fields gap-above"
            action={createSsoConnectionAction.bind(null, organizationId)}
          >
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
              Before it can be turned on, whoever set up Ensemus for your company checks that you
              own the domain and that the sign-in service is current.
            </p>
            <div>
              <SubmitButton working="Saving connection">Save connection for review</SubmitButton>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}
