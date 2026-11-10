-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-028). Changes here need human review, never agent approval.
-- FLAGGED FOR HUMAN SECURITY REVIEW, not yet reviewed by a person
-- 0548 (deleg): ADR-028 open question 12, decided by the project owner on 2026-11-09 ("build it now").
-- Written as 0590 (reserved) and journaled as 0548 at idx 108 on merge. Edited in place once after that
-- push (CI run 42669475831): the RESTRICTIVE-policy premise also matched 0422's auth_restore_0422_* policies,
-- which apply only TO ensemus_operator/support/eraser (0999 extends them to every table those roles reach),
-- so 0548 raised DELEGATION_READINESS_PREMISE_CHANGED on every database and never applied anywhere. The
-- premise now considers only restrictive read policies that bind PUBLIC, ensemus_app or ensemus_agent,
-- which is the visibility the predicate's NOT EXISTS depends on.
--
-- Part 1 store: ai.delegation_birth_capabilities, append-only, written only by a non-superuser migrator
-- login session and read at runtime only through ai.delegation_birth_capability_on() (boolean). NO row is
-- written here, so every deployed database stays closed until a separate reviewed migration records the
-- qualification (CI run, commit, test tags). Part 2 replaces 0414's interim SELECT false body of
-- ai.delegation_influence_ready(uuid,uuid) in place: same OID, owner, invoker rights, STABLE, and the grant
-- to ensemus_agent only. ai.validate_delegation_birth, ai.guard_delegation_input_birth, 0414's unproven
-- inventory and every purge/serving guard are unchanged. The predicate reads metadata only, never a body.
--
-- Two evidence kinds. A 'deployment_migration' row (a reviewed migration citing a github-actions run, a
-- non-zero commit and the full tag set) counts in every database. A 'qualification_fixture' row (the
-- integration suites) can be appended, and counts, only while the cluster holds the NOLOGIN role
-- ensemus_delegation_qualification_ci. Only a superuser or a CREATEROLE identity can create a role, and
-- the premises below require that no Ensemus role has either, so no migration and no runtime session can
-- create the marker: it is an installation-time fact. CI's test setup creates it; no install script does.
--
-- The ledger has no UPDATE or DELETE policy, so under FORCE RLS a migrator UPDATE or DELETE matches no
-- row at all. The append-only trigger is the second layer: it refuses UPDATE and DELETE from any session
-- that bypasses RLS, and TRUNCATE (which RLS does not cover) from every session. Neither layer binds the
-- ledger's owner or a superuser: the migrator owns the table and its functions, so it can disable the
-- trigger, drop a policy or replace ai.delegation_birth_capability_on(), and a superuser bypasses all of
-- it. The ledger is exactly as strong as the migrator credential and the superuser.
DO $$ DECLARE readiness regprocedure:=to_regprocedure('ai.delegation_influence_ready(uuid,uuid)');BEGIN
 IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator'
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'DELEGATION_READINESS_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF readiness IS NULL
  OR (SELECT count(*) FROM pg_proc WHERE pronamespace='ai'::regnamespace AND proname IN('delegation_influence_ready','delegation_birth_capability_on'))<>1
  OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=readiness AND owner.rolname='ensemus_migrator' AND NOT owner.rolsuper AND NOT owner.rolbypassrls AND NOT p.prosecdef
    AND p.provolatile='s' AND l.lanname='sql' AND p.proconfig IS NULL AND p.prorettype='boolean'::regtype
    AND p.proargnames=ARRAY['p_parent','p_child']::text[] AND btrim(regexp_replace(p.prosrc,'\s+',' ','g'))='SELECT false')
  OR (SELECT array_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid=readiness AND a.privilege_type='EXECUTE') IS DISTINCT FROM ARRAY['ensemus_agent','ensemus_migrator'] THEN
  RAISE EXCEPTION 'DELEGATION_READINESS_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('ai.guard_delegation_input_birth()') AND NOT p.prosecdef
    AND p.proconfig=ARRAY['search_path=pg_catalog']
    AND position($q$IF current_user<>'ensemus_agent' THEN$q$ IN p.prosrc)>0
    AND position($q$NOT ai.delegation_influence_ready(NEW.parent_run_id,NEW.id) OR NOT ai.validate_delegation_birth(NEW)$q$ IN p.prosrc)>0)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='ai.agent_runs'::regclass AND t.tgname='delegation_input_birth' AND NOT t.tgisinternal
    AND t.tgenabled='O' AND t.tgfoid='ai.guard_delegation_input_birth()'::regprocedure AND (t.tgtype::integer & 7)=7)
  OR to_regprocedure('ai.validate_delegation_birth(ai.agent_runs)') IS NULL
  OR to_regprocedure('app.current_actor_type()') IS NULL OR to_regprocedure('app.current_organization_id()') IS NULL
  OR to_regprocedure('app.current_membership_id()') IS NULL THEN
  RAISE EXCEPTION 'DELEGATION_BIRTH_GUARD_REQUIRED' USING ERRCODE='EN850';END IF;
 -- Premises: the 0414 inventory cannot shrink, a fence cannot be undone, no Ensemus role can create an
 -- overload in schema ai or app or create a role (so none can mint the CI marker), the agent may read
 -- every metadata column and call every app.* helper the predicate uses, and RLS shows the agent its
 -- tenant's inventory rows. That last premise matters because the predicate's inventory clause is a NOT
 -- EXISTS: if the agent could not see the rows it would pass vacuously. Visibility comes only from 0414's
 -- permissive child_input_read policy TO ensemus_app, inherited through the agent's membership, so the
 -- policy's exact shape and the absence of any RESTRICTIVE read policy are checked here. A later migration
 -- that changes either must re-establish this premise; the superuser inventory case in
 -- delegation-birth-readiness.test.ts is the runtime negative that would then fail.
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='ai.unproven_child_work_inputs'::regclass AND t.tgname='unproven_child_inputs_keep' AND t.tgenabled='O')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='ai.unproven_child_work_inputs'::regclass AND t.tgname='unproven_child_inputs_no_truncate' AND t.tgenabled='O')
  OR has_table_privilege('ensemus_agent','ai.unproven_child_work_inputs','INSERT,UPDATE,DELETE,TRUNCATE')
  OR EXISTS(SELECT 1 FROM (VALUES('ai.unproven_child_work_inputs','organization_id'),('ai.unproven_child_work_inputs','work_unit_id'),
     ('ai.run_input_checkpoints','organization_id'),('ai.run_input_checkpoints','run_id'),('ai.run_input_checkpoints','history_complete'),
     ('ai.run_input_checkpoints','protocol_version'),('ai.run_input_checkpoints','fenced_at'),
     ('ai.agent_runs','id'),('ai.agent_runs','organization_id'),('ai.agent_runs','initiator_membership_id'),
     ('ai.agent_runs','status'),('ai.agent_runs','work_unit_id')) used(rel,col)
    WHERE NOT has_column_privilege('ensemus_agent',used.rel,used.col,'SELECT'))
  OR NOT has_function_privilege('ensemus_agent','app.current_actor_type()','EXECUTE')
  OR NOT has_function_privilege('ensemus_agent','app.current_organization_id()','EXECUTE')
  OR NOT has_function_privilege('ensemus_agent','app.current_membership_id()','EXECUTE')
  OR NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='ai.unproven_child_work_inputs'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
  OR NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='ai.unproven_child_work_inputs'::regclass AND p.polname='child_input_read'
    AND p.polpermissive AND p.polcmd='r' AND p.polroles=ARRAY['ensemus_app'::regrole::oid]
    AND regexp_replace(pg_get_expr(p.polqual,p.polrelid),'\s+','','g')='(organization_id=app.current_organization_id())')
  OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='ai.unproven_child_work_inputs'::regclass AND NOT p.polpermissive AND p.polcmd IN('r','*')
    AND p.polroles && ARRAY[0::oid,'ensemus_app'::regrole::oid,'ensemus_agent'::regrole::oid])
  OR NOT pg_has_role('ensemus_agent','ensemus_app','USAGE')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='ai.run_input_checkpoints'::regclass
    AND t.tgname='run_input_checkpoint_immutable' AND t.tgenabled='O'
    AND position($q$(OLD.fenced_at IS NOT NULL AND NEW.fenced_at IS DISTINCT FROM OLD.fenced_at)$q$ IN p.prosrc)>0)
  OR EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN unnest(ARRAY['ai','app']) s(nspname)
    WHERE r.rolname IN('ensemus_app','ensemus_agent','ensemus_auth','ensemus_dispatcher','ensemus_secrets',
      'ensemus_operator','ensemus_support','ensemus_eraser') AND has_schema_privilege(r.oid,s.nspname,'CREATE'))
  OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN('ensemus_migrator','ensemus_app','ensemus_agent','ensemus_auth','ensemus_dispatcher',
      'ensemus_secrets','ensemus_operator','ensemus_support','ensemus_eraser') AND(r.rolsuper OR r.rolcreaterole OR r.rolbypassrls))
  OR to_regclass('ai.delegation_birth_capabilities') IS NOT NULL THEN
  RAISE EXCEPTION 'DELEGATION_READINESS_PREMISE_CHANGED' USING ERRCODE='EN850';END IF;
 PERFORM set_config('ensemus.deleg_readiness_oid',readiness::oid::text,false);
