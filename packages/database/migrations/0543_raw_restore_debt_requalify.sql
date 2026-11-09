-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.
-- 0543 (r5 restore debt): the requalification path the ADR-026 restore model implies for restore
-- debt that 0508 and 0516 record and nothing could ever leave. Additive: 0508, 0516, 0520, 0539 and
-- 0542 are registered and pushed, so they are not edited.
--
-- Two kinds of restore debt had no way out:
--   * 0508 lifecycle.object_restore_debts: a restored generated file whose deletion the ledger
--     re-applied (knowledge.artifact_lineage.restore_reapply_pending). The debt row is append-only and
--     refuses begin_object_deletion, object_deletion_proven, object_delete_counts and every source
--     purge completion in the tenant (purge_jobs_0508_delete_proof) for ever, and the pending header
--     refuses begin_object_deletion, so the only thing that clears the header (object_delete_absent)
--     can never run. 0508 says it "stays nonqualifying until real restore/provider quiescence
--     authority exists".
--   * 0516 raw source inventories: a material restore rotation (0515, called by 0422 begin) moves
--     every raw inventory to restore_debt, which guard_raw_inventory_change lets no transition leave,
--     with its retained birth generation. raw_source_inventory_complete needs an inventory sealed in
--     the current generation, so no closed source's purge job can complete after any restore.
--
-- The authority that now exists is the restore itself: 0422 begin refuses while any reader or
-- writer role is connected, rotates the material generation in the same transaction, and
-- app.current_auth_restore_generation() answers only once that restore was reviewed and admitted.
-- After it, the operator re-proves each object through the restore tooling
-- (packages/application/src/restore-reconcile.ts): the trusted runtime observes the object key in the
-- store with its physical-absence check, and one service-only call records that proof for that
-- object in the current material generation. Nothing is cleared, rewritten or deleted:
--   * lifecycle.object_restore_requalifications: one row per derived debt object and material
--     generation. The debt stays; it no longer counts as open in that generation. The header stays
--     restore_reapply_pending until the ordinary 0508 lifecycle proves the deletion (claim, DELETE,
--     independent absence), which is the only thing that clears it, under 0210's unchanged guard. A
--     requalified object is admitted to that lifecycle; it is never itself a deletion proof.
--   * lifecycle.raw_restore_requalifications: one row per restore-debt source inventory and material
--     generation, naming every raw object (catalog document) of that inventory as observed absent.
--     raw_source_inventory_complete accepts it only while the retained sealed capture still matches
--     the writes, every writer concluded before the restore, no deletion claim is unresolved and no
--     raw header remains. A present raw object is not requalified (the runtime refuses to call), so
--     its source stays unconfirmed.
-- Both are per object, service-only (ensemus_app with a service actor), idempotent within a
-- generation, bound to the current material generation (a later restore reopens the debt), and have
-- no age, bulk, tenant-wide or role-name clearing. The tables are append-only retained lifecycle
-- evidence with forced RLS and no runtime-role grant.
--
-- The debt readers keep their text: every fixed definition reading
-- "FROM lifecycle.object_restore_debts d WHERE" now reads "FROM lifecycle.open_object_restore_debts() d WHERE",
-- the same rows less those requalified in the current generation. 0508's derived admission keeps
-- refusing a restore-pending header unless that exact object and writer were requalified.
-- reconcile_raw_source_completions no longer demotes a completion whose inventory is requalified.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RESTORE_REQUALIFICATION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regclass('lifecycle.object_restore_debts') IS NULL OR to_regclass('lifecycle.raw_source_inventories') IS NULL
  OR to_regclass('lifecycle.raw_object_writes') IS NULL OR to_regclass('lifecycle.object_deletion_claims') IS NULL
  OR to_regprocedure('lifecycle.begin_object_deletion_before_raw(jsonb)') IS NULL
  OR to_regprocedure('lifecycle.raw_source_inventory_complete(uuid,bigint,uuid,uuid,uuid)') IS NULL
  OR to_regprocedure('lifecycle.reconcile_raw_source_completions(uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_metadata_scope(uuid)') IS NULL
  OR to_regprocedure('lifecycle.lock_delete_tenant()') IS NULL
  OR to_regprocedure('app.current_auth_restore_generation()') IS NULL
  OR to_regprocedure('ai.current_material_restore_generation()') IS NULL
  OR to_regprocedure('app.reject_change()') IS NULL
  OR lifecycle.retained_table('lifecycle','object_restore_requalifications') IS DISTINCT FROM true
  OR lifecycle.retained_table('lifecycle','raw_restore_requalifications') IS DISTINCT FROM true
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='org.organizations'::regclass AND p.polname='archive_org_metadata_read') THEN
  RAISE EXCEPTION 'RESTORE_REQUALIFICATION_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE lifecycle.object_restore_requalifications(
 organization_id uuid NOT NULL,object_key text NOT NULL,kind text NOT NULL CHECK(kind='derived'),
 artifact_id uuid NOT NULL,writer_token uuid NOT NULL,observed text NOT NULL CHECK(observed IN('present','absent')),
 material_restore_generation uuid NOT NULL,auth_restore_generation uuid NOT NULL,
 proven_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,object_key,material_restore_generation),
 CONSTRAINT object_restore_requalification_debt FOREIGN KEY(organization_id,object_key)
  REFERENCES lifecycle.object_restore_debts(organization_id,object_key),
 CONSTRAINT object_restore_requalification_key CHECK(object_key=organization_id::text||'/artifacts/'||artifact_id::text)
);
ALTER TABLE lifecycle.object_restore_requalifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.object_restore_requalifications FORCE ROW LEVEL SECURITY;
CREATE POLICY object_restore_requalification_owner ON lifecycle.object_restore_requalifications TO ensemus_migrator
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
REVOKE ALL ON lifecycle.object_restore_requalifications FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE TRIGGER object_restore_requalification_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.object_restore_requalifications
 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();

