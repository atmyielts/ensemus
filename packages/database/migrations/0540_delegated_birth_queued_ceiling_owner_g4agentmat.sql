-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-028). Changes here need human review, never agent approval.
-- 0540 (g4 agent materials): additive repair for registered 0419 and 0536, which are pushed, so
-- neither is edited.
--
-- 1. 0536 replaced 0414's ai.run_company_ceiling after checking only current_user='ensemus_migrator'.
--    Its siblings also refuse a migrator that is a superuser or bypasses RLS, so a privileged session
--    can never write a reviewed security body. This migration carries that owner guard, confirms that
--    the function in force is 0536's (owner, invoker rights, STABLE, plpgsql, and 0536's first
--    statement), and writes 0536's exact body again under the guard. The text is unchanged: with no
--    run and no agent actor the answer is 0, which no class rank (1..4) satisfies, and an agent-actor
--    transaction without its run still raises AGENT_SCOPE_INVALID (EN119). Same signature, language
--    and volatility, so the OID, owner, the grants to ensemus_agent (0414) and ensemus_app (0419), and
--    every dependent policy are unchanged.
--
-- 2. 0419's ai.guard_delegated_work_birth_witness() refuses a delegated Work INSERT witness unless the
--    copied Work's status is 'draft'. work.work_units has never admitted that status: 0002's
--    work_units_status_check allows only queued, ready, running, blocked, awaiting_approval, verifying,
--    completed, failed and cancelled, and the column default is 'queued'. createChildRun (and every
--    other Work INSERT) leaves the status to that default. So every genuine delegated Work INSERT was
--    refused DELEGATED_WORK_INSERT_WITNESS_MISMATCH (EN119) before its reciprocal receipt could be
--    checked (CI run 42608913914, agent-delegated-materials 'records only an actual Work INSERT': EN119
--    where the deferred receipt FK's 23503 was expected). The guard meant "the untouched birth state",
--    which on the registered status set is 'queued'. The replacement is 0419's text with that one
--    literal changed; every other comparison (version 1, no objective, parent, owner, project, creator,
--    class, insert time, exact title hash, candidate, depth, actor and run) is unchanged. It refuses to
--    run if the status constraint ever admits 'draft' or the default stops being 'queued', so the
--    premise is checked, not assumed. Invoker rights, search_path pg_catalog and the PUBLIC revoke stay.
--
-- No table, policy, grant, role or stored row changes. Delegated child birth stays closed by 0414's
-- ai.delegation_influence_ready (false) until root qualifies the 0419 lifecycle; this only stops the
-- witness guard refusing the one status a fresh Work can have.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'RUN_CEILING_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('app.current_actor_type()') IS NULL OR to_regprocedure('knowledge.class_rank(text)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('ai.run_company_ceiling(uuid)') AND owner.rolname='ensemus_migrator' AND NOT owner.rolsuper
    AND NOT owner.rolbypassrls AND NOT p.prosecdef AND p.provolatile='s' AND l.lanname='plpgsql'
    AND position($q$IF p_run IS NULL AND app.current_actor_type() IS DISTINCT FROM 'agent' THEN RETURN 0;END IF;$q$ IN p.prosrc)>0) THEN
  RAISE EXCEPTION 'RUN_CEILING_PREREQUISITE_REQUIRED' USING ERRCODE='EN119';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
   WHERE p.oid=to_regprocedure('ai.guard_delegated_work_birth_witness()') AND owner.rolname='ensemus_migrator'
    AND NOT p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']
    AND position($q$body.status<>'draft'$q$ IN p.prosrc)>0)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='ai.delegated_work_births'::regclass
   AND t.tgname='delegated_work_birth_witness_guard' AND NOT t.tgisinternal
   AND t.tgfoid='ai.guard_delegated_work_birth_witness()'::regprocedure) THEN
  RAISE EXCEPTION 'DELEGATED_WITNESS_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
 -- The evidence for the repair: a Work row is born 'queued' and can never be 'draft'.
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='work.work_units'::regclass AND c.conname='work_units_status_check'
   AND position($q$'queued'$q$ IN pg_get_constraintdef(c.oid))>0 AND position($q$'draft'$q$ IN pg_get_constraintdef(c.oid))=0)
  OR NOT EXISTS(SELECT 1 FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
   WHERE d.adrelid='work.work_units'::regclass AND a.attname='status' AND pg_get_expr(d.adbin,d.adrelid)=$q$'queued'::text$q$) THEN
  RAISE EXCEPTION 'DELEGATED_WITNESS_STATUS_PREMISE_CHANGED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ai.run_company_ceiling(p_run uuid) RETURNS integer LANGUAGE plpgsql STABLE AS $$
