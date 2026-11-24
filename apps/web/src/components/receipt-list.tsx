import { businessReceiptBasis, businessReceiptReason } from '@/lib/business-receipt-words';
import type { ExternalActionReceiptView } from '@ensemus/application';
import { basisWords, outcomeWords, reasonWords } from './receipt-words';
import { Empty, formatDateTime } from './ui';

/** Every receipt, each with whose word it rests on. A person's word never reads as the server's. */
export function ReceiptList({
  receipts,
  business = false,
}: {
  receipts: readonly ExternalActionReceiptView[];
  business?: boolean;
}) {
  if (receipts.length === 0) {
    return <Empty>No receipt yet, because nobody has said what happened.</Empty>;
  }
  return (
    <ul className="list">
      {receipts.map((receipt, index) => (
        <li key={index} className="block">
          <strong>
            {business && receipt.outcome === 'sent'
              ? 'Recorded as sent'
              : outcomeWords(receipt.outcome)}
          </strong>{' '}
          <small>{formatDateTime(receipt.recordedAt)}</small>
          <p>
            {business
              ? businessReceiptBasis(receipt.basis, receipt.actorName)
              : basisWords(receipt.basis, receipt.actorName)}
          </p>
          {(business ? businessReceiptReason(receipt.code) : reasonWords(receipt.code)) && (
            <p className="muted">
              {business ? businessReceiptReason(receipt.code) : reasonWords(receipt.code)}
            </p>
          )}
          {receipt.providerStatus !== null && (
            <p className="muted">
              {business ? 'The connected system' : 'Your mail server'} answered with code{' '}
              {receipt.providerStatus}.
            </p>
          )}
          {receipt.externalId && (
            <p className="muted">
              {business ? 'Source reference' : 'Message-ID'}: <code>{receipt.externalId}</code>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