END $$;
--> statement-breakpoint
CREATE TABLE ai.delegation_birth_capabilities (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  state text NOT NULL,evidence_kind text NOT NULL,migration_tag text,ci_run_id text NOT NULL,source_commit text NOT NULL,
  qualification_tests text[] NOT NULL,review_ref text NOT NULL,
  recorded_by name NOT NULL DEFAULT session_user,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT delegation_birth_capabilities_pk PRIMARY KEY(seq),
  CONSTRAINT delegation_birth_capabilities_state CHECK(state IN('qualified','revoked')),
  CONSTRAINT delegation_birth_capabilities_kind CHECK(evidence_kind IN('deployment_migration','qualification_fixture')),
  CONSTRAINT delegation_birth_capabilities_migration CHECK((evidence_kind='deployment_migration')=(migration_tag IS NOT NULL)
    AND(migration_tag IS NULL OR migration_tag ~ '^[0-9]{4}_[a-z0-9_]{1,80}$')),
  CONSTRAINT delegation_birth_capabilities_ci CHECK(CASE evidence_kind WHEN 'deployment_migration' THEN ci_run_id ~ '^github-actions:[0-9]{6,20}$'
    ELSE ci_run_id ~ '^fixture:[A-Za-z0-9_.-]{1,64}$' END),
  CONSTRAINT delegation_birth_capabilities_commit CHECK(source_commit ~ '^[0-9a-f]{40}$'
    AND(evidence_kind<>'deployment_migration' OR source_commit !~ '^0{40}$')),
  CONSTRAINT delegation_birth_capabilities_review CHECK(length(review_ref) BETWEEN 1 AND 300),
  CONSTRAINT delegation_birth_capabilities_by CHECK(recorded_by='ensemus_migrator'),
  CONSTRAINT delegation_birth_capabilities_tests CHECK(state='revoked' OR qualification_tests @> ARRAY['ADR028-Q12-L1','ADR028-Q12-L2',
    'ADR028-Q12-L3','ADR028-Q12-L4','ADR028-Q12-L5','ADR028-Q12-L6','ADR028-Q12-L7','ADR028-Q12-L8a','ADR028-Q12-L8b','ADR028-Q12-P2']::text[])
);
ALTER TABLE ai.delegation_birth_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.delegation_birth_capabilities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ai.delegation_birth_capabilities FROM PUBLIC;
CREATE POLICY delegation_capability_migrator_read ON ai.delegation_birth_capabilities FOR SELECT TO ensemus_migrator
  USING(current_user='ensemus_migrator');
