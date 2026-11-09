-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-026, ADR-029). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person
-- Written by an agent in CI repair round 9 (restore-active-source-sql group, check findings 1 and 4).
-- It narrows 0550's write predicate and gives an active source a restore left in raw debt a way to
-- close and be purged by the ordinary lifecycle.
--
-- 0551 (r9 restore active source closure): additive. 0516, 0523, 0543, 0545, 0547, 0549 and 0550 are
-- registered and pushed, so none of them is edited; fixed definitions are cloned and wrapped, or
-- rewritten by exact text with count checks, the way 0543, 0545, 0547 and 0550 did, keeping their
-- OIDs and ACLs. Renumbered at merge if another 0551 lands first.
--
-- Check finding 1 (the guard gap): 0550's lifecycle.raw_active_source_requalified(source,material)
-- checked neither that the inventory had no purge job nor that the source was still active, yet 0550
-- let it satisfy both 0516's native writer predicate (record_raw_native_birth, writer branch) and
-- admit_raw_put. After a revoke the inventory stays restore_debt with its purge job and the proof row
-- still matches, so the predicate kept answering true for a closed source. Now:
--   * raw_active_source_requalified (CREATE OR REPLACE, same OID and ACL) also requires
--     i.purge_job_id IS NULL, i.source_version IS NULL, the source 'active' and no knowledge.purge_jobs
--     row for the source. It is the only predicate a write path reads.
--   * 0516's revoke transition (record_raw_native_birth, purge-job branch), which 0550 pointed at the
--     same predicate, now reads lifecycle.raw_active_source_closable(source,job,material): the source
--     is closed, the job being born is its only purge job, and the inventory is still the unclosed debt
--     a matching proof of this generation covers (0550's re-proof, or the closure observation below).
--     Exact-text rewrite, count 1.
--
-- Check finding 4, three narrow paths:
--  (i) A requalified active source that was later closed kept its pre-restore raw bytes and its
--      projections for ever: its inventory is restore debt that is never sealed, so 0516's capture,
--      per-document readiness (raw_document_writers_ready), per-source completion and 0547's survivor
--      path all refused, and the purge failed before it removed anything. Now the ORDINARY source purge
--      runs for exactly such a source ("closed active-source debt": protocol 1, restore_debt, never
--      sealed, its purge job and version recorded, an earlier material generation, and a 0550 re-proof
--      or a closure observation of THIS generation that still matches the catalogue and write count of
--      earlier generations, lifecycle.raw_active_source_closed):
--        - capture_raw_source_inventory (cloned to capture_raw_source_inventory_before_active_closure
--          and wrapped): for such a source it seals nothing and changes nothing; it rechecks the hold,
--          the closed source at its version, the organization admission and that every document and
--          writer of the source is catalogued (0516's RAW_INVENTORY_INCOMPLETE), then answers more=false.
--          Any other source keeps the previous definition unchanged.
--        - raw_document_writers_ready (cloned to raw_document_writers_ready_before_active_closure and
--          wrapped): also true for a catalogued document of such a source when every writer of it
--          concluded (a write of this generation with this auth generation) and every writer header
--          settled on a concluded write (lifecycle.raw_active_closure_document_ready). This is what
--          lets 0516's own raw_document_delete_target, raw branch of object_delete_absent and
--          raw_document_material_complete (the header delete guard) admit and prove the deletion of
--          each object, of every generation, through the unchanged claim, DELETE, terminal outcome and
--          independent physical-absence check.
--        - raw_source_inventory_complete (cloned to raw_source_inventory_complete_before_active_closure
--          and wrapped): also true for such a source once every catalogued object's deletion is proven
--          in this generation, no claim is unresolved, every writer concluded and no document or writer
--          header remains (lifecycle.raw_active_closure_complete). The purge completion guard, the
--          person's status view, the completion sweep (reconcile_raw_source_completions, exact-text
--          rewrite, count 1) and the tenant erasure witness (raw_tenant_inventory_complete, exact-text
--          rewrite, count 3) accept it through that one predicate.
--        - 0547's raw_restore_survivor_claim now also requires the inventory sealed (exact-text rewrite,
--          count 1), which 0547's survivor branch of object_delete_absent always required anyway
--          (raw_restore_survivor_ready). A claim on a never-sealed inventory therefore reaches 0516's raw
--          branch above instead of a branch that could never prove it.
--      Like every restore proof this is bound to the current material generation: a later restore
--      reopens the debt, and a closed source cannot be re-proven (0550's re-proof needs it active).
--  (ii) An active restore-debt source with a missing or changed object could not be re-proven (0550
--      refuses), so it could not be revoked either. lifecycle.record_raw_restore_active_source_closure
--      (service-only, opening with 0549's refusal) records, for the current generation, what the trusted
--      runtime observed of every catalogued object of an earlier generation: present with its hash and
--      size (matching or changed), or physically absent by the store's own check. It refuses unless at
--      least one object is absent or changed (0550's re-proof is the path for an unchanged source), and
--      under every other condition of 0550's re-proof (restore admitted, organization marker
--      requalified, active never-sealed debt, writers concluded, no unresolved claim). The row
--      (lifecycle.raw_active_source_closure_observations, append-only, forced RLS, no runtime grant)
--      lets the revoke transition above keep the inventory in restore_debt, and the purge then deletes
--      whatever is at each key through (i). It is never a write: no write predicate reads it, so a
--      new version of that source stays refused (RAW_LEGACY_WRITER_UNCONFIRMED).
--  (iii) 0523's lifecycle.record_raw_supersede still required an 'open' inventory of this generation,
--      so an upload of a requalified source whose admitted PUT lost its response could never be
--      retried. Exactly that inventory check (count 1) also accepts a restore_debt inventory under the
--      corrected raw_active_source_requalified above. Every other 0523 check is unchanged.
-- Nothing is cleared, rewritten or deleted; guard_raw_inventory_change is unchanged; no runtime role
-- gains a table privilege. Only ensemus_app gains EXECUTE on the one new service-only entry point.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regclass('lifecycle.raw_source_inventories') IS NULL OR to_regclass('lifecycle.raw_object_writes') IS NULL
  OR to_regclass('lifecycle.object_deletion_claims') IS NULL OR to_regclass('lifecycle.raw_active_source_requalifications') IS NULL
  OR to_regprocedure('lifecycle.raw_active_source_requalified(uuid,uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_active_restore_requalification_documents(uuid)') IS NULL
  OR to_regprocedure('lifecycle.requalify_raw_restore_active_source(uuid,uuid[],text[],bigint[])') IS NULL
  OR to_regprocedure('lifecycle.record_raw_native_birth()') IS NULL
  OR to_regprocedure('lifecycle.record_raw_supersede()') IS NULL
  OR to_regprocedure('lifecycle.admit_raw_put(uuid,uuid,bigint)') IS NULL
  OR to_regprocedure('lifecycle.capture_raw_source_inventory(uuid,bigint,uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_document_writers_ready(uuid,uuid,uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_document_material_complete(uuid,uuid,uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_source_inventory_complete(uuid,bigint,uuid,uuid,uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_source_inventory_complete_before_requalify(uuid,bigint,uuid,uuid,uuid)') IS NULL
  OR to_regprocedure('lifecycle.reconcile_raw_source_completions(uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_tenant_inventory_complete()') IS NULL
  OR to_regprocedure('lifecycle.raw_restore_survivor_claim(uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_metadata_scope(uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_org_native_admission(uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_org_restore_requalified(uuid,integer)') IS NULL
  OR to_regprocedure('lifecycle.current_tenant_material_generation()') IS NULL
  OR to_regprocedure('lifecycle.source_projection_hold_free(uuid,bigint,uuid)') IS NULL
  OR to_regprocedure('knowledge.is_service_actor()') IS NULL
  OR to_regprocedure('app.current_auth_restore_generation()') IS NULL
  OR to_regprocedure('ai.current_material_restore_generation()') IS NULL
  OR to_regprocedure('app.reject_change()') IS NULL
  OR lifecycle.retained_table('lifecycle','raw_active_source_closure_observations') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE lifecycle.raw_active_source_closure_observations(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),source_id uuid NOT NULL,
 document_ids uuid[] NOT NULL,absent_document_ids uuid[] NOT NULL,changed_document_ids uuid[] NOT NULL,
 catalog_sha256 text NOT NULL CHECK(catalog_sha256 ~ '^[0-9a-f]{64}$'),
 observation_sha256 text NOT NULL CHECK(observation_sha256 ~ '^[0-9a-f]{64}$'),
 prior_write_count bigint NOT NULL CHECK(prior_write_count>=0),
 prior_material_restore_generation uuid NOT NULL,material_restore_generation uuid NOT NULL,auth_restore_generation uuid NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,source_id,material_restore_generation),
 CONSTRAINT raw_active_source_closure_generation CHECK(prior_material_restore_generation<>material_restore_generation),
 CONSTRAINT raw_active_source_closure_documents CHECK(array_position(document_ids,NULL) IS NULL
  AND array_position(absent_document_ids,NULL) IS NULL AND array_position(changed_document_ids,NULL) IS NULL
  AND cardinality(document_ids)<=prior_write_count
  AND cardinality(absent_document_ids)+cardinality(changed_document_ids)>=1
  AND absent_document_ids<@document_ids AND changed_document_ids<@document_ids
  AND NOT(absent_document_ids&&changed_document_ids))
);
ALTER TABLE lifecycle.raw_active_source_closure_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.raw_active_source_closure_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY raw_active_source_closure_owner ON lifecycle.raw_active_source_closure_observations TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(lifecycle.raw_metadata_scope(organization_id));
REVOKE ALL ON lifecycle.raw_active_source_closure_observations FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE TRIGGER raw_active_source_closure_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.raw_active_source_closure_observations
 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- Finding 1. 0550's write predicate, with the closure conditions it lacked: no purge job recorded on
