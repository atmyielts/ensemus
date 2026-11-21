/** Business receipts describe the connected system and keep a person's report distinct from proof. */
export function businessStatusExplanation(facts: {
  status: string;
  resolvedByName: string | null;
  statusReason?: string | null;
}) {
  if (facts.status === 'awaiting_approval')
    return 'Nothing has been sent. An independent reviewer must approve the exact proposal first.';
  if (facts.status === 'ready')
    return 'The proposal is approved and waiting to be attempted in the connected system.';
  if (facts.status === 'sending')
    return 'Ensemus has recorded an attempt and is contacting the connected system.';
  if (facts.status === 'reconciling')
    return 'The attempt has no definite answer yet. Ensemus is checking what happened before any further attempt.';
  if (facts.status === 'sent')
    return facts.statusReason === 'PERSON_CONFIRMED_SENT'
      ? `${facts.resolvedByName ?? 'Someone no longer here'} reported that the change was sent. This is their finding; the connected system did not confirm it.`
      : 'The connected system accepted this action. Check the source record for its resulting state.';
  if (facts.status === 'unknown')
    return 'The change may have happened. Ensemus will not retry it by itself. Check the connected system using the request key below, then record what you found.';
  if (facts.status === 'failed' && facts.statusReason === 'PERSON_CONFIRMED_NOT_SENT')
    return `${facts.resolvedByName ?? 'Someone no longer here'} reported that it was not sent. This rests on their finding. Asking again needs a new approval.`;
  if (facts.status === 'failed')
    return 'This action was not sent, or the connected system definitely refused it. Asking again creates a new proposal that needs another approval.';
  if (facts.status === 'cancelled')
    return 'This proposal cannot be sent. A changed proposal needs a new independent approval.';
  return 'This outcome cannot be described safely. Check its receipts before relying on it.';
}
export function businessReceiptBasis(basis: string, person: string | null) {
  return basis === 'provider'
    ? 'On the connected system’s word'
    : basis === 'reconciliation'
      ? 'On the connected system’s word when checked afterwards'
      : basis === 'person'
        ? `Reported by ${person ?? 'someone no longer here'}, after checking`
        : basis === 'system'
          ? 'From Ensemus’s records; nothing was sent'
          : 'No recognized basis was recorded';
}
export function businessReceiptReason(code: string | null) {
  const words: Record<string, string> = {
    ACCESS_REVOKED: 'Current source or Work access no longer permits this change.',
    SCOPE_NOT_GRANTED: 'The connection no longer has the scopes needed for this change.',
    PAYLOAD_CHANGED: 'The source snapshot or exact proposal no longer matches.',
    CONNECTION_NOT_ACTIVE: 'The connection is no longer active.',
    CONNECTION_CHANGED: 'The connection is no longer eligible for this proposal.',
    REFUSED_BY_PROVIDER: 'The connected system refused the change.',
    ACCEPTED_BY_PROVIDER: 'The connected system accepted the change.',
    CONNECTOR_UNAVAILABLE: 'This connection is not available for actions.',
    CREDENTIAL_UNAVAILABLE: 'The connection credential could not be used.',
    SUPERSEDED: 'A new proposal replaced this one.',
    WORK_STOPPED: 'The Work was stopped.',
    PROVIDER_CANNOT_ANSWER: 'The connected system cannot confirm what happened.',
    PROVIDER_FOUND_IT: 'The connected system found the earlier change.',
    PROVIDER_DID_NOT_FIND_IT:
      'The lookup did not find the change. Its certainty depends on the connection’s verification capability.',
    APPROVAL_DENIED: 'The reviewer denied this proposal.',
    APPROVAL_EXPIRED: 'The approval expired.',
    APPROVAL_NOT_VALID: 'The approval no longer permits this action.',
  };
  return code ? (words[code] ?? 'No further verified detail is available.') : null;
}