CREATE POLICY delegation_capability_migrator_append ON ai.delegation_birth_capabilities FOR INSERT TO ensemus_migrator
  WITH CHECK(current_user='ensemus_migrator' AND session_user='ensemus_migrator');
CREATE FUNCTION ai.keep_delegation_birth_capabilities() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'ai.delegation_birth_capabilities'::regclass THEN
    RAISE EXCEPTION 'DELEGATION_CAPABILITY_TARGET' USING ERRCODE='42501';END IF;
  IF TG_OP='INSERT' THEN
    IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_migrator' OR pg_trigger_depth()<>1
      OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN(current_user,session_user) AND(rolsuper OR rolbypassrls)) THEN
      RAISE EXCEPTION 'DELEGATION_CAPABILITY_WRITER' USING ERRCODE='42501';END IF;
    -- A fixture row is CI evidence only: refused outright where the installation-time marker is absent.
    IF NEW.evidence_kind='qualification_fixture' AND NOT EXISTS(SELECT 1 FROM pg_roles marker
      WHERE marker.rolname='ensemus_delegation_qualification_ci' AND NOT marker.rolcanlogin AND NOT marker.rolsuper
        AND NOT marker.rolcreaterole AND NOT marker.rolbypassrls) THEN
      RAISE EXCEPTION 'DELEGATION_CAPABILITY_FIXTURE_OUTSIDE_QUALIFICATION' USING ERRCODE='42501';END IF;
    NEW.recorded_by:=session_user;NEW.recorded_at:=clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'DELEGATION_CAPABILITY_APPEND_ONLY' USING ERRCODE='EN119';