-- the inventory or existing for the source, and the source still active. Read inside the raw
-- metadata scope by the writer branch of record_raw_native_birth, admit_raw_put and (below)
-- record_raw_supersede only. The closure observation is never read here: it is not a write proof.
CREATE OR REPLACE FUNCTION lifecycle.raw_active_source_requalified(p_source uuid,p_material uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_source IS NOT NULL AND p_material IS NOT NULL
  AND lifecycle.raw_org_restore_requalified(p_material,1)
  AND EXISTS(SELECT 1 FROM lifecycle.raw_active_source_requalifications q JOIN lifecycle.raw_source_inventories i
    ON i.organization_id=q.organization_id AND i.scope_kind='source' AND i.source_id=q.source_id
   WHERE q.organization_id=app.current_organization_id() AND q.source_id=p_source AND q.material_restore_generation=p_material
    AND i.protocol_version=1 AND i.state='restore_debt' AND i.sealed_at IS NULL AND i.capture_sha256 IS NULL
    AND i.purge_job_id IS NULL AND i.source_version IS NULL
    AND i.material_restore_generation=q.prior_material_restore_generation
    AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=q.organization_id AND s.id=p_source AND s.state='active')
    AND NOT EXISTS(SELECT 1 FROM knowledge.purge_jobs j WHERE j.organization_id=q.organization_id AND j.source_id=p_source)
    AND q.prior_write_count=(SELECT count(*) FROM lifecycle.raw_object_writes w WHERE w.organization_id=q.organization_id
     AND w.source_id=p_source AND w.material_restore_generation<>p_material)
    AND q.document_ids=coalesce((SELECT array_agg(w.document_id ORDER BY w.document_id) FROM lifecycle.raw_object_writes w
     WHERE w.organization_id=q.organization_id AND w.source_id=p_source AND w.generation=0 AND w.material_restore_generation<>p_material),'{}'::uuid[])),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_active_source_requalified(uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

-- Whether a proof of p_material still pins what p_prior left of one source: a 0550 re-proof or a
-- closure observation, each with the same catalogue and write count of earlier generations (which
-- nothing can add to after a rotation), and the organization marker requalified at protocol 1.
CREATE FUNCTION lifecycle.raw_active_source_proof_pinned(p_source uuid,p_prior uuid,p_material uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_source IS NOT NULL AND p_prior IS NOT NULL
  AND p_material IS NOT NULL AND p_prior<>p_material
  AND lifecycle.raw_org_restore_requalified(p_material,1)
  AND EXISTS(SELECT 1 FROM(
    SELECT q.document_ids,q.prior_write_count FROM lifecycle.raw_active_source_requalifications q
     WHERE q.organization_id=app.current_organization_id() AND q.source_id=p_source
      AND q.material_restore_generation=p_material AND q.prior_material_restore_generation=p_prior
    UNION ALL
    SELECT e.document_ids,e.prior_write_count FROM lifecycle.raw_active_source_closure_observations e
     WHERE e.organization_id=app.current_organization_id() AND e.source_id=p_source
      AND e.material_restore_generation=p_material AND e.prior_material_restore_generation=p_prior) proof
   WHERE proof.prior_write_count=(SELECT count(*) FROM lifecycle.raw_object_writes w WHERE w.organization_id=app.current_organization_id()
     AND w.source_id=p_source AND w.material_restore_generation<>p_material)
    AND proof.document_ids=coalesce((SELECT array_agg(w.document_id ORDER BY w.document_id) FROM lifecycle.raw_object_writes w
     WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source AND w.generation=0
      AND w.material_restore_generation<>p_material),'{}'::uuid[])),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_active_source_proof_pinned(uuid,uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

-- The revoke transition's question: may the purge job p_job, being born now, close this source while
-- its inventory stays restore debt? Only when the source is closed, p_job is its only purge job, and
-- the inventory is the never-sealed, never-closed debt that a matching proof of p_material covers.
CREATE FUNCTION lifecycle.raw_active_source_closable(p_source uuid,p_job uuid,p_material uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_source IS NOT NULL AND p_job IS NOT NULL
  AND p_material IS NOT NULL
  AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=app.current_organization_id() AND s.id=p_source
   AND s.state IN('revoked','deleted'))
  AND EXISTS(SELECT 1 FROM knowledge.purge_jobs j WHERE j.organization_id=app.current_organization_id() AND j.id=p_job AND j.source_id=p_source)
  AND NOT EXISTS(SELECT 1 FROM knowledge.purge_jobs j WHERE j.organization_id=app.current_organization_id() AND j.source_id=p_source AND j.id<>p_job)
  AND EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=app.current_organization_id()
   AND i.scope_kind='source' AND i.source_id=p_source AND i.protocol_version=1 AND i.state='restore_debt'
   AND i.sealed_at IS NULL AND i.capture_sha256 IS NULL AND i.purge_job_id IS NULL AND i.source_version IS NULL
   AND i.material_restore_generation<>p_material
   AND lifecycle.raw_active_source_proof_pinned(p_source,i.material_restore_generation,p_material)),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_active_source_closable(uuid,uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

-- Closed active-source debt: the inventory the revoke transition above kept in restore_debt, at this
-- exact purge job and source version, still pinned by a proof of p_material.
CREATE FUNCTION lifecycle.raw_active_source_closed(p_source uuid,p_version bigint,p_job uuid,p_material uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_source IS NOT NULL AND p_version IS NOT NULL
  AND p_job IS NOT NULL AND p_material IS NOT NULL
  AND EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=app.current_organization_id()
   AND i.scope_kind='source' AND i.source_id=p_source AND i.protocol_version=1 AND i.state='restore_debt'
   AND i.sealed_at IS NULL AND i.capture_sha256 IS NULL AND i.purge_job_id=p_job AND i.source_version=p_version
   AND i.material_restore_generation<>p_material
   AND lifecycle.raw_active_source_proof_pinned(p_source,i.material_restore_generation,p_material)),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_active_source_closed(uuid,bigint,uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

-- 0516's per-document writer readiness for a document of closed active-source debt: catalogued in that
-- source, written by no other source, every write of it concluded (one of this generation with this
-- auth generation), every writer header settled on a concluded write, and the organization admitted.
CREATE FUNCTION lifecycle.raw_active_closure_document_ready(p_document uuid,p_material uuid,p_auth uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_document IS NOT NULL AND p_material IS NOT NULL
  AND p_auth IS NOT NULL AND lifecycle.raw_org_native_admission(p_material)
  AND EXISTS(SELECT 1 FROM lifecycle.raw_object_writes c JOIN lifecycle.raw_source_inventories i
    ON i.organization_id=c.organization_id AND i.scope_kind='source' AND i.source_id=c.source_id
   WHERE c.organization_id=app.current_organization_id() AND c.document_id=p_document AND c.generation=0 AND c.state='catalog'
    AND c.object_key=app.current_organization_id()::text||'/knowledge/'||p_document::text
    AND lifecycle.raw_active_source_closed(c.source_id,i.source_version,i.purge_job_id,p_material)
    AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes other WHERE other.organization_id=c.organization_id
     AND other.document_id=p_document AND other.source_id<>c.source_id))
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=app.current_organization_id()
   AND w.document_id=p_document AND w.generation>0
   AND(w.state NOT IN('finished','not_dispatched') OR w.finished_at IS NULL
    OR(w.state='finished' AND(w.put_token_sha256 IS NULL OR w.admitted_at IS NULL))
    OR(w.state='not_dispatched' AND(w.put_token_sha256 IS NOT NULL OR w.admitted_at IS NOT NULL))
    OR(w.material_restore_generation=p_material AND w.put_auth_restore_generation IS DISTINCT FROM p_auth)))
  AND NOT EXISTS(SELECT 1 FROM knowledge.object_writers a WHERE a.organization_id=app.current_organization_id() AND a.document_id=p_document
   AND(a.state<>'settled' OR NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=a.organization_id
    AND w.document_id=a.document_id AND w.source_id=a.source_id AND w.write_id=a.write_id AND w.generation=a.generation
    AND w.state IN('finished','not_dispatched')))),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_active_closure_document_ready(uuid,uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
--> statement-breakpoint

-- 0516's per-document readiness keeps its whole definition and also accepts such a document.
DO $$ DECLARE definition text;header text:='CREATE OR REPLACE FUNCTION lifecycle.raw_document_writers_ready(';BEGIN
 definition:=pg_get_functiondef('lifecycle.raw_document_writers_ready(uuid,uuid,uuid)'::regprocedure);
 IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.raw_document_writers_ready_before_active_closure(');
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_document_writers_ready_before_active_closure(uuid,uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE OR REPLACE FUNCTION lifecycle.raw_document_writers_ready(p_document uuid,p_material uuid,p_auth uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT lifecycle.raw_document_writers_ready_before_active_closure(p_document,p_material,p_auth)
  OR coalesce(lifecycle.raw_active_closure_document_ready(p_document,p_material,p_auth),false)
$$;
--> statement-breakpoint

-- Whether the purge of closed active-source debt is complete in p_material: every catalogued object,
-- of every generation, has its deletion proven in this generation (0516's raw_document_material_complete,
-- through the readiness above), no claim on them is unresolved, every write concluded, and no document
-- or writer header of the source remains.
CREATE FUNCTION lifecycle.raw_active_closure_complete(p_source uuid,p_version bigint,p_job uuid,p_material uuid,p_auth uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_auth IS NOT NULL
  AND lifecycle.raw_org_native_admission(p_material)
  AND lifecycle.raw_active_source_closed(p_source,p_version,p_job,p_material)
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source
   AND w.generation>0 AND(w.state NOT IN('finished','not_dispatched') OR w.finished_at IS NULL
    OR(w.material_restore_generation=p_material AND w.put_auth_restore_generation IS DISTINCT FROM p_auth)))
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source
   AND w.generation=0 AND lifecycle.raw_document_material_complete(w.document_id,p_material,p_auth) IS NOT TRUE)
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w JOIN lifecycle.object_deletion_claims c
    ON c.organization_id=w.organization_id AND c.object_key=w.object_key
   WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source AND w.generation=0 AND c.state<>'proven')
  AND NOT EXISTS(SELECT 1 FROM knowledge.documents d WHERE d.organization_id=app.current_organization_id() AND d.source_id=p_source)
  AND NOT EXISTS(SELECT 1 FROM knowledge.object_writers w WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_active_closure_complete(uuid,bigint,uuid,uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

-- The per-source inventory predicate (0516, as 0543 wrapped it) keeps its whole definition and also
-- accepts a completed purge of closed active-source debt. Its callers keep their own checks.
DO $$ DECLARE definition text;header text:='CREATE OR REPLACE FUNCTION lifecycle.raw_source_inventory_complete(';BEGIN
 definition:=pg_get_functiondef('lifecycle.raw_source_inventory_complete(uuid,bigint,uuid,uuid,uuid)'::regprocedure);
 IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.raw_source_inventory_complete_before_active_closure(');
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_source_inventory_complete_before_active_closure(uuid,bigint,uuid,uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE OR REPLACE FUNCTION lifecycle.raw_source_inventory_complete(p_source uuid,p_version bigint,p_job uuid,p_material uuid,p_auth uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT lifecycle.raw_source_inventory_complete_before_active_closure(p_source,p_version,p_job,p_material,p_auth)
  OR coalesce(p_auth IS NOT NULL AND lifecycle.raw_active_closure_complete(p_source,p_version,p_job,p_material,p_auth),false)
$$;
--> statement-breakpoint

-- 0516's capture keeps its whole definition for every other source. Closed active-source debt has no
-- capture to take (its inventory can never be sealed, and the proof that pins it is the 0550 re-proof
-- or closure observation): after 0516's own hold, closed-source, admission and catalogue checks it
-- answers that nothing more is to be captured, and changes nothing.
DO $$ DECLARE definition text;header text:='CREATE OR REPLACE FUNCTION lifecycle.capture_raw_source_inventory(';BEGIN
 definition:=pg_get_functiondef('lifecycle.capture_raw_source_inventory(uuid,bigint,uuid)'::regprocedure);
 IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.capture_raw_source_inventory_before_active_closure(');
END $$;
REVOKE ALL ON FUNCTION lifecycle.capture_raw_source_inventory_before_active_closure(uuid,bigint,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE OR REPLACE FUNCTION lifecycle.capture_raw_source_inventory(p_source uuid,p_version bigint,p_job uuid)
 RETURNS TABLE(more boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 material uuid;closed boolean:=false;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN RAISE EXCEPTION 'RAW_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM app.current_auth_restore_generation();material:=ai.current_material_restore_generation();
 IF material IS NOT NULL AND p_source IS NOT NULL AND p_version IS NOT NULL AND p_job IS NOT NULL THEN
  PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
  closed:=coalesce(lifecycle.raw_active_source_closed(p_source,p_version,p_job,material),false);
  PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);
 END IF;
 IF NOT closed THEN
  RETURN QUERY SELECT * FROM lifecycle.capture_raw_source_inventory_before_active_closure(p_source,p_version,p_job);RETURN;END IF;
 IF lifecycle.source_projection_hold_free(p_source,p_version,p_job) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'RAW_SOURCE_HOLD_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 PERFORM x.id FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant AND x.scope_kind='source' AND x.source_id=p_source FOR UPDATE NOWAIT;
 IF lifecycle.raw_active_source_closed(p_source,p_version,p_job,material) IS NOT TRUE
  OR lifecycle.raw_org_native_admission(material) IS DISTINCT FROM true
  OR NOT EXISTS(SELECT 1 FROM knowledge.sources x WHERE x.organization_id=tenant AND x.id=p_source AND x.state IN('revoked','deleted') AND x.version=p_version)
  OR NOT EXISTS(SELECT 1 FROM knowledge.purge_jobs x WHERE x.organization_id=tenant AND x.id=p_job AND x.source_id=p_source) THEN
  RAISE EXCEPTION 'RAW_LEGACY_INVENTORY_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 IF EXISTS(SELECT 1 FROM knowledge.documents d WHERE d.organization_id=tenant AND d.source_id=p_source AND NOT EXISTS(
   SELECT 1 FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=d.id AND x.source_id=p_source AND x.generation=0
    AND x.content_sha256=d.content_sha256 AND x.size_bytes=d.size_bytes))
  OR EXISTS(SELECT 1 FROM knowledge.object_writers a WHERE a.organization_id=tenant AND a.source_id=p_source AND NOT EXISTS(
   SELECT 1 FROM lifecycle.raw_object_writes x WHERE x.organization_id=tenant AND x.document_id=a.document_id AND x.write_id=a.write_id
    AND x.generation=a.generation AND x.source_id=p_source)) THEN
  RAISE EXCEPTION 'RAW_INVENTORY_INCOMPLETE' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);
 RETURN QUERY SELECT false;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
--> statement-breakpoint

-- Finding 4 (ii): what the trusted runtime observed of an active debt source it cannot re-prove. Every
-- catalogued object of an earlier generation is named exactly once: present with the hash and size it
-- read (matching its catalog row and live header, or changed), or absent by the store's own
-- physical-absence check. Evidence only, never a write or a deletion.
CREATE FUNCTION lifecycle.record_raw_restore_active_source_closure(p_source uuid,p_documents uuid[],p_sha256 text[],p_sizes bigint[],p_absent uuid[]) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 material uuid;auth uuid;s record;i record;prior record;catalog uuid[];catalog_digest text;observation_digest text;writes bigint;
 absent_ids uuid[];changed_ids uuid[];
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_source IS NULL
  OR p_documents IS NULL OR p_sha256 IS NULL OR p_sizes IS NULL OR p_absent IS NULL THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_CLOSURE_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 -- Raises RESTORE_PENDING until the restore was reviewed and admitted.
 auth:=app.current_auth_restore_generation();
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 -- Source -> organization, the 0516 order. Never wait.
 SELECT x.id,x.state INTO s FROM knowledge.sources x WHERE x.organization_id=tenant AND x.id=p_source FOR SHARE NOWAIT;
 IF s.id IS NULL OR s.state<>'active' THEN RAISE EXCEPTION 'RAW_ACTIVE_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'RAW_TENANT_REQUIRED' USING ERRCODE='EN850';END IF;
 material:=lifecycle.current_tenant_material_generation();
 IF auth IS NULL OR material IS NULL THEN RAISE EXCEPTION 'RAW_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 -- The tenant's marker first (0545), as 0550's re-proof requires.
 IF lifecycle.raw_org_restore_requalified(material,1) IS NOT TRUE THEN
  RAISE EXCEPTION 'RAW_ORG_RESTORE_REQUALIFICATION_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT x.* INTO i FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant AND x.scope_kind='source' AND x.source_id=p_source;
 -- Only debt a restore left on a source still open: protocol 1, never sealed, never closed, earlier generation.
 IF i.id IS NULL OR i.protocol_version<>1 OR i.state<>'restore_debt' OR i.material_restore_generation=material
  OR i.sealed_at IS NOT NULL OR i.capture_sha256 IS NOT NULL OR i.purge_job_id IS NOT NULL OR i.source_version IS NOT NULL
  OR EXISTS(SELECT 1 FROM knowledge.purge_jobs j WHERE j.organization_id=tenant AND j.source_id=p_source) THEN
  RAISE EXCEPTION 'RAW_RESTORE_DEBT_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT coalesce(array_agg(w.document_id ORDER BY w.document_id),'{}'::uuid[]),
  encode(sha256(convert_to(coalesce(string_agg(w.document_id::text||':'||w.content_sha256||':'||w.size_bytes::text,',' ORDER BY w.document_id),''),'UTF8')),'hex')
  INTO catalog,catalog_digest FROM lifecycle.raw_object_writes w
  WHERE w.organization_id=tenant AND w.source_id=p_source AND w.generation=0 AND w.material_restore_generation<>material;
 SELECT count(*) INTO writes FROM lifecycle.raw_object_writes w
  WHERE w.organization_id=tenant AND w.source_id=p_source AND w.material_restore_generation<>material;
 -- Exactly the catalogued objects of earlier generations, each named once as present (with a hash and
 -- size) or absent; every writer of the source concluded; no deletion claim unresolved.
 IF coalesce(array_ndims(p_documents),1)<>1 OR coalesce(array_ndims(p_sha256),1)<>1 OR coalesce(array_ndims(p_sizes),1)<>1
  OR coalesce(array_ndims(p_absent),1)<>1
  OR cardinality(p_sha256)<>cardinality(p_documents) OR cardinality(p_sizes)<>cardinality(p_documents)
  OR cardinality(p_documents)+cardinality(p_absent)<>cardinality(catalog)
  OR array_position(p_documents,NULL) IS NOT NULL OR array_position(p_sha256,NULL) IS NOT NULL
  OR array_position(p_sizes,NULL) IS NOT NULL OR array_position(p_absent,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(p_sha256) h(value) WHERE h.value !~ '^[0-9a-f]{64}$')
  OR EXISTS(SELECT 1 FROM unnest(p_sizes) z(value) WHERE z.value<0)
  OR(SELECT coalesce(array_agg(x.value ORDER BY x.value),'{}'::uuid[]) FROM(SELECT DISTINCT unnest(p_documents||p_absent) AS value) x) IS DISTINCT FROM catalog
  OR EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.source_id=p_source
   AND w.generation>0 AND(w.state NOT IN('finished','not_dispatched') OR w.finished_at IS NULL))
  OR EXISTS(SELECT 1 FROM knowledge.object_writers w WHERE w.organization_id=tenant AND w.source_id=p_source AND w.state<>'settled')
  OR EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w JOIN lifecycle.object_deletion_claims c
    ON c.organization_id=w.organization_id AND c.object_key=w.object_key
   WHERE w.organization_id=tenant AND w.source_id=p_source AND w.generation=0 AND c.state<>'proven') THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_CLOSURE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 -- A present object is unchanged only when it matches its catalog row and its live header exactly.
 SELECT coalesce(array_agg(o.document_id ORDER BY o.document_id),'{}'::uuid[]) INTO changed_ids
  FROM unnest(p_documents,p_sha256,p_sizes) o(document_id,sha256,size_bytes) WHERE NOT EXISTS(
   SELECT 1 FROM lifecycle.raw_object_writes c JOIN knowledge.documents d
     ON d.organization_id=c.organization_id AND d.id=c.document_id AND d.source_id=c.source_id
    WHERE c.organization_id=tenant AND c.source_id=p_source AND c.generation=0 AND c.state='catalog'
     AND c.material_restore_generation<>material AND c.document_id=o.document_id
     AND c.content_sha256=o.sha256 AND c.size_bytes=o.size_bytes AND d.content_sha256=o.sha256 AND d.size_bytes=o.size_bytes);
 SELECT coalesce(array_agg(a.value ORDER BY a.value),'{}'::uuid[]) INTO absent_ids FROM unnest(p_absent) a(value);
 -- Every object present and unchanged is 0550's re-proof, never a closure without one.
 IF cardinality(absent_ids)+cardinality(changed_ids)=0 THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_REQUALIFICATION_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT encode(sha256(convert_to(coalesce(string_agg(n.line,',' ORDER BY n.document_id),''),'UTF8')),'hex') INTO observation_digest
  FROM(SELECT o.document_id,o.document_id::text||':present:'||o.sha256||':'||o.size_bytes::text AS line
    FROM unnest(p_documents,p_sha256,p_sizes) o(document_id,sha256,size_bytes)
   UNION ALL SELECT a.value,a.value::text||':absent' FROM unnest(p_absent) a(value)) n;
 SELECT q.* INTO prior FROM lifecycle.raw_active_source_closure_observations q
  WHERE q.organization_id=tenant AND q.source_id=p_source AND q.material_restore_generation=material;
 IF prior.source_id IS NULL THEN
  INSERT INTO lifecycle.raw_active_source_closure_observations(organization_id,source_id,document_ids,absent_document_ids,changed_document_ids,
   catalog_sha256,observation_sha256,prior_write_count,prior_material_restore_generation,material_restore_generation,auth_restore_generation)
   VALUES(tenant,p_source,catalog,absent_ids,changed_ids,catalog_digest,observation_digest,writes,i.material_restore_generation,material,auth);
 ELSIF prior.document_ids IS DISTINCT FROM catalog OR prior.catalog_sha256 IS DISTINCT FROM catalog_digest
  OR prior.observation_sha256 IS DISTINCT FROM observation_digest OR prior.prior_write_count IS DISTINCT FROM writes
  OR prior.prior_material_restore_generation IS DISTINCT FROM i.material_restore_generation THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_CLOSURE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN 'recorded';
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.record_raw_restore_active_source_closure(uuid,uuid[],text[],bigint[],uuid[])
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
GRANT EXECUTE ON FUNCTION lifecycle.record_raw_restore_active_source_closure(uuid,uuid[],text[],bigint[],uuid[]) TO ensemus_app;
--> statement-breakpoint

-- 0516's birth trigger, as 0545 and 0550 left it. Exactly one text changes, found exactly once: the
-- revoke transition reads the closure question instead of 0550's write predicate. The writer branch
-- keeps reading raw_active_source_requalified, now corrected above.
DO $$ DECLARE definition text;
 needle text:='lifecycle.raw_active_source_requalified(NEW.source_id,material) IS TRUE THEN ''restore_debt''';
 replacement text:='lifecycle.raw_active_source_closable(NEW.source_id,NEW.id,material) IS TRUE THEN ''restore_debt''';
BEGIN
 definition:=pg_get_functiondef('lifecycle.record_raw_native_birth()'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.record_raw_native_birth(')<>1
  OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1
  OR (length(definition)-length(replace(definition,'lifecycle.raw_active_source_requalified(NEW.source_id,material)','')))
   /length('lifecycle.raw_active_source_requalified(NEW.source_id,material)')<>2
  OR strpos(definition,'WHEN native THEN ''capturing'' WHEN source_scope.protocol_version=1 AND source_scope.state=''restore_debt'' AND source_scope.purge_job_id IS NULL AND ')=0 THEN
  RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,needle,replacement);
END $$;
--> statement-breakpoint

-- 0523's supersede: exactly its inventory check also accepts a requalified active source, under the
-- corrected predicate. The prior write and the new one stay of the current generation, as before.
DO $$ DECLARE definition text;
 needle text:='OR source_scope.state<>''open'' OR source_scope.material_restore_generation IS DISTINCT FROM material';
 replacement text:='OR NOT coalesce((source_scope.state=''open'' AND source_scope.material_restore_generation=material) OR(source_scope.state=''restore_debt'' AND lifecycle.raw_active_source_requalified(NEW.source_id,material) IS TRUE),false)';
BEGIN
 definition:=pg_get_functiondef('lifecycle.record_raw_supersede()'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.record_raw_supersede(')<>1
  OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,needle,replacement);
END $$;
--> statement-breakpoint

-- 0547's survivor-claim routing also requires the inventory sealed, as its survivor branch always did.
DO $$ DECLARE definition text;
 needle text:='AND i.state=''restore_debt'' AND i.material_restore_generation<>material';
 replacement text:='AND i.state=''restore_debt'' AND i.material_restore_generation<>material AND i.sealed_at IS NOT NULL';
BEGIN
 definition:=pg_get_functiondef('lifecycle.raw_restore_survivor_claim(uuid)'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.raw_restore_survivor_claim(')<>1
  OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,needle,replacement);
END $$;
--> statement-breakpoint

-- The completion sweep (0516, as 0543 rewrote it) does not demote a completion of closed active-source
-- debt that is still complete in this generation.
DO $$ DECLARE definition text;
 needle text:='AND lifecycle.raw_source_requalified(x.source_id,i.source_version,x.id,material) IS NOT TRUE)';
 replacement text:='AND lifecycle.raw_source_requalified(x.source_id,i.source_version,x.id,material) IS NOT TRUE AND lifecycle.raw_active_closure_complete(x.source_id,i.source_version,x.id,material,app.current_auth_restore_generation()) IS NOT TRUE)';
BEGIN
 definition:=pg_get_functiondef('lifecycle.reconcile_raw_source_completions(uuid)'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.reconcile_raw_source_completions(')<>1
  OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,needle,replacement);
END $$;
--> statement-breakpoint

-- The tenant erasure witness (0545): wherever a restore-debt source is accepted through 0543's proof,
-- a completed purge of closed active-source debt is accepted too. Exactly three places.
DO $$ DECLARE definition text;
 needle text:='lifecycle.raw_source_requalified(i.source_id,i.source_version,i.purge_job_id,material) IS TRUE';
 replacement text:='(lifecycle.raw_source_requalified(i.source_id,i.source_version,i.purge_job_id,material) IS TRUE OR lifecycle.raw_active_closure_complete(i.source_id,i.source_version,i.purge_job_id,material,auth) IS TRUE)';
BEGIN
 definition:=pg_get_functiondef('lifecycle.raw_tenant_inventory_complete()'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.raw_tenant_inventory_complete(')<>1
  OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>3
  OR strpos(definition,'lifecycle.raw_active_closure_complete(')>0 THEN
  RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,needle,replacement);
END $$;
--> statement-breakpoint

-- Postconditions: the new table keeps forced RLS and no runtime privilege; every new predicate and
-- clone has no runtime access; the three service-only entry points of 0550 and 0551 are SECURITY
-- DEFINER, granted directly to ensemus_app alone (ensemus_agent inherits it by membership, see 0545's
-- note, so each must refuse it itself) and open with the session_user refusal in 0549's exact form;
-- the corrected predicate carries its closure conditions; every rewritten or wrapped function carries
-- its new text exactly where intended and keeps its ACL.
DO $$ DECLARE opening text:='^[[:space:]]*DECLARE[[:space:]]+tenant uuid:=app\.current_organization_id\(\);'
  ||'([[:space:]]*previous text:=current_setting\(''lifecycle\.raw_object_org'',true\);)?'
  ||'([[:space:]]*[a-z_][a-z0-9_]* (uuid|text|record|jsonb|boolean|bigint|integer)(\[\])?;)*'
  ||'[[:space:]]*BEGIN[[:space:]]+IF session_user<>''ensemus_app'' OR NOT knowledge\.is_service_actor\(\) OR tenant IS NULL'
  ||'([[:space:]]+OR[[:space:]]+(p_[a-z0-9_]+ IS NULL|p_observed NOT IN\(''present'',''absent''\)))*'
  ||'[[:space:]]+THEN[[:space:]]+RAISE EXCEPTION ''[A-Z0-9_]+'' USING ERRCODE=''42501'';[[:space:]]*END IF;';
 internal text[]:=ARRAY['lifecycle.raw_active_source_requalified(uuid,uuid)','lifecycle.raw_active_source_proof_pinned(uuid,uuid,uuid)',
  'lifecycle.raw_active_source_closable(uuid,uuid,uuid)','lifecycle.raw_active_source_closed(uuid,bigint,uuid,uuid)',
  'lifecycle.raw_active_closure_document_ready(uuid,uuid,uuid)','lifecycle.raw_active_closure_complete(uuid,bigint,uuid,uuid,uuid)',
  'lifecycle.raw_document_writers_ready_before_active_closure(uuid,uuid,uuid)',
  'lifecycle.raw_source_inventory_complete_before_active_closure(uuid,bigint,uuid,uuid,uuid)',
  'lifecycle.capture_raw_source_inventory_before_active_closure(uuid,bigint,uuid)'];
 entries text[]:=ARRAY['lifecycle.raw_active_restore_requalification_documents(uuid)',
  'lifecycle.requalify_raw_restore_active_source(uuid,uuid[],text[],bigint[])',
  'lifecycle.record_raw_restore_active_source_closure(uuid,uuid[],text[],bigint[],uuid[])'];
 failed text;
BEGIN
 SELECT string_agg(f.signature,',' ORDER BY f.signature) INTO failed FROM unnest(internal) f(signature)
  WHERE to_regprocedure(f.signature) IS NULL
   OR has_function_privilege('ensemus_app',f.signature,'EXECUTE') OR has_function_privilege('ensemus_agent',f.signature,'EXECUTE')
   OR has_function_privilege('ensemus_eraser',f.signature,'EXECUTE') OR has_function_privilege('ensemus_auth',f.signature,'EXECUTE')
   OR has_function_privilege('ensemus_dispatcher',f.signature,'EXECUTE') OR has_function_privilege('ensemus_secrets',f.signature,'EXECUTE');
 IF failed IS NULL THEN
  SELECT string_agg(f.signature,',' ORDER BY f.signature) INTO failed FROM unnest(entries) f(signature)
   WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(f.signature)
     AND p.prolang=(SELECT l.oid FROM pg_language l WHERE l.lanname='plpgsql')
     AND p.prosecdef AND p.proowner='ensemus_migrator'::regrole::oid
     AND p.proconfig IS NOT NULL AND 'search_path=pg_catalog'=ANY(p.proconfig) AND p.prosrc ~ opening)
    OR NOT has_function_privilege('ensemus_app',f.signature,'EXECUTE')
    OR has_function_privilege('ensemus_eraser',f.signature,'EXECUTE')
    OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     WHERE p.oid=to_regprocedure(f.signature) AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND a.grantee<>'ensemus_app'::regrole::oid);
 END IF;
 IF failed IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='lifecycle.raw_active_source_closure_observations'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
  OR has_table_privilege('ensemus_app','lifecycle.raw_active_source_closure_observations','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_agent','lifecycle.raw_active_source_closure_observations','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_eraser','lifecycle.raw_active_source_closure_observations','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_auth','lifecycle.raw_active_source_closure_observations','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_dispatcher','lifecycle.raw_active_source_closure_observations','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_secrets','lifecycle.raw_active_source_closure_observations','SELECT,INSERT,UPDATE,DELETE')
  -- Finding 1: the write predicate refuses a closed or closing source.
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.raw_active_source_requalified(uuid,uuid)'::regprocedure
   AND strpos(p.prosrc,'AND i.purge_job_id IS NULL AND i.source_version IS NULL')>0
   AND strpos(p.prosrc,'AND s.state=''active'')')>0
   AND strpos(p.prosrc,'AND NOT EXISTS(SELECT 1 FROM knowledge.purge_jobs j WHERE j.organization_id=q.organization_id AND j.source_id=p_source)')>0
   AND strpos(p.prosrc,'raw_active_source_closure_observations')=0)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.record_raw_native_birth()'::regprocedure AND p.prosecdef
   AND(length(p.prosrc)-length(replace(p.prosrc,'lifecycle.raw_active_source_requalified(NEW.source_id,material)','')))
    /length('lifecycle.raw_active_source_requalified(NEW.source_id,material)')=1
   AND(length(p.prosrc)-length(replace(p.prosrc,'lifecycle.raw_active_source_closable(NEW.source_id,NEW.id,material) IS TRUE THEN ''restore_debt''','')))
    /length('lifecycle.raw_active_source_closable(NEW.source_id,NEW.id,material) IS TRUE THEN ''restore_debt''')=1
   AND strpos(p.prosrc,'source_scope.state=''open'' AND source_scope.material_restore_generation=material)')>0
   AND strpos(p.prosrc,'lifecycle.raw_org_restore_requalified(material,org_scope.protocol_version)')>0)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.admit_raw_put(uuid,uuid,bigint)'::regprocedure AND p.prosecdef
   AND strpos(p.prosrc,'lifecycle.raw_active_source_requalified(w.source_id,material) IS TRUE')>0)
  OR NOT has_function_privilege('ensemus_app','lifecycle.admit_raw_put(uuid,uuid,bigint)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.admit_raw_put(uuid,uuid,bigint)','EXECUTE')
  -- Finding 4 (iii).
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.record_raw_supersede()'::regprocedure AND p.prosecdef
   AND strpos(p.prosrc,'OR(source_scope.state=''restore_debt'' AND lifecycle.raw_active_source_requalified(NEW.source_id,material) IS TRUE),false)')>0
   AND strpos(p.prosrc,'source_scope.state<>''open''')=0)
  -- Finding 4 (i): the wrappers and rewrites, and the ACLs of the public entry points.
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.raw_restore_survivor_claim(uuid)'::regprocedure AND p.prosecdef
   AND strpos(p.prosrc,'AND i.material_restore_generation<>material AND i.sealed_at IS NOT NULL')>0)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.raw_document_writers_ready(uuid,uuid,uuid)'::regprocedure
   AND strpos(p.prosrc,'lifecycle.raw_document_writers_ready_before_active_closure(p_document,p_material,p_auth)')>0
   AND strpos(p.prosrc,'lifecycle.raw_active_closure_document_ready(p_document,p_material,p_auth)')>0)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.raw_source_inventory_complete(uuid,bigint,uuid,uuid,uuid)'::regprocedure
   AND strpos(p.prosrc,'lifecycle.raw_source_inventory_complete_before_active_closure(p_source,p_version,p_job,p_material,p_auth)')>0
   AND strpos(p.prosrc,'lifecycle.raw_active_closure_complete(p_source,p_version,p_job,p_material,p_auth)')>0)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.raw_source_inventory_complete_before_active_closure(uuid,bigint,uuid,uuid,uuid)'::regprocedure
   AND strpos(p.prosrc,'lifecycle.raw_source_inventory_complete_before_requalify(p_source,p_version,p_job,p_material,p_auth)')>0)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.capture_raw_source_inventory(uuid,bigint,uuid)'::regprocedure AND p.prosecdef
   AND strpos(p.prosrc,'lifecycle.capture_raw_source_inventory_before_active_closure(p_source,p_version,p_job)')>0
   AND strpos(p.prosrc,'lifecycle.source_projection_hold_free(p_source,p_version,p_job)')>0)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.capture_raw_source_inventory_before_active_closure(uuid,bigint,uuid)'::regprocedure
   AND p.prosecdef AND strpos(p.prosrc,'RAW_INVENTORY_INCOMPLETE')>0)
  OR NOT has_function_privilege('ensemus_app','lifecycle.capture_raw_source_inventory(uuid,bigint,uuid)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.capture_raw_source_inventory(uuid,bigint,uuid)','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.raw_document_writers_ready(uuid,uuid,uuid)','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.raw_source_inventory_complete(uuid,bigint,uuid,uuid,uuid)','EXECUTE')
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.reconcile_raw_source_completions(uuid)'::regprocedure AND p.prosecdef
   AND strpos(p.prosrc,'lifecycle.raw_active_closure_complete(x.source_id,i.source_version,x.id,material,app.current_auth_restore_generation()) IS NOT TRUE)')>0)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.raw_tenant_inventory_complete()'::regprocedure AND p.prosecdef
   AND(length(p.prosrc)-length(replace(p.prosrc,'lifecycle.raw_active_closure_complete(i.source_id,i.source_version,i.purge_job_id,material,auth) IS TRUE','')))
    /length('lifecycle.raw_active_closure_complete(i.source_id,i.source_version,i.purge_job_id,material,auth) IS TRUE')=3) THEN
  RAISE EXCEPTION 'RAW_ACTIVE_CLOSURE_POSTCONDITION' USING ERRCODE='EN850',DETAIL=coalesce(failed,'');END IF;
END $$;
