-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW (ADR-032 D7), not yet reviewed by a person
-- Written by an agent in CI repair round 12 (B-record-purge-durable-completion group, check finding 3).
--
-- 0554 (r12 record purge completion): additive. 0419, 0514, 0515 and 0552 are registered and pushed, so
-- none of them is edited. 0419's guard is rewritten in place the way 0550 rewrote 0516's functions
-- (pg_get_functiondef, each needle found exactly once, OID and ACL kept). Renumbered at merge if
-- another 0554 lands first.
--
-- The defect (check finding 3): the tenant's knowledge sweep (claimRecordPurgeRestarts, ADR-028 item
-- 8a) lists dead or tombstoned typed records and proves each again with the composite proof that
-- confirmRecordPurge and readRecordPurgeState use. Nothing recorded that a proof had completed, so every
-- sweep proved every record of its 25-candidate window again, completed ones included, and each proof
-- took the organization row lock (FOR NO KEY UPDATE NOWAIT) through lifecycle.record_purge_hold_free
-- (0514). A person changing the organization at that moment saw TENANT_BUSY, every 15 minutes, forever.
--
-- The repair: a durable per-record completion on the record's purge job, keyed by snapshot (the job's
-- primary key) and by material restore generation, written only when PostgreSQL's own composite proof
-- reads completed, and excluded from the sweep's candidates while it is current.
--   * ai.record_purge_jobs.completed_restore_generation and completed_at. NULL until attested. A CHECK
--     ties them together, to a checked job, and to the job's own proof generation.
--   * ai.attest_record_purge_completion(old,new): the only path that sets them. It is called by 0419's
--     guard (rewritten below) for an UPDATE by the knowledge worker (ensemus_app, service actor), and
--     its first statement refuses anything else. It accepts no value from the caller: every column but
--     the two must equal the stored row, and the two are set from the proof itself. The proof is, in
--     one transaction, under the same locks: the record's current snapshot is this job's; the job was
--     checked (by 0419's guard, on the agent role) at the current material restore generation;
--     ai.record_work_purge_confirmed (copied Work, controls, unknown inputs, 0514's hold barrier);
--     knowledge.derived_structured_artifacts_remaining = 0 (generated files, which itself refuses EN119
--     until the copied Work is proved); sovereign.archive_file_counts().remaining = 0 (archive files);
--     lifecycle.object_delete_counts().unconfirmed = 0 (the production file port's
--     assertNoUnresolvedObjectDeletes). Any other answer raises EN119 and nothing is written.
--   * 0419's guard: an agent INSERT or UPDATE (any purge pass, cursor move or proof) clears the
--     completion, so a pass that reopens a record reopens its completion too.
--   * ai.record_purge_completed(kind,id,generation): whether the record has a current completion: a job
--     for the record's current snapshot (recomputed without locks, with 0419's exact formula, pinned
--     below) completed at the given generation. listRecordPurgeCandidates excludes those records.
-- A new restore generation (sovereign.rotate_material_restore_generation) or a changed record snapshot
-- (a new tombstone, a catalog change) leaves the stored completion stale, so the record is a candidate
-- again; the eraser deletes the job rows with everything else (ai.record_purge_jobs stays erasable,
-- 0515's ordering trigger unchanged).
--
-- Why the attestation runs as ensemus_app, not inside a SECURITY DEFINER function. Every input of the
-- composite proof (receipts, refs, runs, checkpoints, closures, lineage, archive files, deletion
-- claims) is visible only through RLS policies TO ensemus_app, and ai.record_work_purge_confirmed returns
-- false when current_user is not ensemus_app or ensemus_agent. Inside a definer owned by the migrator
-- the proof cannot be evaluated at all; a definer that trusted the caller's word for it would let the
-- runtime forge a completion and hide a record from the sweep. So the proof is evaluated where 0419
-- already evaluates the copied-Work proof: in the guard trigger, as the invoker. Reviewer note:
-- ensemus_app gains exactly one column privilege, UPDATE(completed_restore_generation) on this table, and
-- one UPDATE policy confined to its own tenant, its own login and a service actor. Whatever value it
-- writes is replaced by the guard's, or the statement raises; it has no INSERT, DELETE, TRUNCATE or other
-- column UPDATE here, and completed_at has no runtime privilege at all.
--
-- Known limit, accepted for the sweep: once completed, a record is not proved again until its snapshot
-- or the restore generation changes, or an agent purge pass reopens it. A dead record admits no new
-- consumer (no read, no generated file names it after its closure), so a later proof could only change
-- through tenant-wide state (an unrelated unfinished run, archive file or deletion claim). The workflow
-- and readRecordPurgeState still prove from PostgreSQL every time they run.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regclass('ai.record_purge_jobs') IS NULL
  OR to_regprocedure('ai.guard_record_purge_job()') IS NULL
  OR to_regprocedure('ai.record_work_purge_confirmed(text,uuid)') IS NULL
  OR to_regprocedure('ai.lock_record_purge_snapshot(text,uuid)') IS NULL
  OR to_regprocedure('ai.current_material_restore_generation()') IS NULL
  OR to_regprocedure('lifecycle.record_purge_hold_free(text,uuid,text)') IS NULL
  OR to_regprocedure('knowledge.derived_structured_artifacts_remaining(text,uuid)') IS NULL
  OR to_regprocedure('sovereign.archive_file_counts()') IS NULL
  OR to_regprocedure('lifecycle.object_delete_counts()') IS NULL
  OR to_regprocedure('knowledge.is_service_actor()') IS NULL
  OR to_regprocedure('app.current_organization_id()') IS NULL
  OR lifecycle.retained_table('ai','record_purge_jobs') IS DISTINCT FROM false
  OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='ai.record_purge_jobs'::regclass
   AND a.attname IN('completed_restore_generation','completed_at')) THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_PREREQUISITE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
ALTER TABLE ai.record_purge_jobs ADD COLUMN completed_restore_generation uuid,ADD COLUMN completed_at timestamptz,
 ADD CONSTRAINT record_purge_jobs_completion CHECK((completed_restore_generation IS NULL AND completed_at IS NULL)
  OR(completed_restore_generation IS NOT NULL AND completed_at IS NOT NULL AND checked_at IS NOT NULL
   AND restore_generation IS NOT NULL AND restore_generation=completed_restore_generation));
CREATE POLICY record_purge_completion_attest ON ai.record_purge_jobs FOR UPDATE TO ensemus_app
 USING(organization_id=app.current_organization_id() AND current_user='ensemus_app' AND session_user='ensemus_app' AND app.current_actor_type()='service')
 WITH CHECK(organization_id=app.current_organization_id() AND current_user='ensemus_app' AND session_user='ensemus_app' AND app.current_actor_type()='service');
GRANT UPDATE(completed_restore_generation) ON ai.record_purge_jobs TO ensemus_app;
--> statement-breakpoint

-- The attestation. Invoker rights on purpose (see the header): it runs as the knowledge worker inside
-- 0419's BEFORE UPDATE guard, reading the same proof the worker reads, under the locks that proof takes.
CREATE FUNCTION ai.attest_record_purge_completion(p_old ai.record_purge_jobs,p_new ai.record_purge_jobs) RETURNS ai.record_purge_jobs
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=app.current_organization_id();
 generation uuid;current_snapshot text;files integer;archive integer;deletes integer;
BEGIN
 IF session_user<>'ensemus_app' OR current_user<>'ensemus_app' OR NOT knowledge.is_service_actor() OR tenant IS NULL THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_SERVICE_REQUIRED' USING ERRCODE='42501';END IF;
 -- No value from the caller: only the completion may differ from the stored row.
 IF p_old.organization_id IS DISTINCT FROM tenant OR p_new.organization_id IS DISTINCT FROM tenant
  OR ROW(p_new.organization_id,p_new.record_kind,p_new.record_id,p_new.snapshot_sha256,p_new.after_run,p_new.after_child,
   p_new.work_removed,p_new.work_remaining,p_new.unknown_work,p_new.controls_remaining,p_new.checked_at,p_new.receipts_sha256,
   p_new.restore_generation,p_new.created_at,p_new.updated_at,p_new.completed_at)
  IS DISTINCT FROM ROW(p_old.organization_id,p_old.record_kind,p_old.record_id,p_old.snapshot_sha256,p_old.after_run,p_old.after_child,
   p_old.work_removed,p_old.work_remaining,p_old.unknown_work,p_old.controls_remaining,p_old.checked_at,p_old.receipts_sha256,
   p_old.restore_generation,p_old.created_at,p_old.updated_at,p_old.completed_at) THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_TARGET' USING ERRCODE='42501';END IF;
 -- The record's current snapshot is this job's, and 0419's guard checked it in this generation.
 generation:=ai.current_material_restore_generation();
 current_snapshot:=ai.lock_record_purge_snapshot(p_old.record_kind,p_old.record_id);
 IF generation IS NULL OR current_snapshot IS NULL OR current_snapshot IS DISTINCT FROM p_old.snapshot_sha256
  OR p_old.checked_at IS NULL OR p_old.restore_generation IS DISTINCT FROM generation THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_UNCONFIRMED' USING ERRCODE='EN119';END IF;
 -- PostgreSQL's composite proof, exactly as confirmRecordPurge and readRecordPurgeState read it.
 IF ai.record_work_purge_confirmed(p_old.record_kind,p_old.record_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_UNCONFIRMED' USING ERRCODE='EN119';END IF;
 files:=knowledge.derived_structured_artifacts_remaining(p_old.record_kind,p_old.record_id);
 SELECT counted.remaining INTO archive FROM sovereign.archive_file_counts() counted;
 SELECT counted.unconfirmed INTO deletes FROM lifecycle.object_delete_counts() counted;
 IF files IS DISTINCT FROM 0 OR archive IS DISTINCT FROM 0 OR deletes IS DISTINCT FROM 0 THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_UNCONFIRMED' USING ERRCODE='EN119';END IF;
 p_new.completed_restore_generation:=generation;
 p_new.completed_at:=clock_timestamp();
 RETURN p_new;
END $$;
REVOKE ALL ON FUNCTION ai.attest_record_purge_completion(ai.record_purge_jobs,ai.record_purge_jobs)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
-- The guard runs as the invoker, so the knowledge worker needs EXECUTE. Called directly it only
-- returns a row value (or raises); it writes nothing.
GRANT EXECUTE ON FUNCTION ai.attest_record_purge_completion(ai.record_purge_jobs,ai.record_purge_jobs) TO ensemus_app;
--> statement-breakpoint

-- 0419's guard. Exactly two texts change, each found exactly once:
--   * opening: an UPDATE by ensemus_app is the attestation above and nothing else (its own refusal
--     rejects any other login or actor); every other write meets 0419's unchanged refusal and checks;
--   * closing: every write that reaches 0419's own checks (an agent INSERT or UPDATE) clears the
--     completion, so a reopened purge pass reopens the record for the sweep.
DO $migration$ DECLARE definition text;
 opening_needle text:=$n$IF TG_RELID<>'ai.record_purge_jobs'::regclass OR TG_OP NOT IN('INSERT','UPDATE') OR current_user<>'ensemus_agent' OR session_user<>'ensemus_agent'$n$;
 opening_replacement text:=$n$IF TG_RELID='ai.record_purge_jobs'::regclass AND TG_OP='UPDATE' AND current_user='ensemus_app' THEN RETURN ai.attest_record_purge_completion(OLD,NEW);END IF; IF TG_RELID<>'ai.record_purge_jobs'::regclass OR TG_OP NOT IN('INSERT','UPDATE') OR current_user<>'ensemus_agent' OR session_user<>'ensemus_agent'$n$;
 closing_needle text:=$n$NEW.updated_at:=clock_timestamp();RETURN NEW;$n$;
 closing_replacement text:=$n$NEW.completed_restore_generation:=NULL;NEW.completed_at:=NULL;NEW.updated_at:=clock_timestamp();RETURN NEW;$n$;
BEGIN
 definition:=pg_get_functiondef('ai.guard_record_purge_job()'::regprocedure);
 IF strpos(definition,'CREATE OR REPLACE FUNCTION ai.guard_record_purge_job(')<>1
  OR (length(definition)-length(replace(definition,opening_needle,'')))/length(opening_needle)<>1
  OR (length(definition)-length(replace(definition,closing_needle,'')))/length(closing_needle)<>1
  OR strpos(definition,'ai.attest_record_purge_completion')<>0 THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_FIXED_DEFINITION_REQUIRED' USING ERRCODE='EN850';END IF;
 EXECUTE replace(replace(definition,opening_needle,opening_replacement),closing_needle,closing_replacement);
END $migration$;
--> statement-breakpoint

-- Whether the current tenant's record has a current completion: a job for the record's current snapshot,
-- completed in p_generation (the caller's ai.current_material_restore_generation(), read once per page).
-- The snapshot is recomputed without locks, with 0419's ai.lock_record_purge_snapshot formula (pinned
-- below), so a candidate list takes no row lock on the catalog or tombstones. Ranking only: it decides
-- what the sweep proves next and is never itself a proof that anything is purged.
CREATE FUNCTION ai.record_purge_completed(p_kind text,p_id uuid,p_generation uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(p_generation IS NOT NULL AND EXISTS(SELECT 1 FROM knowledge.structured_record_catalog catalog
   LEFT JOIN platform.tombstones tombstone ON tombstone.organization_id=catalog.organization_id
    AND tombstone.target_type=catalog.record_kind AND tombstone.target_id=catalog.record_id
   JOIN ai.record_purge_jobs job ON job.organization_id=catalog.organization_id
    AND job.record_kind=catalog.record_kind AND job.record_id=catalog.record_id
  WHERE catalog.organization_id=app.current_organization_id() AND catalog.record_kind=p_kind AND catalog.record_id=p_id
   AND(NOT catalog.alive OR tombstone.target_id IS NOT NULL)
   AND job.completed_restore_generation=p_generation AND job.restore_generation=p_generation AND job.checked_at IS NOT NULL
   AND job.snapshot_sha256=encode(sha256(convert_to(jsonb_build_object('protocol','record-purge-snapshot/v1',
    'organizationId',app.current_organization_id(),'kind',catalog.record_kind,'id',catalog.record_id,'alive',catalog.alive,
    'classification',catalog.classification,'ownerMembershipId',catalog.owner_membership_id,
    'parentRecordId',catalog.parent_record_id,'tombstone',CASE WHEN tombstone.target_id IS NOT NULL
     THEN jsonb_build_object('reasonCode',tombstone.reason_code,'createdEpoch',extract(epoch FROM tombstone.created_at)::text) END)::text,'UTF8')),'hex')),false)
$$;
REVOKE ALL ON FUNCTION ai.record_purge_completed(text,uuid,uuid)
 FROM PUBLIC,ensemus_app,ensemus_agent,ensemus_auth,ensemus_secrets,ensemus_dispatcher,ensemus_eraser;
GRANT EXECUTE ON FUNCTION ai.record_purge_completed(text,uuid,uuid) TO ensemus_app;
--> statement-breakpoint

-- Postconditions. The DETAIL names only an object, never a tenant or a value.
DO $$ DECLARE runtime_role text;guard text;snapshot_source text;
 opening text:='^[[:space:]]*DECLARE[[:space:]]+tenant uuid:=app\.current_organization_id\(\);'
  ||'([[:space:]]*[a-z_][a-z0-9_]* (uuid|text|record|jsonb|boolean|bigint|integer)(\[\])?;)*'
  ||'[[:space:]]*BEGIN[[:space:]]+IF session_user<>''ensemus_app'' OR current_user<>''ensemus_app'' OR NOT knowledge\.is_service_actor\(\) OR tenant IS NULL'
  ||'[[:space:]]+THEN[[:space:]]+RAISE EXCEPTION ''[A-Z0-9_]+'' USING ERRCODE=''42501'';[[:space:]]*END IF;';
BEGIN
 -- The table: forced RLS, owned by the migrator, erasable as before (lifecycle.retained_table false, the
 -- eraser keeps DELETE and gains nothing else), the completion columns and their CHECK.
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='ai.record_purge_jobs'::regclass
   AND c.relrowsecurity AND c.relforcerowsecurity AND c.relowner='ensemus_migrator'::regrole::oid)
  OR lifecycle.retained_table('ai','record_purge_jobs') IS DISTINCT FROM false
  OR NOT has_table_privilege('ensemus_eraser','ai.record_purge_jobs','DELETE')
  OR has_any_column_privilege('ensemus_eraser','ai.record_purge_jobs','INSERT,UPDATE')
  OR(SELECT count(*) FROM pg_attribute a WHERE a.attrelid='ai.record_purge_jobs'::regclass AND NOT a.attisdropped
   AND((a.attname='completed_restore_generation' AND a.atttypid='uuid'::regtype::oid)
    OR(a.attname='completed_at' AND a.atttypid='timestamptz'::regtype::oid)))<>2
  OR NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='ai.record_purge_jobs'::regclass
   AND c.conname='record_purge_jobs_completion' AND c.contype='c' AND c.convalidated) THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_POSTCONDITION' USING ERRCODE='EN850',DETAIL='ai.record_purge_jobs';END IF;
 -- No runtime role writes the completion except ensemus_app's one column (ensemus_agent inherits it by
 -- membership; 0419's guard sends its writes to 0419's checks, which clear the completion). Nobody may
 -- update completed_at, and ensemus_app gains no table-level write.
 FOREACH runtime_role IN ARRAY ARRAY['ensemus_app','ensemus_agent','ensemus_auth','ensemus_secrets','ensemus_dispatcher',
  'ensemus_eraser','ensemus_operator','ensemus_support'] LOOP
  IF to_regrole(runtime_role) IS NOT NULL AND(
   has_column_privilege(runtime_role::name,'ai.record_purge_jobs','completed_at','UPDATE')
   OR(has_column_privilege(runtime_role::name,'ai.record_purge_jobs','completed_restore_generation','UPDATE')
    AND runtime_role NOT IN('ensemus_app','ensemus_agent'))) THEN
   RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_POSTCONDITION' USING ERRCODE='EN850',DETAIL='ai.record_purge_jobs '||runtime_role;END IF;
 END LOOP;
 IF NOT has_column_privilege('ensemus_app','ai.record_purge_jobs','completed_restore_generation','UPDATE')
  OR has_table_privilege('ensemus_app','ai.record_purge_jobs','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
   WHERE a.attrelid='ai.record_purge_jobs'::regclass AND a.attname IN('completed_restore_generation','completed_at')
    AND NOT(a.attname='completed_restore_generation' AND x.grantee='ensemus_app'::regrole::oid AND x.privilege_type='UPDATE'))
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='ai.record_purge_jobs'::regclass
   AND p.polname='record_purge_completion_attest' AND p.polpermissive AND p.polcmd='w'
   AND p.polroles=ARRAY['ensemus_app'::regrole::oid]) THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_POSTCONDITION' USING ERRCODE='EN850',DETAIL='ai.record_purge_jobs ensemus_app';END IF;
 -- 0419's guard carries the attestation and the clearing exactly once, and is still the enabled BEFORE
 -- INSERT OR UPDATE row trigger.
 guard:=pg_get_functiondef('ai.guard_record_purge_job()'::regprocedure);
 IF (length(guard)-length(replace(guard,'RETURN ai.attest_record_purge_completion(OLD,NEW);','')))/length('RETURN ai.attest_record_purge_completion(OLD,NEW);')<>1
  OR (length(guard)-length(replace(guard,'NEW.completed_restore_generation:=NULL;NEW.completed_at:=NULL;NEW.updated_at:=clock_timestamp();RETURN NEW;','')))
   /length('NEW.completed_restore_generation:=NULL;NEW.completed_at:=NULL;NEW.updated_at:=clock_timestamp();RETURN NEW;')<>1
  OR strpos(guard,'RECORD_PURGE_PROOF_UNCONFIRMED')=0 OR strpos(guard,'RECORD_PURGE_JOB_IMMUTABLE')=0
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='ai.record_purge_jobs'::regclass AND t.tgname='record_purge_job_guard'
   AND t.tgfoid='ai.guard_record_purge_job()'::regprocedure AND t.tgenabled IN('O','A') AND NOT t.tgisinternal
   -- ROW (1), BEFORE (2), INSERT (4) and UPDATE (16).
   AND (t.tgtype::integer&(1|2|4|8|16|32))=(1|2|4|16)) THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_POSTCONDITION' USING ERRCODE='EN850',DETAIL='ai.guard_record_purge_job()';END IF;
 -- The attestation: invoker plpgsql, migrator-owned, pinned search_path, opening with its refusal, and
 -- EXECUTE for ensemus_app alone.
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='ai.attest_record_purge_completion(ai.record_purge_jobs,ai.record_purge_jobs)'::regprocedure
   AND p.prolang=(SELECT l.oid FROM pg_language l WHERE l.lanname='plpgsql') AND NOT p.prosecdef
   AND p.proowner='ensemus_migrator'::regrole::oid AND p.proconfig IS NOT NULL AND 'search_path=pg_catalog'=ANY(p.proconfig)
   AND p.prosrc ~ opening)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='ai.record_purge_completed(text,uuid,uuid)'::regprocedure
   AND p.prolang=(SELECT l.oid FROM pg_language l WHERE l.lanname='sql') AND NOT p.prosecdef AND p.provolatile='s'
   AND p.proowner='ensemus_migrator'::regrole::oid AND p.proconfig IS NOT NULL AND 'search_path=pg_catalog'=ANY(p.proconfig))
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid IN('ai.attest_record_purge_completion(ai.record_purge_jobs,ai.record_purge_jobs)'::regprocedure,
    'ai.record_purge_completed(text,uuid,uuid)'::regprocedure)
    AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND a.grantee<>'ensemus_app'::regrole::oid) THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_POSTCONDITION' USING ERRCODE='EN850',DETAIL='completion functions';END IF;
 -- ai.record_purge_completed recomputes 0419's snapshot. If that formula ever changes, refuse here
 -- instead of silently comparing a different hash (which would only ever re-prove, never skip, but
 -- would bring finding 3 back).
 SELECT p.prosrc INTO snapshot_source FROM pg_proc p WHERE p.oid='ai.lock_record_purge_snapshot(text,uuid)'::regprocedure;
 IF strpos(snapshot_source,$f$jsonb_build_object('protocol','record-purge-snapshot/v1','organizationId',app.current_organization_id(),$f$)=0
  OR strpos(snapshot_source,$f$'kind',catalog.record_kind,'id',catalog.record_id,'alive',catalog.alive,'classification',catalog.classification,'ownerMembershipId',catalog.owner_membership_id,$f$)=0
  OR strpos(snapshot_source,$f$'parentRecordId',catalog.parent_record_id,'tombstone',CASE WHEN tombstone_found THEN jsonb_build_object('reasonCode',tombstone.reason_code,'createdEpoch',tombstone.created_epoch) END)::text,'UTF8')),'hex');$f$)=0
  OR strpos(snapshot_source,$f$SELECT actual.reason_code,extract(epoch FROM actual.created_at)::text created_epoch INTO tombstone FROM platform.tombstones actual$f$)=0
  OR strpos(snapshot_source,$f$IF NOT catalog.alive OR tombstone_found THEN$f$)=0 THEN
  RAISE EXCEPTION 'RECORD_PURGE_COMPLETION_POSTCONDITION' USING ERRCODE='EN850',DETAIL='ai.lock_record_purge_snapshot(text,uuid)';END IF;
END $$;
