// What each capability a member can connect lets an assistant do, in the words both the member's page and
// the admin's control use, so the two never describe the same access differently. Changes through any of
// them are proposals: the organization's approval rules decide which need a person, and sending outside
// the organization always does.
import type { SuiteCapability } from '@ensemus/domain/workspace-suites';

export const MEMBER_CAPABILITY_WORDS: Readonly<
  Record<'mail' | 'calendar' | 'documents' | 'chat', { label: string; description: string }>
> = {
  mail: {
    label: 'Mail',
    description: 'Search and read the mail, write drafts, and send mail once it is approved.',
  },
  calendar: {
    label: 'Calendar',
    description: 'See events, and add or change them once the change is approved.',
  },
  documents: {
    label: 'Documents',
    description: 'Read documents and sheets, and edit or create them once the change is approved.',
  },
  chat: {
    label: 'Chat',
    description: 'Post messages in Teams once they are approved. Microsoft 365 only.',
  },
};

export const capabilityLabel = (capability: SuiteCapability) =>
  (MEMBER_CAPABILITY_WORDS as Record<string, { label: string }>)[capability]?.label ?? capability;

export const SUITE_NAMES = {
  google_workspace: 'Google Workspace',
  microsoft_365: 'Microsoft 365',
} as const;

export const suiteName = (connectorType: string) =>
  Object.hasOwn(SUITE_NAMES, connectorType)
    ? SUITE_NAMES[connectorType as keyof typeof SUITE_NAMES]
    : 'a provider this deployment does not know';

export const CONNECTION_STATE_WORDS: Readonly<Record<string, { label: string; tone: string }>> = {
  active: { label: 'Active', tone: 'done' },
  disabled: { label: 'Disabled', tone: 'attention' },
  revoked: { label: 'Revoked', tone: '' },
};
