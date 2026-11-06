// The outcome composer (UX-20). Reads a sentence into a previewed Work Unit, with rules and no model, so it
// works in every mode and sends nothing anywhere (ADR-031 D5). Owned by the composer slice.

export type OutcomePreview = {
  title: string;
  objective: string;
  /** The date as understood, or null when the sentence did not give one. Never guessed. */
  dueAt: string | null;
  ownerMembershipId: string;
  successCriteria: readonly {
    kind: 'artifact_named' | 'reviewer_approved' | 'none';
    label: string;
  }[];
  dependencyWorkUnitIds: readonly string[];
  /** A catalog workflow this resembles, as a suggestion a person can ignore. */
  suggestedProcessKey: string | null;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  /** Whether anything suggested here would reach outside. Worded on the page, never decided there. */
  dataAccess: {
    usesAgent: boolean;
    reachesExternalService: boolean;
    reasonCodes: readonly string[];
  };
  /** What the reader should look at, because the rules were not sure. */
  uncertainties: readonly ('due_date_unclear' | 'owner_assumed' | 'no_success_criteria')[];
};

export type ComposerContext = {
  now: Date;
  /** Today in the reader's calendar, as yyyy-mm-dd, so "by Friday" means their Friday. */
  today: string;
  defaultOwnerMembershipId: string;
  /** Catalog workflows it may suggest, as keys and the words that bring each to mind. */
  catalog: readonly { processKey: string; keywords: readonly string[] }[];
};

/** Pure. Implemented by the composer slice. A sentence it cannot read still gives an editable preview. */
export function parseObjective(_objective: string, _context: ComposerContext): OutcomePreview {
  throw new Error('NOT_IMPLEMENTED');
}
