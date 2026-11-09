-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-026, ADR-029). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person
-- Written by an agent in CI repair round 8 (restore-sql group, check finding 6). It adds one
-- requalification path to the raw Knowledge object authority and lets two 0516 transitions accept it.
--
-- 0550 (r8 restore active source): additive. 0516, 0520, 0523, 0543, 0545 and 0547 are registered and
-- pushed, so none of them is edited; the two fixed definitions are rewritten in place the way 0545
-- rewrote record_raw_native_birth, keeping their OIDs and ACLs. Written as 0549 and renumbered to
-- 0550 at merge (journal idx 110), because 0548_delegation_birth_readiness_deleg took 0548 first.
--
-- The defect (check finding 6, reproduced by tests/integration/raw-restore-active-source.test.ts): a
-- restore rotation (0515 sovereign.rotate_material_restore_generation, 0516 raw_material_proof_lost,
-- deferred by 0542) moves EVERY raw inventory of the tenant to restore_debt, including the inventory of
-- a source that is still active ('open', never sealed). guard_raw_inventory_change lets no transition
-- leave restore_debt, and the inventory's material_restore_generation is immutable. So after any
-- restore, for such a source:
--   * revokeSource and deleteSource fail: the purge job's 0516 birth trigger moves a non-native
--     inventory to 'legacy', which the guard refuses (42501 RAW_INVENTORY_IMMUTABLE), and the whole
--     closure rolls back. The person cannot withdraw the source, and it stays served.
--   * a new version's writer fails (EN850 RAW_LEGACY_WRITER_UNCONFIRMED), because the native writer
--     predicate requires the source inventory 'open' in the current generation, and admit_raw_put
--     requires the same.
-- 0543's per-source proof covers only a closed source whose inventory was sealed before the restore,
-- 0545's covers the organization marker, and 0547's deletes a survivor of a sealed source. None
-- covers a source that was never sealed and is still open.
--
-- The repair, one more exact proof for the existing lifecycle, never a second write or deletion path:
--   * lifecycle.raw_active_source_requalifications: one row per such source and current material
--     generation, recording which catalogued objects of earlier generations were observed, their
--     digest and the write count. Append-only retained evidence, forced RLS, no runtime-role grant.
--     The inventory row itself is not changed (its generation is immutable).
--   * lifecycle.raw_active_restore_requalification_documents(source): the catalogued documents of
--     earlier generations of one such source, IDs only, for the runtime to observe. Service-only.
--   * lifecycle.requalify_raw_restore_active_source(source,documents,sha256,sizes): records the proof
--     once the restore was admitted (0422) and the organization marker was requalified (0545), only for
--     an active source whose protocol-1 inventory a restore left in debt, never sealed and never
--     closed, and only when the trusted runtime observed every catalogued object of an earlier
--     generation present, each with the catalog's and the live header's hash and size; when every
--     writer of the source concluded; and when no deletion claim on its objects is unresolved. A
--     missing, extra, absent or changed object, or any other state, refuses and nothing is recorded.
--     Service-only (ensemus_app with a service actor); its first statement is the session_user
--     refusal (0549's form). Idempotent within a generation; a later restore reopens the debt.
--   * lifecycle.raw_active_source_requalified(source,material): whether such a proof exists for the
--     current generation and still matches (same inventory, same catalogue and write count of earlier
--     generations). Read inside the raw metadata scope by the fixed functions below only.
--   * 0516's native writer predicate (record_raw_native_birth, writer branch) and 0516's
--     admit_raw_put accept a requalified source in place of an 'open' inventory of this generation,
--     exactly as 0545 let the organization marker's requalification stand in for an 'open' marker.
--     Every other conjunct stays: the writer's own catalog row and the document must still be of the
--     current generation, so only a document born after the restore (a new version) gets a writer;
--     an object of an earlier generation is never written again here.
--   * 0516's revoke transition (record_raw_native_birth, purge-job branch) keeps a requalified
--     source's inventory in restore_debt, recording its purge job and version (which the guard
--     permits), instead of moving it to 'legacy' (which the guard refuses). The source closes, its
--     tombstone is written and nothing is served from it. Its raw debt stays owed: the inventory is
--     not sealed, so no 0516, 0543 or 0547 proof accepts it, and its purge job does not complete.
--     Deleting that debt's bytes needs a separately reviewed path (reported, not built here).
-- Nothing is cleared, rewritten or deleted; guard_raw_inventory_change is unchanged; no runtime role
-- gains a table privilege. Only ensemus_app gains EXECUTE on the two new service-only functions.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regclass('lifecycle.raw_source_inventories') IS NULL OR to_regclass('lifecycle.raw_object_writes') IS NULL
  OR to_regclass('lifecycle.object_deletion_claims') IS NULL OR to_regclass('lifecycle.raw_org_restore_requalifications') IS NULL
  OR to_regprocedure('lifecycle.record_raw_native_birth()') IS NULL
  OR to_regprocedure('lifecycle.admit_raw_put(uuid,uuid,bigint)') IS NULL
  OR to_regprocedure('lifecycle.raw_metadata_scope(uuid)') IS NULL
  OR to_regprocedure('lifecycle.raw_org_restore_requalified(uuid,integer)') IS NULL
  OR to_regprocedure('lifecycle.current_tenant_material_generation()') IS NULL
  OR to_regprocedure('knowledge.is_service_actor()') IS NULL
  OR to_regprocedure('app.current_auth_restore_generation()') IS NULL
  OR to_regprocedure('app.reject_change()') IS NULL
  OR lifecycle.retained_table('lifecycle','raw_active_source_requalifications') IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE TABLE lifecycle.raw_active_source_requalifications(
 organization_id uuid NOT NULL REFERENCES org.organizations(id),source_id uuid NOT NULL,
 document_ids uuid[] NOT NULL,catalog_sha256 text NOT NULL CHECK(catalog_sha256 ~ '^[0-9a-f]{64}$'),
 prior_write_count bigint NOT NULL CHECK(prior_write_count>=0),
 prior_material_restore_generation uuid NOT NULL,material_restore_generation uuid NOT NULL,auth_restore_generation uuid NOT NULL,
 proven_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,source_id,material_restore_generation),
 CONSTRAINT raw_active_source_requalification_generation CHECK(prior_material_restore_generation<>material_restore_generation),
 CONSTRAINT raw_active_source_requalification_documents CHECK(array_position(document_ids,NULL) IS NULL AND cardinality(document_ids)<=prior_write_count)
);
ALTER TABLE lifecycle.raw_active_source_requalifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle.raw_active_source_requalifications FORCE ROW LEVEL SECURITY;
CREATE POLICY raw_active_source_requalification_owner ON lifecycle.raw_active_source_requalifications TO ensemus_migrator
 USING(lifecycle.raw_metadata_scope(organization_id)) WITH CHECK(lifecycle.raw_metadata_scope(organization_id));
