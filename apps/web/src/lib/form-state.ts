// What a form's Server Action hands back when it cannot redirect. Errors are known codes, and the
// values are what the person typed, so a refused save never loses their work.

export type WorkDraft = { title: string; objective: string; dueAt: string };

export type WorkFormState = {
  code?: string;
  /** The one field at fault, when it can be named. */
  field?: 'title' | 'dueAt';
  values?: WorkDraft;
  /** What the work holds now, when someone else's change got there first. */
  latest?: WorkDraft & { version: number };
};

export type NewWorkFormState = {
  code?: string;
  field?: 'title' | 'dueAt';
  values?: WorkDraft & {
    projectId: string;
    classification: string;
    criteria: string[];
    executionPlan: boolean;
  };
};

export type InviteFormState = {
  code?: string;
  values?: { email: string; role: string };
  /** A live credential. It exists only in this response, and never in a URL. */
  link?: string;
};
