import { statusWords, type ReceiptFacts } from './receipt-words';

/**
 * The one way an external action's status is drawn. The label is always there in words, and `unknown`
 * also carries a question mark, so it is never only a colour.
 */
export function ReceiptStatusBadge(facts: ReceiptFacts) {
  const { label, tone } = statusWords(facts);
  return (
    <span className={`badge ${tone}`}>
      {facts.status === 'unknown' && <span aria-hidden="true">? </span>}
      {label}
    </span>
  );
}
