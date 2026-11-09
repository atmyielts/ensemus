-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-026, ADR-029). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person
-- Written by an agent in CI repair round 6 (g1, check findings 1, 2 and 16). It changes what counts as
-- owed restore debt and adds three requalification paths to the deletion and raw Knowledge authority.
--
-- 0545 (r6 restore debt): additive. 0508, 0516, 0539, 0543 and 0544 are registered and pushed, so
-- none of them is edited; fixed definitions are cloned or rewritten here the way 0516 and 0543 did.
--
-- 1. A requalification that observed the object PRESENT is not a deletion. 0543 dropped every
--    requalified debt from lifecycle.open_object_restore_debts(), so the moment the runtime recorded
--    "the restored bytes are still there", object_delete_counts().unconfirmed fell to zero and every
--    source purge completion in the tenant (purge_jobs_0508_delete_proof) was admitted while those
--    bytes still existed. Now a debt requalified as present stays open (owed) until a deletion claim
--    for that exact object and writer, admitted after the requalification, is proven (claim, DELETE,
--    independent absence). A debt observed absent is no longer owed bytes, as in 0543.
--      * open_object_restore_debts() keeps its name, signature and every 0543 reader
--        (object_delete_counts, object_deletion_proven, tenant_object_proofs_complete_before_raw and
--        0539's ordinary begin_object_deletion), which therefore keep counting present debt as owed.
--        object_deletion_proven is evaluated by the 0508 lineage/archive receipt triggers in the same
--        statement that proves the claim, so that proof still satisfies it.
--      * Only the admission of the ordinary lifecycle itself (begin_object_deletion_before_raw) reads
--        the debts no requalification covers, so a requalified object is admitted to the lifecycle
--        that deletes it. Its restore-pending header check from 0543 is unchanged.
-- 2. Archive restore debt (0508 kind 'archive', sovereign.imported_archive_files reopened by 0415's
--    block_restored_archive_file) had no way out at all. lifecycle.archive_restore_requalifications is
--    the archive counterpart of 0543's derived proof: per file, per exact writer token, per current
--    material generation, service-only, the file closing and its writer settled. It is no deletion
--    proof either; the archive quarantine lifecycle proves the deletion, and a present file stays owed.
-- 3. A restore rotation (0515/0516 raw_material_proof_lost) moves the organization's raw inventory
--    marker to restore_debt, which no transition leaves (guard_raw_inventory_change). Every native raw
--    birth (raw_org_native_admission and record_raw_native_birth) and the raw erasure witness
--    (raw_tenant_inventory_complete) required that marker open in the current generation, so after
--    any restore no tenant could upload raw Knowledge again or be erased. lifecycle.
--    raw_org_restore_requalifications records, per tenant and current generation, after the restore was
--    admitted (0422), that new births follow the native protocol again. It proves nothing about an
--    older object: each restore-debt source keeps its own debt until 0543's per-source proof, and the
--    erasure witness accepts a restore-debt source only through that same proof
--    (raw_source_requalified). A protocol-0 (legacy) marker may re-admit births as before the restore,
--    and still never satisfies the erasure witness.
-- Nothing here is cleared, rewritten or deleted. Every proof is per object or per tenant, service-only
-- (ensemus_app with a service actor), idempotent within a generation, bound to the current material
-- generation (a later restore reopens it) and has no age, bulk, pattern or role-name clearing. The new
-- tables are append-only retained lifecycle evidence with forced RLS and no runtime-role grant.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RESTORE_DEBT_PRESENT_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regclass('lifecycle.object_restore_requalifications') IS NULL OR to_regclass('lifecycle.raw_restore_requalifications') IS NULL
  OR to_regclass('lifecycle.object_restore_debts') IS NULL OR to_regclass('lifecycle.object_deletion_claims') IS NULL
  OR to_regclass('lifecycle.raw_source_inventories') IS NULL OR to_regclass('sovereign.imported_archive_files') IS NULL
  OR to_regprocedure('lifecycle.open_object_restore_debts()') IS NULL
  OR to_regprocedure('lifecycle.current_tenant_material_generation()') IS NULL
  OR to_regprocedure('lifecycle.begin_object_deletion_before_raw(jsonb)') IS NULL
  OR to_regprocedure('lifecycle.raw_source_requalified(uuid,bigint,uuid,uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_source_inventory_complete(uuid,bigint,uuid,uuid,uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_org_native_admission(uuid)') IS NULL
  OR to_regprocedure('lifecycle.record_raw_native_birth()') IS NULL
  OR to_regprocedure('lifecycle.raw_tenant_inventory_complete()') IS NULL
  OR to_regprocedure('lifecycle.object_delete_absent_before_late_upload(uuid)') IS NULL
  OR to_regprocedure('lifecycle.lock_delete_tenant()') IS NULL
  OR to_regprocedure('app.current_auth_restore_generation()') IS NULL
  OR to_regprocedure('ai.current_material_restore_generation()') IS NULL
  OR to_regprocedure('app.reject_change()') IS NULL
  OR lifecycle.retained_table('lifecycle','archive_restore_requalifications') IS DISTINCT FROM true
  OR lifecycle.retained_table('lifecycle','raw_org_restore_requalifications') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'RESTORE_DEBT_PRESENT_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE lifecycle.archive_restore_requalifications(
 organization_id uuid NOT NULL,object_key text NOT NULL,kind text NOT NULL CHECK(kind='archive'),
 import_id uuid NOT NULL,artifact_id uuid NOT NULL,writer_token uuid NOT NULL,
 observed text NOT NULL CHECK(observed IN('present','absent')),
 material_restore_generation uuid NOT NULL,auth_restore_generation uuid NOT NULL,
 proven_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,object_key,material_restore_generation),
 CONSTRAINT archive_restore_requalification_debt FOREIGN KEY(organization_id,object_key)
  REFERENCES lifecycle.object_restore_debts(organization_id,object_key),
 CONSTRAINT archive_restore_requalification_key CHECK(object_key=organization_id::text||'/archive-quarantine/'||import_id::text||'/'||artifact_id::text||'/'||writer_token::text)
);
ALTER TABLE lifecycle.archive_restore_requalifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.archive_restore_requalifications FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_restore_requalification_owner ON lifecycle.archive_restore_requalifications TO ensemus_migrator
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
REVOKE ALL ON lifecycle.archive_restore_requalifications FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE TRIGGER archive_restore_requalification_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.archive_restore_requalifications
 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();

