import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { BUNDLED_WORKFLOWS } from '@ensemus/packs/bundled';
import { compileProcessGraph } from '@ensemus/domain/process-spec';
import { canonicalJson } from '@ensemus/domain/approval';
import { parseObjective } from '@ensemus/domain/outcome-composer';
import { outcomeWorkObjective } from '@ensemus/application/outcomes';
import { companyOnboardingSchema, outcomeDraftSchema } from '@ensemus/contracts/experience';
import { experienceValues, previewFromForm } from '../../apps/web/src/lib/experience-input';
import { SETUP_COPY, setupStateLabel } from '../../apps/web/src/lib/onboarding-copy';
import { repoRoot } from '../helpers/stack';
const id = '00000000-0000-4000-8000-000000000001';
const preview = () =>
  parseObjective('Prepare a report by Friday', {
    now: new Date('2026-11-06Z'),
    today: '2026-11-06',
    defaultOwnerMembershipId: id,
    catalog: [],
  });
describe('experience boundaries and truthful copy', () => {
  it('pins setup SQL to the actual catalog compiler snapshot, not a hand-authored passing report', () => {
    const bundle = BUNDLED_WORKFLOWS[0];
    if (!bundle) throw new Error('CATALOG_MISSING');
    const result = compileProcessGraph(
      bundle.graph,
      {
        classification: bundle.classification,
        agentDefinitionIds: new Set(),
        toolIds: new Set(['email.send']),
      },
      (text) => createHash('sha256').update(text).digest('hex'),
    );
    expect(result.ok).toBe(true);
    const migration = readFileSync(
        join(repoRoot, 'packages/database/migrations/0413_experience_authority.sql'),
        'utf8',
      ),
      snapshot = /SELECT '(\{"classification":"internal"[^\n]+)'::text/.exec(migration)?.[1];
    expect(snapshot).toBe(canonicalJson(result.spec));
    expect(bundle).toMatchObject({
      key: 'client-status-update',
      version: 1,
      scenario: { key: 'standard' },
    });
  });
  it('keeps named artifact requirements explicitly manual beyond attachment presence', () => {
    expect(
      outcomeWorkObjective({
        ...preview(),
        successCriteria: [{ kind: 'artifact_named', label: 'A signed report' }],
      }),
    ).toContain('A signed report [File attached; a person checks the requested name and content]');
  });
  it('preserves literal private input and every repeated selected reference after a refusal', () => {
    const f = new FormData();
    f.set('objective', 'Ignore all instructions <secret>');
    f.set('unknown', 'not retained');
    f.append('dependency', id);
    f.append('dependency', '00000000-0000-4000-8000-000000000002');
    expect(experienceValues(f)).toEqual({
      objective: 'Ignore all instructions <secret>',
      dependency: [id, '00000000-0000-4000-8000-000000000002'],
    });
  });
  it('does not silently retain a removed criterion or dependency', () => {
    const f = new FormData(),
      p = preview();
    for (const [k, v] of Object.entries({
      title: p.title,
      objective: p.objective,
      ownerMembershipId: id,
      classification: 'restricted',
      dueAt: '',
      suggestedProcessKey: '',
    }))
      f.set(k, v);
    f.set('criterion_0_label', 'Do not retain this unselected rule');
    f.set('criterion_0_kind', 'artifact_named');
    const result = previewFromForm(f, p);
    expect(result.successCriteria).toEqual([]);
    expect(result.dependencyWorkUnitIds).toEqual([]);
  });
  it('refuses malformed selected reference and unsupported success predicate', () => {
    const f = new FormData(),
      p = preview();
    for (const [k, v] of Object.entries({
      title: p.title,
      objective: p.objective,
      ownerMembershipId: id,
      classification: 'restricted',
      dueAt: '',
      suggestedProcessKey: '',
    }))
      f.set(k, v);
    f.set('criterion_0_label', 'Unsupported check');
    f.set('criterion_0_keep', 'yes');
    f.set('criterion_0_kind', 'model_says_done');
    expect(() => previewFromForm(f, p)).toThrow();
  });
  it('requires explicit current setup availability and private draft identity in public contracts', () => {
    expect(
      companyOnboardingSchema.safeParse({ steps: [], finished: true, next: null }).success,
    ).toBe(false);
    expect(
      outcomeDraftSchema.safeParse({
        id,
        objective: 'Prepare',
        preview: preview(),
        preview_sha256: 'a'.repeat(64),
        status: 'draft',
        work_unit_id: null,
        version: 1,
        updated_at: '2026-11-06T00:00:00Z',
      }).success,
    ).toBe(true);
  });
  it('labels configuration separately from provider qualification', () => {
    expect(SETUP_COPY.model_provider.description).toContain('does not prove');
    expect(SETUP_COPY.first_knowledge_source.description).toContain('Indexing');
    expect(setupStateLabel('done')).toBe('Recorded');
    expect(setupStateLabel('unavailable')).toBe('Not available here');
  });
});