REVOKE ALL ON lifecycle.raw_active_source_requalifications FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
CREATE TRIGGER raw_active_source_requalification_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON lifecycle.raw_active_source_requalifications
 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint

-- Whether the current tenant's active source p_source was requalified for p_material and is still
-- exactly what was proven: the same never-sealed restore-debt inventory, the same catalogue and write
-- count of earlier generations (which nothing can add to after a rotation), and the organization
-- marker requalified at protocol 1. Read inside the raw metadata scope by the fixed functions below.
CREATE FUNCTION lifecycle.raw_active_source_requalified(p_source uuid,p_material uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(lifecycle.raw_metadata_scope(app.current_organization_id()) AND p_source IS NOT NULL AND p_material IS NOT NULL
  AND lifecycle.raw_org_restore_requalified(p_material,1)
  AND EXISTS(SELECT 1 FROM lifecycle.raw_active_source_requalifications q JOIN lifecycle.raw_source_inventories i
    ON i.organization_id=q.organization_id AND i.scope_kind='source' AND i.source_id=q.source_id
   WHERE q.organization_id=app.current_organization_id() AND q.source_id=p_source AND q.material_restore_generation=p_material
    AND i.protocol_version=1 AND i.state='restore_debt' AND i.sealed_at IS NULL AND i.capture_sha256 IS NULL
    AND i.material_restore_generation=q.prior_material_restore_generation
    AND q.prior_write_count=(SELECT count(*) FROM lifecycle.raw_object_writes w WHERE w.organization_id=q.organization_id
     AND w.source_id=p_source AND w.material_restore_generation<>p_material)
    AND q.document_ids=coalesce((SELECT array_agg(w.document_id ORDER BY w.document_id) FROM lifecycle.raw_object_writes w
     WHERE w.organization_id=q.organization_id AND w.source_id=p_source AND w.generation=0 AND w.material_restore_generation<>p_material),'{}'::uuid[])),false)
$$;
REVOKE ALL ON FUNCTION lifecycle.raw_active_source_requalified(uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;

-- The catalogued documents of earlier generations of one active restore-debt source, for the runtime
-- to observe. IDs only, and only for a source this path could requalify; NULL for anything else.
CREATE FUNCTION lifecycle.raw_active_restore_requalification_documents(p_source uuid) RETURNS uuid[]
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 material uuid;answer uuid[];
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_source IS NULL THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_REQUALIFICATION_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 PERFORM set_config('lifecycle.raw_object_org',tenant::text,true);
 material:=lifecycle.current_tenant_material_generation();
 IF material IS NOT NULL AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.organization_id=tenant AND s.id=p_source AND s.state='active')
  AND EXISTS(SELECT 1 FROM lifecycle.raw_source_inventories i WHERE i.organization_id=tenant AND i.scope_kind='source'
   AND i.source_id=p_source AND i.protocol_version=1 AND i.state='restore_debt' AND i.material_restore_generation<>material
   AND i.sealed_at IS NULL AND i.capture_sha256 IS NULL AND i.purge_job_id IS NULL) THEN
  SELECT coalesce(array_agg(w.document_id ORDER BY w.document_id),'{}'::uuid[]) INTO answer FROM lifecycle.raw_object_writes w
   WHERE w.organization_id=tenant AND w.source_id=p_source AND w.generation=0 AND w.material_restore_generation<>material;
 END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN answer;
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.raw_active_restore_requalification_documents(uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
GRANT EXECUTE ON FUNCTION lifecycle.raw_active_restore_requalification_documents(uuid) TO ensemus_app;

-- The proof for one active source a restore left in debt. The caller is the trusted runtime that has
-- just read every catalogued object of an earlier generation from the store and hashed it; the
-- observation is evidence, never a write or a deletion.
CREATE FUNCTION lifecycle.requalify_raw_restore_active_source(p_source uuid,p_documents uuid[],p_sha256 text[],p_sizes bigint[]) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();previous text:=current_setting('lifecycle.raw_object_org',true);
 material uuid;auth uuid;s record;i record;prior record;catalog uuid[];catalog_digest text;writes bigint;
BEGIN
 IF session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL OR p_source IS NULL
  OR p_documents IS NULL OR p_sha256 IS NULL OR p_sizes IS NULL THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_REQUALIFICATION_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
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
 -- The tenant's marker first (0545): native births are admitted again in this generation.
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
 -- Exactly the catalogued objects of earlier generations, each observed present with the catalog's and
 -- the live header's hash and size; every writer of the source concluded; no deletion claim unresolved.
 IF coalesce(array_ndims(p_documents),1)<>1 OR coalesce(array_ndims(p_sha256),1)<>1 OR coalesce(array_ndims(p_sizes),1)<>1
  OR cardinality(p_documents)<>cardinality(catalog) OR cardinality(p_sha256)<>cardinality(catalog) OR cardinality(p_sizes)<>cardinality(catalog)
  OR array_position(p_documents,NULL) IS NOT NULL OR array_position(p_sha256,NULL) IS NOT NULL OR array_position(p_sizes,NULL) IS NOT NULL
  OR(SELECT coalesce(array_agg(x.value ORDER BY x.value),'{}'::uuid[]) FROM(SELECT DISTINCT unnest(p_documents) AS value) x) IS DISTINCT FROM catalog
  OR EXISTS(SELECT 1 FROM unnest(p_documents,p_sha256,p_sizes) o(document_id,sha256,size_bytes) WHERE NOT EXISTS(
   SELECT 1 FROM lifecycle.raw_object_writes c JOIN knowledge.documents d
     ON d.organization_id=c.organization_id AND d.id=c.document_id AND d.source_id=c.source_id
    WHERE c.organization_id=tenant AND c.source_id=p_source AND c.generation=0 AND c.state='catalog'
     AND c.material_restore_generation<>material AND c.document_id=o.document_id
     AND c.content_sha256=o.sha256 AND c.size_bytes=o.size_bytes AND d.content_sha256=o.sha256 AND d.size_bytes=o.size_bytes))
  OR EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w WHERE w.organization_id=tenant AND w.source_id=p_source
   AND w.generation>0 AND(w.state NOT IN('finished','not_dispatched') OR w.finished_at IS NULL))
  OR EXISTS(SELECT 1 FROM knowledge.object_writers w WHERE w.organization_id=tenant AND w.source_id=p_source AND w.state<>'settled')
  OR EXISTS(SELECT 1 FROM lifecycle.raw_object_writes w JOIN lifecycle.object_deletion_claims c
    ON c.organization_id=w.organization_id AND c.object_key=w.object_key
   WHERE w.organization_id=tenant AND w.source_id=p_source AND w.generation=0 AND c.state<>'proven') THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_REQUALIFICATION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 SELECT q.* INTO prior FROM lifecycle.raw_active_source_requalifications q
  WHERE q.organization_id=tenant AND q.source_id=p_source AND q.material_restore_generation=material;
 IF prior.source_id IS NULL THEN
  INSERT INTO lifecycle.raw_active_source_requalifications(organization_id,source_id,document_ids,catalog_sha256,prior_write_count,
   prior_material_restore_generation,material_restore_generation,auth_restore_generation)
   VALUES(tenant,p_source,catalog,catalog_digest,writes,i.material_restore_generation,material,auth);
 ELSIF prior.document_ids IS DISTINCT FROM catalog OR prior.catalog_sha256 IS DISTINCT FROM catalog_digest
  OR prior.prior_write_count IS DISTINCT FROM writes OR prior.prior_material_restore_generation IS DISTINCT FROM i.material_restore_generation THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_REQUALIFICATION_UNCONFIRMED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RETURN 'requalified';
EXCEPTION WHEN OTHERS THEN PERFORM set_config('lifecycle.raw_object_org',coalesce(previous,''),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION lifecycle.requalify_raw_restore_active_source(uuid,uuid[],text[],bigint[])
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
GRANT EXECUTE ON FUNCTION lifecycle.requalify_raw_restore_active_source(uuid,uuid[],text[],bigint[]) TO ensemus_app;
--> statement-breakpoint

-- 0516's birth trigger, as 0545 left it. Exactly two texts change, each found exactly once:
--   * writer branch: a requalified source stands in for an 'open' inventory of this generation; the
--     catalog-row and document conjuncts that follow are unchanged (current generation only);
--   * purge-job branch: a requalified, never-closed source keeps its inventory in restore_debt
--     (recording the job and version) instead of the 'legacy' move the guard refuses.
-- Everything else, including 0545's organization-marker line, is unchanged.
DO $$ DECLARE definition text;
 writer_needle text:='native:=native AND source_scope.protocol_version=1 AND source_scope.state=''open'' AND source_scope.material_restore_generation=material';
 writer_replacement text:='native:=native AND source_scope.protocol_version=1 AND coalesce((source_scope.state=''open'' AND source_scope.material_restore_generation=material) OR(source_scope.state=''restore_debt'' AND lifecycle.raw_active_source_requalified(NEW.source_id,material)),false)';
 revoke_needle text:='state=CASE WHEN native THEN ''capturing'' ELSE ''legacy'' END';
 revoke_replacement text:='state=CASE WHEN native THEN ''capturing'' WHEN source_scope.protocol_version=1 AND source_scope.state=''restore_debt'' AND source_scope.purge_job_id IS NULL AND lifecycle.raw_active_source_requalified(NEW.source_id,material) IS TRUE THEN ''restore_debt'' ELSE ''legacy'' END';
BEGIN
 definition:=pg_get_functiondef('lifecycle.record_raw_native_birth()'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.record_raw_native_birth(')<>1
  OR (length(definition)-length(replace(definition,writer_needle,'')))/length(writer_needle)<>1
  OR (length(definition)-length(replace(definition,revoke_needle,'')))/length(revoke_needle)<>1
  OR strpos(definition,'lifecycle.raw_org_restore_requalified(material,org_scope.protocol_version)')=0 THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(replace(definition,writer_needle,writer_replacement),revoke_needle,revoke_replacement);
END $$;
--> statement-breakpoint

-- 0516's admit_raw_put: exactly its source inventory check also accepts a requalified source. The
-- writer row it admits must still be of the current generation, as before.
DO $$ DECLARE definition text;
 needle text:='AND i.protocol_version=1 AND i.state=''open'' AND i.material_restore_generation=material) THEN';
 replacement text:='AND i.protocol_version=1 AND((i.state=''open'' AND i.material_restore_generation=material) OR(i.state=''restore_debt'' AND lifecycle.raw_active_source_requalified(w.source_id,material) IS TRUE))) THEN';
BEGIN
 definition:=pg_get_functiondef('lifecycle.admit_raw_put(uuid,uuid,bigint)'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION lifecycle.admit_raw_put(')<>1
  OR (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1
  OR strpos(definition,'IF w.id IS NULL OR w.material_restore_generation IS DISTINCT FROM material THEN')=0 THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(definition,needle,replacement);
END $$;
--> statement-breakpoint

-- Postconditions: the new table keeps forced RLS and no runtime privilege; the predicate has no
-- runtime access; the two entry points are SECURITY DEFINER, granted directly to ensemus_app alone
-- (ensemus_agent inherits it by membership, see 0545's note, so each must refuse it itself) and open
-- with the session_user refusal in 0549's exact form; the rewritten functions carry the new predicate
-- where intended and keep their ACLs.
DO $$ DECLARE opening text:='^[[:space:]]*DECLARE[[:space:]]+tenant uuid:=app\.current_organization_id\(\);'
  ||'([[:space:]]*previous text:=current_setting\(''lifecycle\.raw_object_org'',true\);)?'
  ||'([[:space:]]*[a-z_][a-z0-9_]* (uuid|text|record|jsonb|boolean|bigint|integer)(\[\])?;)*'
  ||'[[:space:]]*BEGIN[[:space:]]+IF session_user<>''ensemus_app'' OR NOT knowledge\.is_service_actor\(\) OR tenant IS NULL'
  ||'([[:space:]]+OR[[:space:]]+(p_[a-z0-9_]+ IS NULL|p_observed NOT IN\(''present'',''absent''\)))*'
  ||'[[:space:]]+THEN[[:space:]]+RAISE EXCEPTION ''[A-Z0-9_]+'' USING ERRCODE=''42501'';[[:space:]]*END IF;';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='lifecycle.raw_active_source_requalifications'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
  OR has_table_privilege('ensemus_app','lifecycle.raw_active_source_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_agent','lifecycle.raw_active_source_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_eraser','lifecycle.raw_active_source_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_auth','lifecycle.raw_active_source_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_dispatcher','lifecycle.raw_active_source_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('ensemus_secrets','lifecycle.raw_active_source_requalifications','SELECT,INSERT,UPDATE,DELETE')
  OR has_function_privilege('ensemus_app','lifecycle.raw_active_source_requalified(uuid,uuid)','EXECUTE')
  OR has_function_privilege('ensemus_agent','lifecycle.raw_active_source_requalified(uuid,uuid)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.raw_active_source_requalified(uuid,uuid)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.raw_active_restore_requalification_documents(uuid)','EXECUTE')
  OR NOT has_function_privilege('ensemus_app','lifecycle.requalify_raw_restore_active_source(uuid,uuid[],text[],bigint[])','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.raw_active_restore_requalification_documents(uuid)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.requalify_raw_restore_active_source(uuid,uuid[],text[],bigint[])','EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid IN('lifecycle.raw_active_restore_requalification_documents(uuid)'::regprocedure,
    'lifecycle.requalify_raw_restore_active_source(uuid,uuid[],text[],bigint[])'::regprocedure)
    AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND a.grantee<>'ensemus_app'::regrole::oid)
  OR(SELECT count(*) FROM pg_proc p WHERE p.oid IN('lifecycle.raw_active_restore_requalification_documents(uuid)'::regprocedure,
    'lifecycle.requalify_raw_restore_active_source(uuid,uuid[],text[],bigint[])'::regprocedure)
    AND p.prosecdef AND p.proowner='ensemus_migrator'::regrole::oid
    AND p.prolang=(SELECT l.oid FROM pg_language l WHERE l.lanname='plpgsql')
    AND p.proconfig IS NOT NULL AND 'search_path=pg_catalog'=ANY(p.proconfig) AND p.prosrc ~ opening)<>2
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.record_raw_native_birth()'::regprocedure AND p.prosecdef
   AND(length(p.prosrc)-length(replace(p.prosrc,'lifecycle.raw_active_source_requalified(NEW.source_id,material)','')))
    /length('lifecycle.raw_active_source_requalified(NEW.source_id,material)')=2
   AND strpos(p.prosrc,'source_scope.state=''open'' AND source_scope.material_restore_generation=material)')>0
   AND strpos(p.prosrc,'WHEN native THEN ''capturing'' WHEN source_scope.protocol_version=1')>0
   AND strpos(p.prosrc,'lifecycle.raw_org_restore_requalified(material,org_scope.protocol_version)')>0)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='lifecycle.admit_raw_put(uuid,uuid,bigint)'::regprocedure AND p.prosecdef
   AND strpos(p.prosrc,'lifecycle.raw_active_source_requalified(w.source_id,material) IS TRUE')>0)
  OR NOT has_function_privilege('ensemus_app','lifecycle.admit_raw_put(uuid,uuid,bigint)','EXECUTE')
  OR has_function_privilege('ensemus_eraser','lifecycle.admit_raw_put(uuid,uuid,bigint)','EXECUTE') THEN
  RAISE EXCEPTION 'RAW_ACTIVE_RESTORE_POSTCONDITION' USING ERRCODE='EN850';END IF;
END $$;