CREATE TABLE lifecycle.raw_org_restore_requalifications(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),
 protocol_version integer NOT NULL CHECK(protocol_version IN(0,1)),
 prior_material_restore_generation uuid NOT NULL,material_restore_generation uuid NOT NULL,auth_restore_generation uuid NOT NULL,
 proven_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,material_restore_generation),
 CONSTRAINT raw_org_restore_requalification_generation CHECK(prior_material_restore_generation<>material_restore_generation)
);
ALTER TABLE lifecycle.raw_org_restore_requalifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.raw_org_restore_requalifications FORCE ROW LEVEL SECURITY;
CREATE POLICY raw_org_restore_requalification_owner ON lifecycle.raw_org_restore_requalifications TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(lifecycle.raw_metadata_scope(organization_id));
REVOKE ALL ON lifecycle.raw_org_restore_requalifications FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE TRIGGER raw_org_restore_requalification_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.raw_org_restore_requalifications
 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- Every requalification of the current tenant in its current generation, both kinds. Unknown
-- generation is NULL, which matches nothing: the debt stays open.
CREATE FUNCTION lifecycle.current_restore_requalifications()
 RETURNS TABLE(object_key text,kind text,artifact_id uuid,import_id uuid,writer_token uuid,observed text,proven_at timestamptz)
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT q.object_key,q.kind,q.artifact_id,NULL::uuid,q.writer_token,q.observed,q.proven_at FROM lifecycle.object_restore_requalifications q
  WHERE q.organization_id=app.current_organization_id() AND q.material_restore_generation=lifecycle.current_tenant_material_generation()
 UNION ALL
 SELECT q.object_key,q.kind,q.artifact_id,q.import_id,q.writer_token,q.observed,q.proven_at FROM lifecycle.archive_restore_requalifications q
  WHERE q.organization_id=app.current_organization_id() AND q.material_restore_generation=lifecycle.current_tenant_material_generation()
$$;
REVOKE ALL ON FUNCTION lifecycle.current_restore_requalifications() FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

