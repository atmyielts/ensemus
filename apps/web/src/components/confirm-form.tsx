import type { ReactNode } from 'react';
import { KeptTextarea } from './kept-field';
import { SubmitButton } from './submit-button';

/**
 * A step between pressing something that cannot be undone and it happening. It needs no JavaScript:
 * opening the panel and ticking the box are the review, and the action checks the box again.
 */
export function ConfirmForm({
  action,
  fields,
  summary,
  summaryLabel,
  consequence,
  confirmLabel,
  confirmFullLabel,
  reasonLabel,
  children,
}: {
  action: (form: FormData) => Promise<void>;
  fields: ReactNode;
  summary: string;
  summaryLabel?: string;
  consequence: string;
  confirmLabel: string;
  /** The same words and more, for a screen reader, when the button alone would not say which. */
  confirmFullLabel?: string;
  /** Asks why, when the reason should be on the record. */
  reasonLabel?: string;
  children?: ReactNode;
}) {
  return (
    <details className="confirm">
      <summary aria-label={summaryLabel}>{summary}</summary>
      <form className="fields" action={action}>
        {fields}
        {children}
        {reasonLabel && (
          <label>
            {reasonLabel}
            <KeptTextarea
              keep={`confirm-${confirmLabel}`}
              name="reason"
              required
              maxLength={2000}
            />
          </label>
        )}
        <label className="check">
          <input type="checkbox" name="confirm" value="yes" required />
          {consequence}
        </label>
        <div>
          <SubmitButton className="danger" label={confirmFullLabel}>
            {confirmLabel}
          </SubmitButton>
        </div>
      </form>
    </details>
  );
}