CREATE TABLE lifecycle.raw_restore_requalifications(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),source_id uuid NOT NULL,
 purge_job_id uuid NOT NULL,source_version bigint NOT NULL CHECK(source_version>0),
 capture_count bigint NOT NULL CHECK(capture_count>=0),capture_sha256 text NOT NULL CHECK(capture_sha256 ~ '^[0-9a-f]{64}$'),
 document_ids uuid[] NOT NULL,prior_material_restore_generation uuid NOT NULL,
 material_restore_generation uuid NOT NULL,auth_restore_generation uuid NOT NULL,
 proven_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,source_id,material_restore_generation),
 CONSTRAINT raw_restore_requalification_generation CHECK(prior_material_restore_generation<>material_restore_generation),
 CONSTRAINT raw_restore_requalification_documents CHECK(array_position(document_ids,NULL) IS NULL AND cardinality(document_ids)<=capture_count)
);
ALTER TABLE lifecycle.raw_restore_requalifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.raw_restore_requalifications FORCE ROW LEVEL SECURITY;
CREATE POLICY raw_restore_requalification_owner ON lifecycle.raw_restore_requalifications TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(lifecycle.raw_metadata_scope(organization_id));
REVOKE ALL ON lifecycle.raw_restore_requalifications FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE TRIGGER raw_restore_requalification_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.raw_restore_requalifications
 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- The current tenant's own generation, read without a lock through 0415's exact current-tenant
-- metadata policy. Unknown is NULL, which matches no proof: the debt stays open.
CREATE FUNCTION lifecycle.current_tenant_material_generation() RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT o.material_restore_generation FROM org.organizations o WHERE o.id=app.current_organization_id()
$$;
REVOKE ALL ON FUNCTION lifecycle.current_tenant_material_generation() FROM PUBLIC;

-- The debt rows of the current tenant that no proof of the current generation covers. Only fixed
-- migrator-owned SECURITY DEFINER predicates call this; no runtime role may.
CREATE FUNCTION lifecycle.open_object_restore_debts() RETURNS SETOF lifecycle.object_restore_debts
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT d.* FROM lifecycle.object_restore_debts d WHERE d.organization_id=app.current_organization_id()
  AND NOT EXISTS(SELECT 1 FROM lifecycle.object_restore_requalifications q WHERE q.organization_id=d.organization_id
   AND q.object_key=d.object_key AND q.kind=d.kind AND q.artifact_id=d.artifact_id AND q.writer_token=d.writer_token
   AND q.material_restore_generation=lifecycle.current_tenant_material_generation())