-- The debt rows that no requalification of the current generation covers. Only the lifecycle's own
-- admission reads this: a requalified object may enter the lifecycle that deletes it.
CREATE FUNCTION lifecycle.unrequalified_object_restore_debts() RETURNS SETOF lifecycle.object_restore_debts
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT d.* FROM lifecycle.object_restore_debts d WHERE d.organization_id=app.current_organization_id()
  AND NOT EXISTS(SELECT 1 FROM lifecycle.current_restore_requalifications() q WHERE q.object_key=d.object_key AND q.kind=d.kind
   AND q.artifact_id=d.artifact_id AND q.import_id IS NOT DISTINCT FROM d.import_id AND q.writer_token=d.writer_token)
$$;
REVOKE ALL ON FUNCTION lifecycle.unrequalified_object_restore_debts() FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

-- The debt rows still owed: not requalified, or requalified as present and not yet deleted by a claim
-- for that exact object and writer admitted after the requalification and proven. Same signature as
-- 0543, so every reader 0543 rewrote keeps its text and now keeps present debt owed.
CREATE OR REPLACE FUNCTION lifecycle.open_object_restore_debts() RETURNS SETOF lifecycle.object_restore_debts
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT d.* FROM lifecycle.object_restore_debts d WHERE d.organization_id=app.current_organization_id()
  AND NOT EXISTS(SELECT 1 FROM lifecycle.current_restore_requalifications() q WHERE q.object_key=d.object_key AND q.kind=d.kind
   AND q.artifact_id=d.artifact_id AND q.import_id IS NOT DISTINCT FROM d.import_id AND q.writer_token=d.writer_token
   AND(q.observed='absent' OR EXISTS(SELECT 1 FROM lifecycle.object_deletion_claims c WHERE c.organization_id=d.organization_id
    AND c.object_key=d.object_key AND c.kind=d.kind AND c.artifact_id=d.artifact_id AND c.import_id IS NOT DISTINCT FROM d.import_id
    AND c.writer_token=d.writer_token AND c.state='proven' AND c.terminal_at IS NOT NULL AND c.absent_at>=c.terminal_at
    AND c.admitted_at>=q.proven_at)))
$$;
REVOKE ALL ON FUNCTION lifecycle.open_object_restore_debts() FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
--> statement-breakpoint