END $$;
REVOKE ALL ON FUNCTION ai.keep_delegation_birth_capabilities() FROM PUBLIC;
CREATE TRIGGER delegation_birth_capabilities_keep BEFORE INSERT OR UPDATE OR DELETE ON ai.delegation_birth_capabilities
  FOR EACH ROW EXECUTE FUNCTION ai.keep_delegation_birth_capabilities();
CREATE TRIGGER delegation_birth_capabilities_no_truncate BEFORE TRUNCATE ON ai.delegation_birth_capabilities
  FOR EACH STATEMENT EXECUTE FUNCTION ai.keep_delegation_birth_capabilities();
-- Zero arguments, constant search_path, boolean only: nothing a caller passes can steer it. The latest
-- counting row wins. A fixture row counts only while the CI marker role exists, so in a database without
-- it (every install) only deployment_migration rows decide, and a fixture row (if one were ever left
-- behind) is ignored, never a switch.
CREATE FUNCTION ai.delegation_birth_capability_on() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT coalesce((SELECT latest.state='qualified' FROM ai.delegation_birth_capabilities latest
    WHERE latest.evidence_kind='deployment_migration'
      OR (latest.evidence_kind='qualification_fixture' AND EXISTS(SELECT 1 FROM pg_roles marker
        WHERE marker.rolname='ensemus_delegation_qualification_ci' AND NOT marker.rolcanlogin AND NOT marker.rolsuper
          AND NOT marker.rolcreaterole AND NOT marker.rolbypassrls))
    ORDER BY latest.seq DESC LIMIT 1),false)
