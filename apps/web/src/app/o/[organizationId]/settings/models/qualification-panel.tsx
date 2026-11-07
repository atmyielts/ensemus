import { randomUUID } from 'node:crypto';
import type { ModelQualificationView } from '@ensemus/application/knowledge/model-jobs';
import { SubmitButton } from '@/components/submit-button';
import { Empty, formatDate } from '@/components/ui';
import Link from 'next/link';
import { requestQualificationAction } from './actions';
import { ModelBoundsFields } from './model-bounds-fields';
import { PURPOSE_LABEL, qualificationState } from './workload-form';

export function QualificationPanel({
  organizationId,
  profile,
  evidence,
  nextCursor,
}: {
  organizationId: string;
  profile: { id: string; version: number; allowed_purposes: string[] };
  evidence: ModelQualificationView[];
  nextCursor: string | null;
}) {
  const purposes = Object.entries(PURPOSE_LABEL).filter(([purpose]) =>
    profile.allowed_purposes.includes(purpose),
  );
  return (
    <>
      <section className="card" aria-labelledby="qualification-heading">
        <h2 id="qualification-heading">Knowledge capabilities</h2>
        <p className="muted">
          A connection test does not qualify semantic indexing, ranking or answers. Each capability
          needs a confirmed test for this exact profile version. Tests use fixed synthetic material
          and may incur the explicit cost below. Workload approval is a separate step.
        </p>
        {evidence.length === 0 ? (
          <Empty>No capability evidence yet.</Empty>
        ) : (
          <ul className="list">
            {evidence.map((q) => {
              const state = qualificationState(q);
              return (
                <li key={q.id}>
                  <div className="stack">
                    <strong>
                      {PURPOSE_LABEL[q.purpose as keyof typeof PURPOSE_LABEL] ?? q.purpose} ·
                      profile version {q.profileVersion}
                    </strong>
                    <span className={`badge ${state.tone}`}>{state.label}</span>
                    <p>{state.detail}</p>
                    <dl className="facts">
                      <div>
                        <dt>Evidence reference</dt>
                        <dd>{q.id}</dd>
                      </div>
                      <div>
                        <dt>Protocol</dt>
                        <dd>{q.protocol}</dd>
                      </div>
                      {q.dimension !== null && (
                        <div>
                          <dt>Vector dimensions / space version</dt>
                          <dd>
                            {q.dimension} / {q.vectorSpaceVersion}
                          </dd>
                        </div>
                      )}
                      {q.qualifiedAt && (
                        <div>
                          <dt>Qualified</dt>
                          <dd>{formatDate(new Date(q.qualifiedAt))}</dd>
                        </div>
                      )}
                      {q.resultDigest && (
                        <div>
                          <dt>Result digest</dt>
                          <dd>{q.resultDigest}</dd>
                        </div>
                      )}
                      {q.job?.code && (
                        <div>
                          <dt>Refusal code</dt>
                          <dd>{q.job.code}</dd>
                        </div>
                      )}
                      <div>
                        <dt>Job reference</dt>
                        <dd>{q.job?.id ?? 'Unavailable'}</dd>
                      </div>
                      <div>
                        <dt>Approved test ceiling</dt>
                        <dd>
                          {q.maxCostMicros} micro-USD; {q.maxTotalTokens} tokens; {q.timeoutSeconds}{' '}
                          seconds
                        </dd>
                      </div>
                    </dl>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {nextCursor && (
          <Link href={`?qualification_after=${nextCursor}#qualification-heading`}>
            More capability evidence
          </Link>
        )}
      </section>
      <section className="card" aria-labelledby="qualify-heading">
        <h2 id="qualify-heading">Qualify a capability</h2>
        {purposes.length === 0 ? (
          <p className="muted">
            Enable a Knowledge purpose in this model’s details before requesting qualification.
          </p>
        ) : (
          <form action={requestQualificationAction} className="fields">
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="profileId" value={profile.id} />
            <input type="hidden" name="version" value={profile.version} />
            <input type="hidden" name="requestKey" value={randomUUID()} />
            <p>
              Requesting a test pauses this profile while it is checked. This request is pinned to
              profile version {profile.version}; changing its configuration invalidates the
              evidence.
            </p>
            <label>
              Capability
              <select name="purpose" required defaultValue="">
                <option value="" disabled>
                  Choose a capability
                </option>
                {purposes.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Embedding dimensions
              <input name="dimension" type="number" min="1" max="8192" />
              <small>
                Required only for semantic indexing. Leave blank for ranking and answers.
              </small>
            </label>
            <label>
              Embedding space version
              <input name="vectorSpaceVersion" maxLength={256} />
              <small>
                Your explicit space identifier, required only for indexing. The exact profile,
                dimension and space version stay bound together.
              </small>
            </label>
            <ModelBoundsFields qualification />
            <p className="muted">
              Native sign-in and the organization’s SSO policy apply. Recent second-factor
              verification is checked again when the request is saved.
            </p>
            <div>
              <SubmitButton className="quiet">Request capability test</SubmitButton>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