-- 0508's admission (as 0543 left it) reads the uncovered debts, so a requalified object is admitted.
-- Exactly one debt read is rewritten; every other check, including 0543's header check, is unchanged.
DO $$ DECLARE definition text;needle text:='FROM lifecycle.open_object_restore_debts() d WHERE';BEGIN
 definition:=pg_get_functiondef('lifecycle.begin_object_deletion_before_raw(jsonb)'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.begin_object_deletion_before_raw(')<>1
  OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1
  OR strpos(definition,'lifecycle.object_restore_requalified(key,header.write_id) IS NOT TRUE')=0 THEN
  RAISE EXCEPTION 'RESTORE_DEBT_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,needle,'FROM lifecycle.unrequalified_object_restore_debts() d WHERE');
END $$;
--> statement-breakpoint

-- The quarantine object key of one archive restore debt, for the runtime to observe. Only for a debt
-- this path could requalify; IDs and the product's own key only.
CREATE FUNCTION lifecycle.archive_restore_requalification_key(p_import uuid,p_artifact uuid) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();d record;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_import IS NULL OR p_artifact IS NULL THEN
  RAISE EXCEPTION 'ARCHIVE_RESTORE_REQUALIFICATION_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 SELECT x.object_key INTO d FROM lifecycle.object_restore_debts x WHERE x.organization_id=tenant AND x.kind='archive'
  AND x.import_id=p_import AND x.artifact_id=p_artifact;
 RETURN d.object_key;
END $$;
REVOKE ALL ON FUNCTION lifecycle.archive_restore_requalification_key(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.archive_restore_requalification_key(uuid,uuid) TO ensemus_app;

-- The proof for one archive restore debt. The caller is the trusted runtime that has just observed the
-- quarantine object; the observation is evidence, never a deletion.
CREATE FUNCTION lifecycle.requalify_archive_restore_debt(p_import uuid,p_artifact uuid,p_observed text) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();material uuid;auth uuid;d record;f record;prior record;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_import IS NULL OR p_artifact IS NULL
  OR p_observed IS NULL OR p_observed NOT IN('present','absent') THEN
  RAISE EXCEPTION 'ARCHIVE_RESTORE_REQUALIFICATION_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 -- Raises RESTORE_PENDING until the restore was reviewed and admitted.
 auth:=app.current_auth_restore_generation();
 PERFORM lifecycle.lock_delete_tenant();
 material:=lifecycle.current_tenant_material_generation();
 IF auth IS NULL OR material IS NULL THEN RAISE EXCEPTION 'ARCHIVE_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT x.* INTO d FROM lifecycle.object_restore_debts x WHERE x.organization_id=tenant AND x.kind='archive'
  AND x.import_id=p_import AND x.artifact_id=p_artifact;
 IF d.object_key IS NULL THEN RAISE EXCEPTION 'ARCHIVE_RESTORE_DEBT_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT x.write_token,x.object_key,x.state,x.closed_at,x.write_state,x.write_finished_at INTO f FROM sovereign.imported_archive_files x
  WHERE x.organization_id=tenant AND x.import_id=p_import AND x.source_artifact_id=p_artifact FOR UPDATE NOWAIT;
 -- The exact writer is settled, the file is closed to serving and it is the debt's own object.
 IF f.write_token IS NULL OR f.write_token IS DISTINCT FROM d.writer_token OR f.object_key IS DISTINCT FROM d.object_key
  OR f.state<>'closing' OR f.closed_at IS NULL OR f.write_state<>'settled' OR f.write_finished_at IS NULL THEN
  RAISE EXCEPTION 'ARCHIVE_RESTORE_REQUALIFICATION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT q.* INTO prior FROM lifecycle.archive_restore_requalifications q
  WHERE q.organization_id=tenant AND q.object_key=d.object_key AND q.material_restore_generation=material;
 IF prior.object_key IS NULL THEN
  INSERT INTO lifecycle.archive_restore_requalifications(organization_id,object_key,kind,import_id,artifact_id,writer_token,observed,
   material_restore_generation,auth_restore_generation)
   VALUES(tenant,d.object_key,'archive',p_import,p_artifact,d.writer_token,p_observed,material,auth);
 ELSIF prior.writer_token IS DISTINCT FROM d.writer_token OR prior.import_id IS DISTINCT FROM p_import OR prior.artifact_id IS DISTINCT FROM p_artifact THEN
  RAISE EXCEPTION 'ARCHIVE_RESTORE_REQUALIFICATION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 RETURN 'requalified';
END $$;
REVOKE ALL ON FUNCTION lifecycle.requalify_archive_restore_debt(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.requalify_archive_restore_debt(uuid,uuid,text) TO ensemus_app;
--> statement-breakpoint

-- Whether the current tenant's restore-debt organization marker was requalified for p_material (and,
-- when p_protocol is given, at that protocol). Read inside the raw metadata scope by fixed predicates.
CREATE FUNCTION lifecycle.raw_org_restore_requalified(p_material uuid,p_protocol integer) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_material IS NOT NULL
  AND EXISTS(SELECT 1 FROM lifecycle.raw_org_restore_requalifications q JOIN lifecycle.raw_source_inventories i
    ON i.organization_id=q.organization_id AND i.scope_kind='organization'
   WHERE q.organization_id=app.current_organization_id() AND q.material_restore_generation=p_material
    AND i.state='restore_debt' AND i.protocol_version=q.protocol_version AND i.material_restore_generation=q.prior_material_restore_generation
    AND(p_protocol IS NULL OR q.protocol_version=p_protocol)),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_org_restore_requalified(uuid,integer) FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

-- The proof for one tenant's organization marker: the restore was admitted, and the marker is debt
-- an earlier generation left. Nothing about any older object is proven or changed.
CREATE FUNCTION lifecycle.requalify_raw_restore_org() RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 material uuid;auth uuid;i record;prior record;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN
  RAISE EXCEPTION 'RAW_RESTORE_REQUALIFICATION_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 -- Raises RESTORE_PENDING until the restore was reviewed and admitted.
 auth:=app.current_auth_restore_generation();
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 PERFORM o.id FROM org.organizations o WHERE o.id=tenant FOR NO KEY UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'RAW_TENANT_REQUIRED' USING ERRCODE='EN850';END IF;
 material:=lifecycle.current_tenant_material_generation();
 IF auth IS NULL OR material IS NULL THEN RAISE EXCEPTION 'RAW_RESTORE_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT x.* INTO i FROM lifecycle.raw_source_inventories x WHERE x.organization_id=tenant AND x.scope_kind='organization';
 IF i.id IS NULL OR i.state<>'restore_debt' OR i.protocol_version NOT IN(0,1) OR i.material_restore_generation=material THEN
  RAISE EXCEPTION 'RAW_RESTORE_DEBT_REQUIRED' USING ERRCODE='EN850';END IF;
 SELECT q.* INTO prior FROM lifecycle.raw_org_restore_requalifications q WHERE q.organization_id=tenant AND q.material_restore_generation=material;
 IF prior.organization_id IS NULL THEN
  INSERT INTO lifecycle.raw_org_restore_requalifications(organization_id,protocol_version,prior_material_restore_generation,
   material_restore_generation,auth_restore_generation) VALUES(tenant,i.protocol_version,i.material_restore_generation,material,auth);
 ELSIF prior.protocol_version IS DISTINCT FROM i.protocol_version OR prior.prior_material_restore_generation IS DISTINCT FROM i.material_restore_generation THEN
  RAISE EXCEPTION 'RAW_RESTORE_REQUALIFICATION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN 'requalified';
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.requalify_raw_restore_org() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lifecycle.requalify_raw_restore_org() TO ensemus_app;
--> statement-breakpoint

-- 0516's organization admission keeps its whole definition and also admits a requalified marker.
DO $$ DECLARE definition text;header text:='CREATE OR REPLACE FUNCTION lifecycle.raw_org_native_admission(';BEGIN
 definition:=pg_get_functiondef('lifecycle.raw_org_native_admission(uuid)'::regprocedure);
 IF strpos(definition,header)<>1 THEN RAISE EXCEPTION 'RESTORE_DEBT_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,header,'CREATE OR REPLACE FUNCTION lifecycle.raw_org_native_admission_before_requalify(');
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_org_native_admission_before_requalify(uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE OR REPLACE FUNCTION lifecycle.raw_org_native_admission(p_material uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT lifecycle.raw_org_native_admission_before_requalify(p_material) OR lifecycle.raw_org_restore_requalified(p_material,NULL)
$$;

-- 0516's birth trigger computes the same admission inline; exactly that one line also accepts a
-- requalified marker. A birth it does not admit still marks its source restore debt, as before.
DO $$ DECLARE definition text;
 needle text:='native:=native AND org_scope.material_restore_generation=material AND((org_scope.protocol_version=1 AND org_scope.state=''open'') OR(org_scope.protocol_version=0 AND org_scope.state=''legacy''));';
 replacement text:='native:=native AND coalesce((org_scope.material_restore_generation=material AND((org_scope.protocol_version=1 AND org_scope.state=''open'') OR(org_scope.protocol_version=0 AND org_scope.state=''legacy''))) OR(org_scope.state=''restore_debt'' AND lifecycle.raw_org_restore_requalified(material,org_scope.protocol_version)),false);';
BEGIN
 definition:=pg_get_functiondef('lifecycle.record_raw_native_birth()'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.record_raw_native_birth(')<>1
  OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'RESTORE_DEBT_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,needle,replacement);
END $$;
--> statement-breakpoint

-- 0516's tenant raw inventory predicate (the erasure witness), with the same conjuncts, where a marker
-- or source scope a restore left in debt is accepted only through its requalification proof: the
-- organization marker at protocol 1 for this generation, and each source through 0543's exact
-- per-source proof (every raw object observed absent, writers concluded, no claim unresolved, no header).
CREATE OR REPLACE FUNCTION lifecycle.raw_tenant_inventory_complete() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);material uuid;auth uuid;answer boolean;
BEGIN
 IF tenant IS NULL THEN RETURN false;END IF;
 material:=ai.current_material_restore_generation();auth:=app.current_auth_restore_generation();
 IF material IS NULL OR auth IS NULL THEN RETURN false;END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 SELECT(EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.scope_kind='organization'
    AND i.protocol_version=1 AND i.state='open' AND i.material_restore_generation=material)
   OR lifecycle.raw_org_restore_requalified(material,1))
  AND NOT EXISTS(SELECT 1 FROM lifecycle.legal_holds h WHERE h.organization_id=tenant AND h.status='active')
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.scope_kind='source'
   AND(i.protocol_version<>1 OR i.purge_job_id IS NULL OR i.source_version IS NULL
    OR NOT((i.state='sealed' AND i.material_restore_generation=material
      AND lifecycle.raw_source_inventory_complete(i.source_id,i.source_version,i.purge_job_id,material,auth) IS TRUE)
     OR(i.state='restore_debt' AND lifecycle.raw_source_requalified(i.source_id,i.source_version,i.purge_job_id,material) IS TRUE))))
  AND NOT EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=tenant AND(s.state='active' OR NOT EXISTS(
   SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.source_id=s.id AND i.source_version=s.version AND i.protocol_version=1
    AND(i.state='sealed' OR(i.state='restore_debt' AND lifecycle.raw_source_requalified(i.source_id,i.source_version,i.purge_job_id,material) IS TRUE)))))
  AND NOT EXISTS(SELECT 1 FROM knowledge.documents d WHERE d.organization_id=tenant)
  AND NOT EXISTS(SELECT 1 FROM knowledge.object_writers w WHERE w.organization_id=tenant)
  AND NOT EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND NOT EXISTS(
   SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.source_id=w.source_id AND i.protocol_version=1
    AND(i.state='sealed' OR(i.state='restore_debt' AND lifecycle.raw_source_requalified(i.source_id,i.source_version,i.purge_job_id,material) IS TRUE)))) INTO answer;
 -- Retained inventory is read even after the source/job/document headers disappear. Missing rows
 -- cannot convert legacy/org/restore/unknown material debt to an empty per-live-source loop.
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN coalesce(answer,false);
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
--> statement-breakpoint

-- Postconditions: the debt readers are the fixed ones, the new tables keep forced RLS and no runtime
-- privilege, no internal helper or clone is executable by a runtime role, and the public entry points
-- keep the ACLs they had.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.prosrc LIKE '%FROM lifecycle.object_restore_debts %'
   AND p.proname NOT IN('open_object_restore_debts','unrequalified_object_restore_debts','object_restore_requalified',
    'requalify_object_restore_debt','requalify_archive_restore_debt','archive_restore_requalification_key'))
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.begin_object_deletion_before_raw(jsonb)'::regprocedure
   AND p.prosrc LIKE '%FROM lifecycle.unrequalified_object_restore_debts() d WHERE%')
  OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='lifecycle.archive_restore_requalifications'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
  OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='lifecycle.raw_org_restore_requalifications'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
  OR has_table_privilege('ensemus_app','lifecycle.archive_restore_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_agent','lifecycle.archive_restore_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_eraser','lifecycle.archive_restore_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_app','lifecycle.raw_org_restore_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_agent','lifecycle.raw_org_restore_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_eraser','lifecycle.raw_org_restore_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_function_privilege('ensemus_app','lifecycle.open_object_restore_debts()','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.unrequalified_object_restore_debts()','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.current_restore_requalifications()','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.raw_org_restore_requalified(uuid,integer)','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.raw_org_native_admission_before_requalify(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_agent','lifecycle.raw_org_native_admission_before_requalify(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.raw_org_native_admission_before_requalify(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_app','lifecycle.begin_object_deletion_before_raw(jsonb)','EXECUTE')
  OR has_function_privilege('ensemus_agent','lifecycle.requalify_archive_restore_debt(uuid,uuid,text)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.requalify_archive_restore_debt(uuid,uuid,text)','EXECUTE')
  OR has_function_privilege('ensemus_agent','lifecycle.requalify_raw_restore_org()','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.requalify_raw_restore_org()','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.requalify_archive_restore_debt(uuid,uuid,text)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.archive_restore_requalification_key(uuid,uuid)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.requalify_raw_restore_org()','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.begin_object_deletion(jsonb)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.object_delete_counts()','EXECUTE')
  OR NOT has_function_privilege('ensemus_eraser','lifecycle.object_delete_counts()','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.object_deletion_proven(text,uuid,uuid,uuid,bigint,text,text)','EXECUTE') THEN
  RAISE EXCEPTION 'RESTORE_DEBT_PRESENT_POSTCONDITION' USING ERRCODE='EN850';END IF;
END $$;
