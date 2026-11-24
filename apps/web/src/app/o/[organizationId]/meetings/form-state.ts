export type MeetingFormKind = 'settings' | 'create' | 'participant' | 'notes';
export type MeetingFormState = {
  code?: string;
  saved?: boolean;
  revision?: number;
  values?: Record<string, string>;
};