$$;
REVOKE ALL ON FUNCTION lifecycle.open_object_restore_debts() FROM PUBLIC;

CREATE FUNCTION lifecycle.object_restore_requalified(p_key text,p_writer uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(p_key IS NOT NULL AND p_writer IS NOT NULL AND EXISTS(SELECT 1 FROM lifecycle.object_restore_debts d
  JOIN lifecycle.object_restore_requalifications q ON q.organization_id=d.organization_id AND q.object_key=d.object_key
   AND q.kind=d.kind AND q.artifact_id=d.artifact_id AND q.writer_token=d.writer_token
  WHERE d.organization_id=app.current_organization_id() AND d.object_key=p_key AND d.kind='derived' AND d.writer_token=p_writer
   AND q.material_restore_generation=lifecycle.current_tenant_material_generation()),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.object_restore_requalified(text,uuid) FROM PUBLIC;
--> statement-breakpoint

-- Every fixed reader of the debt table keeps its own text and reads the open rows instead. The
-- writer (record_object_restore_debt INSERT) and the regclass-only triggers are untouched.
DO $$ DECLARE item record;definition text;header text;rewritten text[]:='{}';BEGIN
 FOR item IN SELECT p.oid,n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE p.prosrc LIKE '%FROM lifecycle.object_restore_debts d WHERE%' AND p.proname<>'open_object_restore_debts'
   AND p.proname<>'object_restore_requalified' ORDER BY n.nspname,p.proname LOOP
  definition:=pg_get_functiondef(item.oid);
  header:='CREATE OR REPLACE FUNCTION '||item.nspname||'.'||item.proname||'(';
  IF item.nspname<>'lifecycle' OR strpos(definition,header)<>1 THEN
   RAISE EXCEPTION 'RESTORE_DEBT_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
  EXECUTE replace(definition,'FROM lifecycle.object_restore_debts d WHERE','FROM lifecycle.open_object_restore_debts() d WHERE');
  rewritten:=rewritten||item.proname::text;
 END LOOP;
 IF NOT rewritten @> ARRAY['begin_object_deletion','begin_object_deletion_before_raw','object_deletion_proven',
   'object_delete_counts','tenant_object_proofs_complete_before_raw']::text[]
  OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.prosrc LIKE '%FROM lifecycle.object_restore_debts %'
   AND p.proname NOT IN('open_object_restore_debts','object_restore_requalified')) THEN
  RAISE EXCEPTION 'RESTORE_DEBT_READER_UNCOVERED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint

-- 0508's derived admission: a restore-pending header stays refused unless this exact object and
-- writer were requalified in the current generation. Every other admission check is unchanged.
DO $$ DECLARE definition text;needle text:='OR header.restore_reapply_pending OR';BEGIN
 definition:=pg_get_functiondef('lifecycle.begin_object_deletion_before_raw(jsonb)'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.begin_object_deletion_before_raw(')<>1
  OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'RESTORE_DEBT_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,needle,
  'OR(header.restore_reapply_pending AND lifecycle.object_restore_requalified(key,header.write_id) IS NOT TRUE) OR');
END $$;
--> statement-breakpoint

-- The proof for one derived restore debt object. The caller is the trusted runtime that has just
-- observed the object key; the observation is evidence, never a deletion: the object still goes
-- through the ordinary 0508 lifecycle, which proves its own DELETE and absence.
CREATE FUNCTION lifecycle.requalify_object_restore_debt(p_artifact uuid,p_observed text) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();material uuid;auth uuid;d record;l record;prior record;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_artifact IS NULL
  OR p_observed IS NULL OR p_observed NOT IN('present','absent') THEN
  RAISE EXCEPTION 'OBJECT_RESTORE_REQUALIFICATION_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 -- Raises RESTORE_PENDING until the restore was reviewed and admitted.
 auth:=app.current_auth_restore_generation();
 PERFORM lifecycle.lock_delete_tenant();
 material:=lifecycle.current_tenant_material_generation();
 IF auth IS NULL OR material IS NULL THEN RAISE EXCEPTION 'OBJECT_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT x.* INTO d FROM lifecycle.object_restore_debts x WHERE x.organization_id=tenant AND x.kind='derived' AND x.artifact_id=p_artifact;
 IF d.object_key IS NULL THEN RAISE EXCEPTION 'OBJECT_RESTORE_DEBT_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT x.* INTO l FROM knowledge.artifact_lineage x WHERE x.organization_id=tenant AND x.artifact_id=p_artifact FOR UPDATE NOWAIT;
 -- The writer is quiescent (settled or fenced), the header is blocked and the deletion is real.
 IF l.artifact_id IS NULL OR l.object_key IS DISTINCT FROM d.object_key OR l.write_id IS DISTINCT FROM d.writer_token
  OR l.state<>'blocked' OR l.write_state NOT IN('settled','fenced')
  OR NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=tenant AND t.target_type='artifact' AND t.target_id=p_artifact) THEN
  RAISE EXCEPTION 'OBJECT_RESTORE_REQUALIFICATION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT q.* INTO prior FROM lifecycle.object_restore_requalifications q
  WHERE q.organization_id=tenant AND q.object_key=d.object_key AND q.material_restore_generation=material;
 IF prior.object_key IS NULL THEN
  INSERT INTO lifecycle.object_restore_requalifications(organization_id,object_key,kind,artifact_id,writer_token,observed,
   material_restore_generation,auth_restore_generation)
   VALUES(tenant,d.object_key,'derived',p_artifact,d.writer_token,p_observed,material,auth);
 ELSIF prior.writer_token IS DISTINCT FROM d.writer_token OR prior.artifact_id IS DISTINCT FROM p_artifact THEN
  RAISE EXCEPTION 'OBJECT_RESTORE_REQUALIFICATION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 RETURN 'requalified';
END $$;
REVOKE ALL ON FUNCTION lifecycle.requalify_object_restore_debt(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.requalify_object_restore_debt(uuid,text) TO ensemus_app;
--> statement-breakpoint

-- The raw objects one restore-debt source inventory names, for the runtime to observe. IDs only,
-- and only for an inventory that this path could requalify.
CREATE FUNCTION lifecycle.raw_restore_requalification_documents(p_source uuid) RETURNS uuid[]
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);answer uuid[];
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_source IS NULL THEN
  RAISE EXCEPTION 'RAW_RESTORE_REQUALIFICATION_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 IF EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.scope_kind='source'
  AND i.source_id=p_source AND i.protocol_version=1 AND i.state='restore_debt' AND i.sealed_at IS NOT NULL) THEN
  SELECT coalesce(array_agg(w.document_id ORDER BY w.document_id),'{}'::uuid[]) INTO answer FROM lifecycle.raw_object_writes w
   WHERE w.organization_id=tenant AND w.source_id=p_source AND w.generation=0;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_restore_requalification_documents(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.raw_restore_requalification_documents(uuid) TO ensemus_app;

-- Whether one restore-debt source inventory is requalified in p_material and still exactly what was
-- proven. Read inside the raw metadata scope by the fixed raw predicates only.
CREATE FUNCTION lifecycle.raw_source_requalified(p_source uuid,p_version bigint,p_job uuid,p_material uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_source IS NOT NULL AND p_version IS NOT NULL
  AND p_job IS NOT NULL AND p_material IS NOT NULL
  AND EXISTS(SELECT 1 FROM lifecycle.raw_restore_requalifications q JOIN lifecycle.raw_source_inventories i
    ON i.organization_id=q.organization_id AND i.scope_kind='source' AND i.source_id=q.source_id
   WHERE q.organization_id=app.current_organization_id() AND q.source_id=p_source AND q.material_restore_generation=p_material
    AND q.source_version=p_version AND q.purge_job_id=p_job
    AND i.protocol_version=1 AND i.state='restore_debt' AND i.source_version=p_version AND i.purge_job_id=p_job
    AND i.material_restore_generation=q.prior_material_restore_generation AND i.sealed_at IS NOT NULL
    AND i.capture_sha256=q.capture_sha256 AND i.capture_count=q.capture_count
    AND q.capture_count=(SELECT count(*) FROM lifecycle.raw_object_writes w WHERE w.organization_id=q.organization_id AND w.source_id=p_source)
    AND q.document_ids=coalesce((SELECT array_agg(w.document_id ORDER BY w.document_id) FROM lifecycle.raw_object_writes w
     WHERE w.organization_id=q.organization_id AND w.source_id=p_source AND w.generation=0),'{}'::uuid[]))
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source
   AND w.generation>0 AND(w.state NOT IN('finished','not_dispatched') OR w.finished_at IS NULL))
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w JOIN lifecycle.object_deletion_claims c
    ON c.organization_id=w.organization_id AND c.object_key=w.object_key
   WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source AND w.generation=0 AND c.state<>'proven')
  AND NOT EXISTS(SELECT 1 FROM knowledge.documents d WHERE d.organization_id=app.current_organization_id() AND d.source_id=p_source)
  AND NOT EXISTS(SELECT 1 FROM knowledge.object_writers w WHERE w.organization_id=app.current_organization_id() AND w.source_id=p_source),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_source_requalified(uuid,bigint,uuid,uuid) FROM PUBLIC;

