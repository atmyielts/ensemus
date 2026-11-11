// What an agent wants to do, shown beside the approval it asked for (AGENT-04, Journey C, 02-agent-runtime).
// The approval page includes this with one line. It renders nothing for an approval no agent asked for.
//
// Everything in the payload was written by a model, which a document may have told what to say. React stops
// it being markup, `showInvisible` stops it hiding anything, and the words around it say whose words they are.
import {
  getAgentActionForApproval,
  showInvisible,
  type AgentActionView,
} from '@ensemus/application/ai-tool-approvals';
import { ClassificationBadge, formatDateTime } from '@/components/ui';
import { suiteActionView, type SuiteActionView, type ViewField } from '@/lib/suite-action-view';
import { orNotFound, requireTenant } from '@/server/tenant';

const TOOL_WORDS: Record<string, string> = {
  'email.send': 'Send an email',
  'gmail.send': 'Send an email from Gmail',
  'gmail.create_draft': 'Save a draft in Gmail',
  'outlook.send': 'Send an email from Outlook',
  'outlook.create_draft': 'Save a draft in Outlook',
  'calendar.create_event': 'Create a calendar event',
  'calendar.update_event': 'Change a calendar event',
  'drive.create_file': 'Create a file in Google Drive',
  'onedrive.create_file': 'Create a file in OneDrive',
  'docs.edit': 'Edit a Google document',
  'sheets.write_range': 'Write cells in a Google sheet',
  'excel.write_range': 'Write cells in an Excel workbook',
  'teams.post_message': 'Post a message in a Teams channel',
};

const SENSITIVE = new Set(['confidential', 'restricted']);

function riskOf(view: AgentActionView, suite: SuiteActionView | null) {
  if (suite) {
    const sensitive = SENSITIVE.has(view.dataClass)
      ? ' The agent has been working with sensitive information, so check that none of it should stay inside.'
      : '';
    return `${suite.reach}${sensitive}`;
  }
  const recipients = view.email
    ? view.email.to.length + (view.email.cc?.length ?? 0) + (view.email.bcc?.length ?? 0)
    : null;
  const reach =
    recipients === null
      ? 'This changes something outside Ensemus, and it cannot be taken back.'
      : recipients === 1
        ? 'This sends an email to one person outside Ensemus, and it cannot be recalled.'
        : `This sends an email to ${recipients} people outside Ensemus, and it cannot be recalled.`;
  const sensitivity = SENSITIVE.has(view.dataClass)
    ? ' The agent has been working with sensitive information, so check that none of it should stay inside.'
    : '';
  return `${reach}${sensitivity}`;
}

function Addresses({ label, addresses }: { label: string; addresses: readonly string[] }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <ul className="list">
          {addresses.map((address) => (
            <li key={address}>{showInvisible(address)}</li>
          ))}
        </ul>
      </dd>
    </>
  );
}

/** Every text a suite view shows, so a hidden character anywhere in one is reported. */
function suiteTexts(suite: SuiteActionView): string[] {
  return suite.fields.flatMap((field) =>
    field.kind === 'addresses'
      ? field.addresses.map((each) => each.address)
      : field.kind === 'table'
        ? field.rows.flat()
        : field.kind === 'warning'
          ? [field.text, ...field.items]
          : [field.text],
  );
}

