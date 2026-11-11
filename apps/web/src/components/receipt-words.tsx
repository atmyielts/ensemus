// What a person is told about an external action (ADR-027 D6). The words are in one place so the three
// outcomes cannot blur: `unknown` has its own label, tone and sentence, and nothing below can make it read
// as sent or as not sent. No imports, so a unit test can hold every word to that.

export type ReceiptFacts = {
  status: string;
  statusReason?: string | null;
  resolvedByName?: string | null;
};

/** A person's word is shown as a person's word, whichever list or page this is. */
function personSaid(facts: ReceiptFacts) {
  if (
    facts.statusReason !== 'PERSON_CONFIRMED_SENT' &&
    facts.statusReason !== 'PERSON_CONFIRMED_NOT_SENT'
  ) {
    return null;
  }
  return facts.resolvedByName ?? 'a person';
}

export const UNKNOWN_LABEL = "We don't know whether this was sent";

export function statusWords(facts: ReceiptFacts): { label: string; tone: string } {
  const person = personSaid(facts);
  switch (facts.status) {
    case 'awaiting_approval':
      return { label: 'Waiting for approval', tone: 'attention' };
    case 'ready':
      return { label: 'Approved, not sent yet', tone: 'active' };
    case 'sending':
      return { label: 'Sending now', tone: 'active' };
    case 'reconciling':
      return { label: 'Checking what happened', tone: 'active' };
    case 'sent':
      return { label: person ? `Sent: confirmed by ${person}` : 'Sent', tone: 'done' };
    case 'failed':
      return { label: person ? `Not sent: confirmed by ${person}` : 'Not sent', tone: 'bad' };
    case 'unknown':
      return { label: UNKNOWN_LABEL, tone: 'unknown' };
    case 'cancelled':
      return { label: 'Cancelled, so not sent', tone: '' };
    default:
      return { label: 'Status not recognized', tone: 'attention' };
  }
}

// Every code in EXTERNAL_ACTION_CODES, and a test holds the two lists together. A Map, because a plain
// object also answers for keys like `constructor`.
const REASONS = new Map<string, string>([
  ['APPROVAL_DENIED', 'The person asked to approve it said no.'],
  ['APPROVAL_EXPIRED', 'Nobody sent it before its approval ran out, so it will not go late.'],
  ['APPROVAL_NOT_VALID', 'Its approval no longer covered exactly this.'],
  ['SUPERSEDED', 'Someone changed what would be sent, so this version was replaced.'],
  ['WORK_STOPPED', 'The work it belongs to was stopped.'],
  ['CONNECTION_NOT_ACTIVE', 'The connection it would go through is no longer active.'],
  ['CONNECTOR_UNAVAILABLE', 'Nothing on this deployment was able to pick it up.'],
  ['CREDENTIAL_UNAVAILABLE', 'The credential for your mail server could not be opened.'],
  ['PAYLOAD_CHANGED', 'What was stored no longer matched what was approved, so it was stopped.'],
  ['ATTEMPTS_EXHAUSTED', 'Ensemus could not reach your mail server after several tries.'],
  [
    'CONNECTION_CHANGED',
    'The account it would go through is no longer one the person who started it may use.',
  ],
  [
    'SCOPE_NOT_GRANTED',
    'The account it would go through no longer allows this, so nothing was sent.',
  ],
  [
    'ACCESS_REVOKED',
    'The person who started it, or their access to what it changes, is gone, so nothing was sent.',
  ],
  ['CONNECT_FAILED', 'Ensemus could not connect to your mail server.'],
  ['TLS_REQUIRED', 'Your mail server did not offer an encrypted connection, so nothing was sent.'],
  ['AUTH_FAILED', 'Your mail server did not accept the credential.'],
  [
    'TIMEOUT_BEFORE_COMMIT',
    'Your mail server stopped answering before the message was handed over.',
  ],
  ['RELAY_BUSY', 'Your mail server was too busy to take it.'],
  ['ACCEPTED_BY_RELAY', 'Your mail server accepted it.'],
  ['ACCEPTED_BY_PROVIDER', 'The outside system accepted it.'],
  ['REFUSED_BY_PROVIDER', 'Your mail server refused it.'],
  ['RECIPIENT_REFUSED', 'Your mail server refused a recipient.'],
  ['TIMEOUT_AFTER_COMMIT', 'Your mail server stopped answering after the message was handed over.'],
  ['CONNECTION_LOST_AFTER_COMMIT', 'The connection dropped after the message was handed over.'],
  ['WORKER_INTERRUPTED', 'Ensemus was interrupted while this was being sent.'],
  ['PROVIDER_CANNOT_ANSWER', 'Your mail server has no way to say whether it took a message.'],
  ['PROVIDER_FOUND_IT', 'The outside system was asked, and found it.'],
  ['PROVIDER_DID_NOT_FIND_IT', 'The outside system was asked, and it was not there.'],
  ['PERSON_CONFIRMED_SENT', 'Someone looked and said it went.'],
  ['PERSON_CONFIRMED_NOT_SENT', 'Someone looked and said it did not go.'],
]);

