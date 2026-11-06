import { emailSendPayloadSchema } from '@ensemus/contracts/external-actions';

const addressOf = (from: { address: string; name?: string | undefined }) =>
  from.name ? `${from.name} <${from.address}>` : from.address;

/**
 * The exact email, as the approval binds it. Every field a reviewer relies on is on the page, including
 * blind copies. Anything that does not read as an email is shown as stored instead of being tidied up.
 */
export function ExactEmail({ payload }: { payload: unknown }) {
  const parsed = emailSendPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return (
      <pre tabIndex={0} aria-label="The exact action, as stored">
        {JSON.stringify(payload, null, 2)}
      </pre>
    );
  }
  const mail = parsed.data;
  return (
    <dl className="exact-email">
      <dt>From</dt>
      <dd>{addressOf(mail.from)}</dd>
      <dt>To</dt>
      <dd>{mail.to.join(', ')}</dd>
      {mail.cc && mail.cc.length > 0 && (
        <>
          <dt>Copy to</dt>
          <dd>{mail.cc.join(', ')}</dd>
        </>
      )}
      {mail.bcc && mail.bcc.length > 0 && (
        <>
          <dt>Blind copy to</dt>
          <dd>{mail.bcc.join(', ')}</dd>
        </>
      )}
      {mail.reply_to && (
        <>
          <dt>Replies go to</dt>
          <dd>{mail.reply_to}</dd>
        </>
      )}
      <dt>Subject</dt>
      <dd>{mail.subject}</dd>
      <dt>Message</dt>
      <dd className="pre-wrap">{mail.text_body}</dd>
    </dl>
  );
}
