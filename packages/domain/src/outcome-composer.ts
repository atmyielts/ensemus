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

/** A calendar date that can also reach PostgreSQL; never JavaScript's rolled-over February dates. */
export function isComposerDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const plusDays = (today: string, days: number) => {
  const date = new Date(today + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .trim();
function deadline(text: string, today: string): string | null {
  if (!isComposerDate(today)) return null;
  const dates = new Set<string>();
  let invalid = false;
  for (const candidate of text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []) {
    if (isComposerDate(candidate)) dates.add(candidate);
    else invalid = true;
  }
  if (/\btoday\b/i.test(text)) dates.add(today);
  if (/\btomorrow\b/i.test(text)) {
    const candidate = plusDays(today, 1);
    if (isComposerDate(candidate)) dates.add(candidate);
    else invalid = true;
  }
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const current = new Date(today + 'T00:00:00.000Z').getUTCDay();
  for (const day of weekdays)
    if (new RegExp('\\b(?:by|on|next)\\s+' + day + '\\b', 'i').test(text)) {
      const offset = (weekdays.indexOf(day) - current + 7) % 7;
      // "Next Friday" means the next occurrence, including a full week when today is Friday.
      const candidate = plusDays(today, offset || 7);
      if (isComposerDate(candidate)) dates.add(candidate);
      else invalid = true;
    }
  return invalid || dates.size !== 1 ? null : ([...dates][0] ?? null);
}
function suggestion(text: string, catalog: ComposerContext['catalog']): string | null {
  const haystack = ' ' + normalized(text) + ' ';
  const scores = catalog.map((entry) => ({
    key: entry.processKey,
    score: [...new Set(entry.keywords.map(normalized).filter(Boolean))].filter((k) =>
      haystack.includes(' ' + k + ' '),
    ).length,
  }));
  const best = Math.max(0, ...scores.map((row) => row.score));
  const keys = [
    ...new Set(scores.filter((row) => row.score === best && best > 0).map((row) => row.key)),
  ];
  return keys.length === 1 ? (keys[0] ?? null) : null;
}

/** Rules produce suggestions only. Nothing here selects credentials, calls a model or authorizes work. */
export function objectiveDataAccess(text: string): OutcomePreview['dataAccess'] {
  const usesAgent = /\b(agent|assistant|ai)\b/i.test(text),
    reachesExternalService = /\b(send|email|publish|invoice|accounting|notify)\b/i.test(text);
  return {
    usesAgent,
    reachesExternalService,
    reasonCodes: [
      'NOT_STARTED',
      ...(usesAgent ? ['ASSISTANT_MENTIONED'] : []),
      ...(reachesExternalService ? ['EXTERNAL_ACTION_MENTIONED'] : []),
    ],
  };
}
export function parseObjective(objective: string, context: ComposerContext): OutcomePreview {
  const text = objective.trim(),
    dueAt = deadline(text, context.today);
  let title =
    text
      .split(/[\r\n]/, 1)[0]
      ?.slice(0, 200)
      .trim() ?? '';
  if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0, -1);
  const artifact = /\b(proposal|report|brief|summary|document|draft)\b/i.exec(text)?.[1];
  const review = /\b(review|approve|approval)\b/i.test(text);
  const successCriteria: OutcomePreview['successCriteria'] = [
    ...(artifact
      ? [
          {
            kind: 'artifact_named' as const,
            label:
              'File attached; a person checks the requested ' +
              artifact.toLowerCase() +
              ' name and content',
          },
        ]
      : []),
    ...(review
      ? [{ kind: 'reviewer_approved' as const, label: 'A person approves the result' }]
      : []),
  ];
  return {
    title: title || 'New outcome',
    objective: text,
    dueAt,
    ownerMembershipId: context.defaultOwnerMembershipId,
    successCriteria: successCriteria.length
      ? successCriteria
      : [{ kind: 'none', label: 'The accountable owner confirms the outcome' }],
    dependencyWorkUnitIds: [],
    suggestedProcessKey: suggestion(text, context.catalog),
    classification: 'restricted',
    dataAccess: objectiveDataAccess(text),
    uncertainties: [
      ...(!dueAt ? ['due_date_unclear' as const] : []),
      'owner_assumed',
      ...(!successCriteria.length ? ['no_success_criteria' as const] : []),
    ],
  };
}