$$;
REVOKE ALL ON FUNCTION ai.delegation_birth_capability_on() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.delegation_birth_capability_on() TO ensemus_agent;
--> statement-breakpoint
-- ADR-028 part 2. Same name, argument names, types and return type: the OID, owner and the 0414 grant survive.
-- 'Live' is running or waiting_for_child, the two statuses ai.delegation_birth_candidate admits. The
-- unproven clause names the PARENT's Work; 0414 recorded each legacy CHILD's Work, so a legacy child can
-- never act as a parent. Inside the 0419 BEFORE INSERT guard the child row does not exist yet, so the
-- p_child clause only does work when the function is called on its own.
CREATE OR REPLACE FUNCTION ai.delegation_influence_ready(p_parent uuid,p_child uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(
    current_user='ensemus_agent' AND session_user='ensemus_agent' AND app.current_actor_type()='agent'
    AND p_parent IS NOT NULL AND p_child IS NOT NULL AND p_child<>p_parent
    AND app.current_organization_id() IS NOT NULL
    AND current_setting('app.agent_run_id',true)=p_parent::text
    AND current_setting('app.agent_scope_protocol',true)=('scoped-v1:'||p_parent::text)
    AND ai.delegation_birth_capability_on()
    AND EXISTS(
      SELECT 1 FROM ai.agent_runs parent
        JOIN ai.run_input_checkpoints checkpoint
          ON checkpoint.organization_id=parent.organization_id AND checkpoint.run_id=parent.id
      WHERE parent.organization_id=app.current_organization_id() AND parent.id=p_parent
        AND parent.initiator_membership_id=app.current_membership_id()
        AND parent.status IN('running','waiting_for_child')
        AND checkpoint.history_complete AND checkpoint.protocol_version='v1' AND checkpoint.fenced_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM ai.unproven_child_work_inputs unproven
          WHERE unproven.organization_id=parent.organization_id AND unproven.work_unit_id=parent.work_unit_id))
    AND NOT EXISTS(SELECT 1 FROM ai.agent_runs existing
      WHERE existing.organization_id=app.current_organization_id() AND existing.id=p_child),
  false)
$$;
REVOKE ALL ON FUNCTION ai.delegation_influence_ready(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE readiness regprocedure:=to_regprocedure('ai.delegation_influence_ready(uuid,uuid)');
  capability regprocedure:=to_regprocedure('ai.delegation_birth_capability_on()');BEGIN
 IF readiness IS NULL OR readiness::oid::text IS DISTINCT FROM current_setting('ensemus.deleg_readiness_oid',true)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=readiness AND owner.rolname='ensemus_migrator' AND NOT p.prosecdef AND p.provolatile='s' AND l.lanname='sql'
    AND p.proconfig=ARRAY['search_path=pg_catalog'] AND position('ai.delegation_birth_capability_on()' IN p.prosrc)>0
    AND position('ai.unproven_child_work_inputs' IN p.prosrc)>0)
  OR (SELECT array_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid=readiness) IS DISTINCT FROM ARRAY['ensemus_agent','ensemus_migrator']
  OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=capability
    AND owner.rolname='ensemus_migrator' AND p.prosecdef AND p.provolatile='s' AND p.pronargs=0 AND p.proconfig=ARRAY['search_path=pg_catalog']
    AND position($q$latest.evidence_kind='deployment_migration'$q$ IN p.prosrc)>0
    AND position('ensemus_delegation_qualification_ci' IN p.prosrc)>0)
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='ai.keep_delegation_birth_capabilities()'::regprocedure
    AND position('DELEGATION_CAPABILITY_FIXTURE_OUTSIDE_QUALIFICATION' IN p.prosrc)>0)
  OR (SELECT array_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid=capability) IS DISTINCT FROM ARRAY['ensemus_agent','ensemus_migrator']
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.oid='ai.delegation_birth_capabilities'::regclass AND a.grantee::regrole::text<>'ensemus_migrator')
  OR NOT(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='ai.delegation_birth_capabilities'::regclass)
  OR (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid='ai.delegation_birth_capabilities'::regclass AND NOT t.tgisinternal AND t.tgenabled='O'
    AND t.tgfoid='ai.keep_delegation_birth_capabilities()'::regprocedure)<>2
  OR EXISTS(SELECT 1 FROM ai.delegation_birth_capabilities) THEN
  RAISE EXCEPTION 'DELEGATION_READINESS_POSTCONDITION' USING ERRCODE='EN850';END IF;
 PERFORM set_config('ensemus.deleg_readiness_oid','',false);
END $$;