/** The reason in words. A code nobody wrote words for is not guessed at. */
export function reasonWords(code: string | null | undefined): string | null {
  if (!code) return null;
  return REASONS.get(code) ?? 'No more detail was recorded.';
}

export const REASON_CODES = [...REASONS.keys()];

/** The sentence that goes with the status. For `unknown` it says what to do next. */
export function statusExplanation(facts: ReceiptFacts): string {
  const person = personSaid(facts);
  const rests = person ? ` This rests on what ${person} said, and not on your mail server.` : '';
  switch (facts.status) {
    case 'awaiting_approval':
      return 'Nothing has been sent. It goes only if the person asked approves exactly what is shown here.';
    case 'ready':
      return 'It has been approved and has not gone yet. It goes out as soon as Ensemus can reach your mail server.';
    case 'sending':
      return 'Ensemus is handing this to your mail server now.';
    case 'reconciling':
      return 'Your mail server did not answer, so Ensemus is working out what is known. Nothing is sent again while it does.';
    case 'sent':
      return person
        ? `${person} looked and said it went.${rests}`
        : 'Your mail server accepted this. That is not the same as reaching an inbox: what happens after your mail server takes a message is outside what Ensemus can see.';
    case 'failed':
      return person
        ? `${person} looked and said it did not go.${rests} To send it, ask again, which needs a new approval.`
        : `This was not sent. ${reasonWords(facts.statusReason) ?? ''} To send it, ask again, which needs a new approval.`.replace(
            '  ',
            ' ',
          );
    case 'unknown':
      return 'The attempt could have gone through, and your mail server cannot say. Ensemus will not try again by itself. Search your mail server’s log for the Message-ID shown here, then say what you found.';
    case 'cancelled':
      return `This was not sent, and it never will be. ${reasonWords(facts.statusReason) ?? ''}`.trim();
    default:
      return 'Ensemus cannot describe this status. Do not rely on it having gone or not.';
  }
}

export function outcomeWords(outcome: string): string {
  switch (outcome) {
    case 'sent':
      return 'Sent';
    case 'failed':
      return 'Not sent';
    case 'unknown':
      return UNKNOWN_LABEL;
    case 'cancelled':
      return 'Cancelled, so not sent';
    default:
      return 'Not recognized';
  }
}

/** On whose word a receipt rests. */
export function basisWords(basis: string, actorName: string | null): string {
  switch (basis) {
    case 'provider':
      return 'On your mail server’s word';
    case 'reconciliation':
      return 'On your mail server’s word, when asked afterwards';
    case 'person':
      return `On the word of ${actorName ?? 'someone no longer here'}, who looked`;
    case 'system':
      return 'On Ensemus’s own record, because nothing was sent';
    default:
      return 'Not recognized';
  }
}

/**
 * What someone asked to search their mail server's log should look for. The Message-ID is derived from
 * the action, so if the full one was never recorded its first part still finds it (ADR-027 D2).
 */
export function messageIdHint(action: { id: string; externalId: string | null }): {
  value: string;
  whole: boolean;
} {
  return action.externalId
    ? { value: action.externalId, whole: true }
    : { value: `<${action.id}@`, whole: false };
}
