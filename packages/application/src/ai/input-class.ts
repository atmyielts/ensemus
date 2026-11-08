// Metadata-only current + historical company-input proof. No policy/manifest text, body read,
// scope marker or authorization shortcut is manufactured here. Scope admission uses the result.
import { agentRuns, runInputCheckpoints, type AgentContext, type Tx } from '@ensemus/database';
import { strongestClassification, type AiClassification } from '@ensemus/domain/ai';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../errors';
const classes = ['public', 'internal', 'confidential', 'restricted'] as const;
const knownClass = (value: unknown): value is AiClassification =>
  classes.includes(value as AiClassification);
type Ref = { kind: string; id: string };
/** Current class of every retained prior influence, including dropped retrieval candidates and files
 * whose original records were later reparented. Historical hashes are never compared with mutable rows. */
export async function currentRunCompanyClassInTx(
  tx: Tx,
  context: AgentContext,
  options: { lockRun?: boolean } = {},
): Promise<{
  classification: AiClassification;
  inputCount: number;
  hasTargetWork: boolean;
  knowledgeSourceIds: string[];
}> {
  if (context.actorType !== 'agent') throw new AppError('FORBIDDEN');
  const inventory = sql`with observations as(
    select input_kind kind,input_id id from ai.run_input_observations where organization_id=${context.organizationId}::uuid and run_id=${context.agentRunId}::uuid
  ), nodes as(
    select id from observations where kind='artifact'
    union select i.input_artifact_id from knowledge.artifact_lineage_inputs i join observations o on o.kind='artifact' and o.id=i.artifact_id where i.organization_id=${context.organizationId}::uuid
  ), package_ids as(
    select p.id from knowledge.evidence_packages p where p.organization_id=${context.organizationId}::uuid and p.run_id=${context.agentRunId}::uuid
    union select p.package_id from knowledge.artifact_lineage_packages p join nodes n on n.id=p.artifact_id where p.organization_id=${context.organizationId}::uuid
    union select p.id from knowledge.evidence_packages p join knowledge.artifact_lineage l on l.organization_id=p.organization_id and l.execution_kind='agent_run' and l.execution_id=p.run_id join nodes n on n.id=l.artifact_id where p.organization_id=${context.organizationId}::uuid
  ), call_inputs as(
    select i.kind,i.input_id id,i.source_id from ai.model_call_inputs i join ai.model_call_attempts c on c.organization_id=i.organization_id and c.id=i.call_id where c.organization_id=${context.organizationId}::uuid and c.run_id=${context.agentRunId}::uuid
  ), chunk_refs as(
    select i.chunk_id id from knowledge.evidence_items i join package_ids p on p.id=i.package_id where i.organization_id=${context.organizationId}::uuid
    union select c.chunk_id from knowledge.artifact_citations c join nodes n on n.id=c.artifact_id where c.organization_id=${context.organizationId}::uuid
    union select id from call_inputs where kind='chunk'
  ), all_refs as(
    select kind,id from observations
    union select 'artifact',id from nodes
    union select r.record_kind,r.record_id from observations o cross join lateral knowledge.artifact_required_records(o.id) r where o.kind='artifact'
    union select kind,id from call_inputs where kind<>'chunk'
    union select 'chunk',id from chunk_refs
    union select 'document',i.document_id from knowledge.evidence_items i join package_ids p on p.id=i.package_id where i.organization_id=${context.organizationId}::uuid
    union select 'document',ch.document_id from knowledge.chunks ch join chunk_refs r on r.id=ch.id where ch.organization_id=${context.organizationId}::uuid
    union select 'source',i.source_id from knowledge.evidence_items i join package_ids p on p.id=i.package_id where i.organization_id=${context.organizationId}::uuid
    union select 'source',source_id from call_inputs where source_id is not null
    union select 'source',knowledge.artifact_required_sources(o.id) from observations o where o.kind='artifact'
  ), current_projects as(
    select id from all_refs where kind='project'
    union select c.parent_record_id from knowledge.structured_record_catalog c join all_refs r on r.kind='work_unit' and r.id=c.record_id
      where c.organization_id=${context.organizationId}::uuid and c.record_kind='work_unit' and c.parent_record_id is not null
  ), scoped_refs as(
    select kind,id from all_refs
    union select 'project',id from current_projects
    union select 'client',c.parent_record_id from knowledge.structured_record_catalog c join current_projects p on p.id=c.record_id
      where c.organization_id=${context.organizationId}::uuid and c.record_kind='project' and c.parent_record_id is not null
  ) select kind,id from scoped_refs order by kind COLLATE "C",id limit 1001`;
  const refs = await tx.execute<Ref>(inventory);
  if (refs.rows.length > 1000) throw new AppError('POLICY_DENIED');
  const byKind = (kind: string) =>
    refs.rows.filter((ref) => ref.kind === kind).map((ref) => ref.id);
  // Sources/documents before metadata/checkpoints, matching close/purge and existing Knowledge writes.
  let floor: AiClassification = 'public';
  const add = (value: unknown) => {
    if (!knownClass(value)) throw new AppError('POLICY_DENIED');
    floor = strongestClassification(floor, value);
  };
  const ids = (values: readonly string[]) =>
    sql.join(
      values.map((value) => sql`${value}::uuid`),
      sql`,`,
    );
  const sources = byKind('source'),
    documents = byKind('document'),
    chunks = byKind('chunk');
  if (sources.length) {
    const result = await tx.execute<{ classification: string; readable: boolean }>(
      sql`select s.classification,s.state='active' and s.id in(select knowledge.readable_source_ids(${context.membershipId}::uuid)) readable from knowledge.sources s where s.organization_id=${context.organizationId}::uuid and s.id in(${ids(sources)}) order by s.id ${options.lockRun ? sql`for share nowait` : sql``}`,
    );
    if (result.rows.length !== sources.length || result.rows.some((row) => !row.readable))
      throw new AppError('POLICY_DENIED');
    for (const row of result.rows) add(row.classification);
  }
  if (documents.length) {
    const result = await tx.execute<{ classification: string }>(
      sql`select d.classification from knowledge.documents d where d.organization_id=${context.organizationId}::uuid and d.id in(${ids(documents)}) order by d.id ${options.lockRun ? sql`for share nowait` : sql``}`,
    );
    if (result.rows.length !== documents.length) throw new AppError('POLICY_DENIED');
    for (const row of result.rows) add(row.classification);
  }
  if (chunks.length) {
    const result = await tx.execute<{ classification: string }>(
      sql`select d.classification from knowledge.chunks c join knowledge.documents d on d.organization_id=c.organization_id and d.id=c.document_id where c.organization_id=${context.organizationId}::uuid and c.id in(${ids(chunks)})`,
    );
    if (result.rows.length !== chunks.length) throw new AppError('POLICY_DENIED');
    for (const row of result.rows) add(row.classification);
  }
  for (const artifactId of byKind('artifact')) {
    if (options.lockRun)
      await tx.execute(sql`select knowledge.lock_artifact_catalog(${artifactId}::uuid)`);
    const result = await tx.execute<{ classification: string; readable: boolean }>(
      sql`select a.classification,a.alive and knowledge.artifact_readable(a.artifact_id,${context.membershipId}::uuid) readable from knowledge.artifact_acl_catalog a where a.organization_id=${context.organizationId}::uuid and a.artifact_id=${artifactId}::uuid`,
    );
    if (result.rows.length !== 1 || !result.rows[0]?.readable) throw new AppError('POLICY_DENIED');
    add(result.rows[0].classification);
  }
  for (const ref of refs.rows.filter(
    (ref) => !['source', 'document', 'chunk', 'artifact'].includes(ref.kind),
  )) {
    if (options.lockRun) {
      const locked = await tx.execute<{ locked: boolean }>(
        sql`select knowledge.lock_structured_record(${ref.kind},${ref.id}::uuid) locked`,
      );
      if (locked.rows[0]?.locked !== true) throw new AppError('POLICY_DENIED');
    }
    const result = await tx.execute<{ classification: string; readable: boolean }>(
      sql`select knowledge.structured_record_class(${ref.kind},${ref.id}::uuid) classification,knowledge.structured_record_readable(${ref.kind},${ref.id}::uuid,${context.membershipId}::uuid) readable`,
    );
    if (result.rows[0]?.readable !== true) throw new AppError('POLICY_DENIED');
    add(result.rows[0].classification);
  }
  if (options.lockRun)
    await tx
      .select({ id: runInputCheckpoints.runId })
      .from(runInputCheckpoints)
      .where(eq(runInputCheckpoints.runId, context.agentRunId))
      .for('share');
  const open = await tx.execute<{ admitted: boolean }>(
    sql`select ai.run_scope_preflight(${context.agentRunId}::uuid) admitted`,
  );
  if (!open.rows[0]?.admitted) throw new AppError('POLICY_DENIED');
  if (options.lockRun)
    await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, context.agentRunId))
      .for('update', { noWait: true });
  const checked = await tx.execute<Ref>(inventory);
  if (JSON.stringify(checked.rows) !== JSON.stringify(refs.rows))
    throw new AppError('POLICY_DENIED');
  // A later lowering/reparenting cannot un-tell material already read. Use per-input captured
  // classes, not overall package/run protection (which also includes internal manifest policy).
  const historical = await tx.execute<{ classification: string }>(sql`
    with refs as(${inventory}), nodes as(select id from refs where kind='artifact'), packages as(
      select id from knowledge.evidence_packages where organization_id=${context.organizationId}::uuid and run_id=${context.agentRunId}::uuid
      union select p.package_id from knowledge.artifact_lineage_packages p join nodes n on n.id=p.artifact_id where p.organization_id=${context.organizationId}::uuid
      union select p.id from knowledge.evidence_packages p join knowledge.artifact_lineage l on l.organization_id=p.organization_id and l.execution_kind='agent_run' and l.execution_id=p.run_id join nodes n on n.id=l.artifact_id where p.organization_id=${context.organizationId}::uuid
    ) select distinct classification from(
      select classification from ai.run_input_observations where organization_id=${context.organizationId}::uuid and run_id=${context.agentRunId}::uuid
      union all select i.classification from ai.model_call_inputs i join ai.model_call_attempts c on c.organization_id=i.organization_id and c.id=i.call_id where c.organization_id=${context.organizationId}::uuid and c.run_id=${context.agentRunId}::uuid
      union all select i.classification from knowledge.evidence_items i join packages p on p.id=i.package_id where i.organization_id=${context.organizationId}::uuid
      union all select f.classification from knowledge.evidence_package_facts f join packages p on p.id=f.package_id where f.organization_id=${context.organizationId}::uuid
      union all select r.classification from knowledge.artifact_lineage_records r join nodes n on n.id=r.artifact_id where r.organization_id=${context.organizationId}::uuid
    ) h`);
  for (const row of historical.rows) add(row.classification);
  const knowledgeSources = await tx.execute<{ id: string }>(sql`select distinct id from(
    select i.source_id id from knowledge.evidence_items i join knowledge.evidence_packages p on p.organization_id=i.organization_id and p.id=i.package_id where p.organization_id=${context.organizationId}::uuid and p.run_id=${context.agentRunId}::uuid
    union all select i.source_id id from ai.model_call_inputs i join ai.model_call_attempts c on c.organization_id=i.organization_id and c.id=i.call_id where c.organization_id=${context.organizationId}::uuid and c.run_id=${context.agentRunId}::uuid and i.kind='chunk' and i.source_id is not null
  ) s order by id limit 1001`);
  if (knowledgeSources.rows.length > 1000) throw new AppError('POLICY_DENIED');
  const target = await tx.execute<{ observed: boolean }>(sql`select exists(
    select 1 from ai.run_input_observations o join ai.agent_runs r on r.organization_id=o.organization_id and r.id=o.run_id
    where r.organization_id=${context.organizationId}::uuid and r.id=${context.agentRunId}::uuid and o.input_kind='work_unit' and o.input_id=r.work_unit_id
  ) observed`);
  return {
    classification: floor,
    inputCount: refs.rows.length,
    hasTargetWork: target.rows[0]?.observed === true,
    knowledgeSourceIds: knowledgeSources.rows.map((row) => row.id),
  };
}
