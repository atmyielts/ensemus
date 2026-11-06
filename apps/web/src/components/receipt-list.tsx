import type { ExternalActionReceiptView } from '@ensemus/application';
import { basisWords, outcomeWords, reasonWords } from './receipt-words';
import { Empty, formatDateTime } from './ui';

/** Every receipt, each with whose word it rests on. A person's word never reads as the server's. */
export function ReceiptList({ receipts }: { receipts: readonly ExternalActionReceiptView[] }) {
  if (receipts.length === 0) {
    return <Empty>No receipt yet, because nobody has said what happened.</Empty>;
  }
  return (
    <ul className="list">
      {receipts.map((receipt, index) => (
        <li key={index} className="block">
          <strong>{outcomeWords(receipt.outcome)}</strong>{' '}
          <small>{formatDateTime(receipt.recordedAt)}</small>
          <p>{basisWords(receipt.basis, receipt.actorName)}</p>
          {reasonWords(receipt.code) && <p className="muted">{reasonWords(receipt.code)}</p>}
          {receipt.providerStatus !== null && (
            <p className="muted">Your mail server answered with code {receipt.providerStatus}.</p>
          )}
          {receipt.externalId && (
            <p className="muted">
              Message-ID: <code>{receipt.externalId}</code>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
