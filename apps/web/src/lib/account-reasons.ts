// Existing audit-code contracts accept CUSTOMER_REQUEST for these customer-authorized operations.
// A reason is selected explicitly; no legal finding or policy is inferred by the interface.
export const ACCOUNT_REASON_CHOICES = {
  cancel_offboarding: [{ code: 'CUSTOMER_REQUEST', label: 'Our organization has decided to stay' }],
  release_hold: [
    { code: 'CUSTOMER_REQUEST', label: 'Our organization requests release of this hold' },
  ],
} as const;