-- The proof for one restore-debt source inventory: the exact set of its raw objects, each observed
-- physically absent by the runtime after the admitted restore. A missing, extra or present object,
-- an unfinished writer, an unresolved deletion claim, a live raw header, a capture that no longer
-- matches, or debt from this same generation refuses, and nothing is recorded.
CREATE FUNCTION lifecycle.requalify_raw_restore_source(p_source uuid,p_absent_documents uuid[]) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 material uuid;auth uuid;s record;i record;prior record;writes bigint;catalog uuid[];observed uuid[];
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_source IS NULL
  OR p_absent_documents IS NULL OR array_position(p_absent_documents,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'RAW_RESTORE_REQUALIFICATION_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 -- Raises RESTORE_PENDING until the restore was reviewed and admitted.
 auth:=app.current_auth_restore_generation();
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 -- Source -> organization, the 0516 order. Never wait.
 SELECT x.id,x.version,x.state INTO s FROM knowledge.sources x WHERE x.organization_id=tenant AND x.id=p_source FOR SHARE NOWAIT;
 IF s.id IS NULL OR s.state NOT IN('revoked','deleted') OR NOT EXISTS(SELECT 1 FROM platform.tombstones t
  WHERE t.organization_id=tenant AND t.target_type='knowledge_source' AND t.target_id=p_source) THEN
  RAISE EXCEPTION 'RAW_CLOSED_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'RAW_TENANT_REQUIRED' USING ERRCODE='EN850';END IF;
 material:=lifecycle.current_tenant_material_generation();
 IF auth IS NULL OR material IS NULL THEN RAISE EXCEPTION 'RAW_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT x.* INTO i FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant AND x.scope_kind='source' AND x.source_id=p_source;
 -- Only debt a restore left behind: sealed before it, from an earlier generation.
 IF i.id IS NULL OR i.protocol_version<>1 OR i.state<>'restore_debt' OR i.material_restore_generation=material
  OR i.sealed_at IS NULL OR i.capture_sha256 IS NULL OR i.purge_job_id IS NULL OR i.source_version IS DISTINCT FROM s.version
  OR NOT EXISTS(SELECT 1 FROM knowledge.purge_jobs j WHERE j.organization_id=tenant AND j.id=i.purge_job_id AND j.source_id=p_source) THEN
  RAISE EXCEPTION 'RAW_RESTORE_DEBT_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT count(*) INTO writes FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.source_id=p_source;
 SELECT coalesce(array_agg(w.document_id ORDER BY w.document_id),'{}'::uuid[]) INTO catalog FROM lifecycle.raw_object_writes w
  WHERE w.organization_id=tenant AND w.source_id=p_source AND w.generation=0;
 SELECT coalesce(array_agg(x.value ORDER BY x.value),'{}'::uuid[]) INTO observed FROM(SELECT DISTINCT unnest(p_absent_documents) AS value) x;
 IF writes<>i.capture_count OR cardinality(observed)<>cardinality(p_absent_documents) OR observed IS DISTINCT FROM catalog
  OR EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.source_id=p_source
   AND w.generation>0 AND(w.state NOT IN('finished','not_dispatched') OR w.finished_at IS NULL))
  OR EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w JOIN lifecycle.object_deletion_claims c
    ON c.organization_id=w.organization_id AND c.object_key=w.object_key
   WHERE w.organization_id=tenant AND w.source_id=p_source AND w.generation=0 AND c.state<>'proven')
  OR EXISTS(SELECT 1 FROM knowledge.documents d WHERE d.organization_id=tenant AND d.source_id=p_source)
  OR EXISTS(SELECT 1 FROM knowledge.object_writers w WHERE w.organization_id=tenant AND w.source_id=p_source) THEN
  RAISE EXCEPTION 'RAW_RESTORE_REQUALIFICATION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT q.* INTO prior FROM lifecycle.raw_restore_requalifications q
  WHERE q.organization_id=tenant AND q.source_id=p_source AND q.material_restore_generation=material;
 IF prior.source_id IS NULL THEN
  INSERT INTO lifecycle.raw_restore_requalifications(organization_id,source_id,purge_job_id,source_version,capture_count,capture_sha256,
   document_ids,prior_material_restore_generation,material_restore_generation,auth_restore_generation)
   VALUES(tenant,p_source,i.purge_job_id,i.source_version,i.capture_count,i.capture_sha256,catalog,i.material_restore_generation,material,auth);
 ELSIF prior.document_ids IS DISTINCT FROM catalog OR prior.purge_job_id IS DISTINCT FROM i.purge_job_id
  OR prior.source_version IS DISTINCT FROM i.source_version OR prior.capture_sha256 IS DISTINCT FROM i.capture_sha256 THEN
  RAISE EXCEPTION 'RAW_RESTORE_REQUALIFICATION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN 'requalified';
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.requalify_raw_restore_source(uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.requalify_raw_restore_source(uuid,uuid[]) TO ensemus_app;
--> statement-breakpoint

-- 0516's inventory predicate keeps its whole definition and also accepts a requalified inventory.
-- Its callers (raw_source_material_complete, raw_source_status, raw_tenant_inventory_complete) keep
-- their own source/org/job/hold/tombstone checks; raw_tenant_inventory_complete still requires every
-- inventory sealed, so tenant erasure is not widened.
DO $$ DECLARE definition text;header text:='CREATE OR REPLACE FUNCTION lifecycle.raw_source_inventory_complete(';BEGIN
 definition:=pg_get_functiondef('lifecycle.raw_source_inventory_complete(uuid,bigint,uuid,uuid,uuid)'::regprocedure);
 IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'RESTORE_DEBT_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.raw_source_inventory_complete_before_requalify(');
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_source_inventory_complete_before_requalify(uuid,bigint,uuid,uuid,uuid) FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_eraser;
CREATE OR REPLACE FUNCTION lifecycle.raw_source_inventory_complete(p_source uuid,p_version bigint,p_job uuid,p_material uuid,p_auth uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT lifecycle.raw_source_inventory_complete_before_requalify(p_source,p_version,p_job,p_material,p_auth)
  OR coalesce(p_auth IS NOT NULL AND lifecycle.raw_source_requalified(p_source,p_version,p_job,p_material),false)
$$;
--> statement-breakpoint

-- The completion sweep demotes a completion whose inventory is not sealed in this generation. A
-- requalified inventory is the other proof the completion guard accepts, so it is not demoted.
DO $$ DECLARE definition text;needle text:='OR i.material_restore_generation IS DISTINCT FROM material))';BEGIN
 definition:=pg_get_functiondef('lifecycle.reconcile_raw_source_completions(uuid)'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.reconcile_raw_source_completions(')<>1
  OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'RESTORE_DEBT_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,needle,
  'OR i.material_restore_generation IS DISTINCT FROM material) AND lifecycle.raw_source_requalified(x.source_id,i.source_version,x.id,material) IS NOT TRUE)');
END $$;