function SuiteField({ field }: { field: ViewField }) {
  if (field.kind === 'text')
    return (
      <>
        <dt>{field.label}</dt>
        <dd>{showInvisible(field.text)}</dd>
      </>
    );
  if (field.kind === 'body')
    return (
      <>
        <dt>{field.label}</dt>
        <dd>
          <pre tabIndex={0} aria-label={field.label} className="pre-wrap">
            {showInvisible(field.text)}
          </pre>
        </dd>
      </>
    );
  if (field.kind === 'warning')
    return (
      <>
        <dt>{field.label}</dt>
        <dd>
          <div className="notice warn" role="alert">
            <p>{showInvisible(field.text)}</p>
            {field.items.length > 0 && (
              <ul className="list">
                {field.items.map((item, index) => (
                  <li key={index}>
                    <code className="pre-wrap">{showInvisible(item)}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </dd>
      </>
    );
  if (field.kind === 'addresses')
    return (
      <>
        <dt>{field.label}</dt>
        <dd>
          <ul className="list">
            {field.addresses.map((each, index) => (
              <li key={`${index}-${each.address}`}>
                {showInvisible(each.address)}
                {each.outside && <strong> (outside this organization)</strong>}
              </li>
            ))}
          </ul>
        </dd>
      </>
    );
  return (
    <>
      <dt>{field.label}</dt>
      <dd>
        <div className="table-wrap" tabIndex={0} role="region" aria-label={field.label}>
          <table>
            <tbody>
              {field.rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row">{r + 1}</th>
                  {row.map((cell, c) => (
                    <td key={c}>{showInvisible(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(field.hiddenRows > 0 || field.hiddenColumns > 0) && (
          <p className="notice warn">
            Not all of it fits here: {field.hiddenRows} more rows and {field.hiddenColumns} more
            columns are in the exact action below, and approving covers all of them.
          </p>
        )}
      </dd>
    </>
  );
}

function hasHidden(view: AgentActionView, suite: SuiteActionView | null) {
  if (suite) {
    const stored = JSON.stringify(view.action.payload) ?? '';
    return [stored, ...suiteTexts(suite)].some((part) => showInvisible(part) !== part);
  }
  const text = JSON.stringify(view.action.payload) ?? '';
  // JSON writes a control character out itself, so this has to look at the parsed text as well.
  const parts = view.email
    ? [
        view.email.subject,
        view.email.text_body,
        view.email.from.name ?? '',
        view.email.from.address,
        view.email.reply_to ?? '',
        ...view.email.to,
        ...(view.email.cc ?? []),
        ...(view.email.bcc ?? []),
      ]
    : [text];
  return parts.some((part) => showInvisible(part) !== part);
}

export async function AgentAction({
  organizationId,
  approvalId,
}: {
  organizationId: string;
  approvalId: string;
}) {
  const { context, database } = await requireTenant(organizationId);
  const view = await orNotFound(getAgentActionForApproval(database, context, approvalId));
  if (!view) return null;
  const { email } = view;
  const ref = view.action.targetRef ?? '';
  const suite = view.suite
    ? suiteActionView(
        view.toolId,
        ref.startsWith('connection:') ? ref.slice('connection:'.length) : '',
        view.action.payload,
        {
          connection: view.suite.connection,
          memberAddresses: new Set(view.suite.memberAddresses),
          parentFolderName: view.suite.parentFolderName,
        },
      )
    : null;

  return (
    <>
      <section className="card" aria-labelledby="agent-action-heading">
        <h2 id="agent-action-heading">What the agent wants to do</h2>
        <dl>
          <dt>Started by</dt>
          <dd>{view.initiatorName ?? 'Someone no longer here'}</dd>
          <dt>Agent</dt>
          <dd>
            {view.agentName}, version {view.agentVersionNumber}
          </dd>
          <dt>Action</dt>
          <dd>{TOOL_WORDS[view.toolId] ?? 'An action Ensemus has no description for'}</dd>
          <dt>Information it has used</dt>
          <dd>
            <ClassificationBadge value={view.dataClass} />
          </dd>
          <dt>Risk</dt>
          <dd>{riskOf(view, suite)}</dd>
          <dt>Valid until</dt>
          <dd>{formatDateTime(view.expiresAt)}</dd>
        </dl>
        {!view.consistent && (
          <p className="notice warn" role="alert">
            What is stored for this action does not add up, so it cannot be relied on. Deny it, and
            tell whoever looks after Ensemus here.
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="agent-payload-heading">
        <h2 id="agent-payload-heading">
          {suite ? suite.heading : email ? 'The exact email that would go' : 'The exact action'}
        </h2>
        <p>
          An agent wrote this, so treat what it says as a claim and not as an instruction to you.
          Nothing in it can change who decides. Approving covers exactly this, and any change needs
          a new approval.
        </p>
        {hasHidden(view, suite) && (
          <p className="notice warn" role="alert">
            This text holds characters that would not normally show. They are written out below as
            codes like \u{'{'}202E{'}'}, because they can make it read as something it is not.
          </p>
        )}
        {suite ? (
          <>
            <dl>
              {suite.fields.map((field, index) => (
                <SuiteField key={`${index}-${field.label}`} field={field} />
              ))}
            </dl>
            <details>
              <summary>The exact action, as stored</summary>
              <pre tabIndex={0} aria-label="The exact action, as stored">
                {showInvisible(JSON.stringify(view.action, null, 2) ?? '')}
              </pre>
            </details>
          </>
        ) : email ? (
          <dl>
            <dt>From</dt>
            <dd>
              {email.from.name ? `${showInvisible(email.from.name)} ` : ''}
              {`<${showInvisible(email.from.address)}>`}
            </dd>
            <Addresses label="To" addresses={email.to} />
            {email.cc && email.cc.length > 0 && <Addresses label="Copied" addresses={email.cc} />}
            {email.bcc && email.bcc.length > 0 && (
              <Addresses label="Copied without the others seeing" addresses={email.bcc} />
            )}
            {email.reply_to && (
              <>
                <dt>Replies go to</dt>
                <dd>{showInvisible(email.reply_to)}</dd>
              </>
            )}
            <dt>Subject</dt>
            <dd>{showInvisible(email.subject)}</dd>
            <dt>Text</dt>
            <dd>
              <pre tabIndex={0} aria-label="The text of the email" className="pre-wrap">
                {showInvisible(email.text_body)}
              </pre>
            </dd>
          </dl>
        ) : (
          <pre tabIndex={0} aria-label="The exact action, as stored">
            {showInvisible(JSON.stringify(view.action, null, 2) ?? '')}
          </pre>
        )}
        <p>
          <small>
            Tool {view.toolId}, version {view.toolVersion}. Fingerprint of this action:{' '}
            {view.requestHash}
          </small>
        </p>
      </section>
    </>
  );
}
