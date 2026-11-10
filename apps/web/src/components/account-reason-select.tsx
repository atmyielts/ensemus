import { ACCOUNT_REASON_CHOICES } from '@/lib/account-reasons';

export function AccountReasonSelect({
  forAction,
}: {
  forAction: keyof typeof ACCOUNT_REASON_CHOICES;
}) {
  return (
    <label>
      {forAction === 'cancel_offboarding'
        ? 'Reason for cancelling'
        : 'Reason for releasing this hold'}
      <select name="reasonCode" required defaultValue="">
        <option value="">Choose a reason</option>
        {ACCOUNT_REASON_CHOICES[forAction].map((choice) => (
          <option key={choice.code} value={choice.code}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}