DECLARE current_run uuid:=p_run;seen uuid[]:=ARRAY[]::uuid[];r record;previous_depth integer;scope text;node_ceiling integer;ceiling integer;rank integer;
BEGIN
  IF p_run IS NULL AND app.current_actor_type() IS DISTINCT FROM 'agent' THEN RETURN 0;END IF;
  LOOP
    IF current_run IS NULL OR current_run=ANY(seen) OR cardinality(seen)>=6 THEN RAISE EXCEPTION 'AGENT_SCOPE_INVALID' USING ERRCODE='EN119';END IF;
    seen:=array_append(seen,current_run);
    SELECT a.parent_run_id,a.depth,v.spec INTO r FROM ai.agent_runs a JOIN ai.agent_versions v
      ON v.organization_id=a.organization_id AND v.id=a.agent_version_id
      WHERE a.organization_id=app.current_organization_id() AND a.id=current_run AND a.initiator_membership_id=app.current_membership_id();
    IF NOT FOUND OR r.depth NOT BETWEEN 0 AND 5 OR(previous_depth IS NOT NULL AND r.depth<>previous_depth-1)
      OR jsonb_typeof(r.spec->'context'->'allowed_scopes') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'AGENT_SCOPE_INVALID' USING ERRCODE='EN119';END IF;
    IF jsonb_array_length(r.spec->'context'->'allowed_scopes')>1000 OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(r.spec->'context'->'allowed_scopes') x(value) WHERE jsonb_typeof(x.value)<>'string'
    ) THEN RAISE EXCEPTION 'AGENT_SCOPE_INVALID' USING ERRCODE='EN119';END IF;
    node_ceiling:=NULL;
    FOR scope IN SELECT value FROM jsonb_array_elements_text(r.spec->'context'->'allowed_scopes') x(value) LOOP
      IF lower(btrim(scope))='data' OR lower(btrim(scope)) LIKE 'data.%' THEN
        IF scope !~ '^data\.(public|internal|confidential|restricted)\.read$' THEN RAISE EXCEPTION 'AGENT_SCOPE_INVALID' USING ERRCODE='EN119';END IF;
        rank:=knowledge.class_rank(split_part(scope,'.',2));
        node_ceiling:=CASE WHEN node_ceiling IS NULL THEN rank ELSE greatest(node_ceiling,rank) END;
      END IF;
    END LOOP;
    IF node_ceiling IS NOT NULL THEN ceiling:=CASE WHEN ceiling IS NULL THEN node_ceiling ELSE least(ceiling,node_ceiling) END;END IF;
    IF r.parent_run_id IS NULL THEN
      IF r.depth<>0 THEN RAISE EXCEPTION 'AGENT_SCOPE_INVALID' USING ERRCODE='EN119';END IF;
      RETURN ceiling;
    END IF;
    previous_depth:=r.depth;current_run:=r.parent_run_id;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ai.guard_delegated_work_birth_witness() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE birth record;body work.work_units;parent_row record;
BEGIN
  IF TG_RELID<>'ai.delegated_work_births'::regclass OR TG_OP<>'INSERT' OR current_user<>'ensemus_agent'
    OR app.current_actor_type() IS DISTINCT FROM 'agent' OR pg_trigger_depth()<>2
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR NEW.parent_run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) THEN
    RAISE EXCEPTION 'DELEGATED_WORK_INSERT_WITNESS_DENIED' USING ERRCODE='42501';END IF;
  SELECT candidate.* INTO birth FROM ai.delegation_birth_candidate(NEW.parent_run_id,NEW.child_run_id) candidate;
  SELECT actual.* INTO body FROM work.work_units actual WHERE actual.organization_id=NEW.organization_id AND actual.id=NEW.work_unit_id;
  SELECT run.work_unit_id,run.initiator_membership_id,catalog.owner_membership_id,catalog.parent_record_id INTO parent_row
    FROM ai.agent_runs run JOIN knowledge.structured_record_catalog catalog ON catalog.organization_id=run.organization_id
      AND catalog.record_kind='work_unit' AND catalog.record_id=run.work_unit_id AND catalog.alive
    WHERE run.organization_id=NEW.organization_id AND run.id=NEW.parent_run_id;
  IF birth.child_work_unit_id IS NULL OR body.id IS NULL OR parent_row.work_unit_id IS NULL
    OR ROW(NEW.work_unit_id,NEW.parent_work_unit_id,NEW.proposal_id,NEW.snapshot_id,NEW.birth_content_sha256,NEW.classification,NEW.inserted_at)
      IS DISTINCT FROM ROW(birth.child_work_unit_id,parent_row.work_unit_id,birth.proposal_id,birth.snapshot_id,birth.birth_content_sha256,body.classification,body.created_at)
    -- 0540: a Work is born 'queued' (0002's default and status check); 0419 named 'draft', which no Work can hold.
    OR body.version<>1 OR body.status<>'queued' OR body.objective IS NOT NULL
    OR body.parent_id IS DISTINCT FROM parent_row.work_unit_id OR body.owner_membership_id IS DISTINCT FROM parent_row.owner_membership_id
    OR body.project_id IS DISTINCT FROM parent_row.parent_record_id OR body.created_by_membership_id IS DISTINCT FROM parent_row.initiator_membership_id
    OR encode(sha256(convert_to('{"objective":null,"title":'||to_json(body.title)::text||'}','UTF8')),'hex') IS DISTINCT FROM birth.birth_content_sha256 THEN
    RAISE EXCEPTION 'DELEGATED_WORK_INSERT_WITNESS_MISMATCH' USING ERRCODE='EN119';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_delegated_work_birth_witness() FROM PUBLIC;
