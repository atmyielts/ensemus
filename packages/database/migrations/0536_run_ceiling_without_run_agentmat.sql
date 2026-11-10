-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-028). Changes here need human review, never agent approval.
-- 0536 (agent materials): additive repair for registered 0414, which is pushed, so it is not edited.
--
-- 0414's ai.run_company_ceiling raises AGENT_SCOPE_INVALID (EN119) for a NULL run. 0417's
-- authority_project_body, authority_client_body and authority_artifact_body (TO ensemus_agent) call it
-- with nullif(app.agent_run_id,'')::uuid behind `app.current_actor_type() IS DISTINCT FROM 'agent' OR
-- ...`, relying on that first arm for every non-agent actor. The planner does not honour that order:
-- to estimate `class_rank(...) <= ai.run_company_ceiling(...)` it folds the constant-argument STABLE
-- call (estimate_expression_value), which runs it. So planning any query that reads work.projects,
-- work.clients or work.artifacts in a non-agent transaction on the agent role raises, whatever the
-- data. 0501's lifecycle.target_is_held reads work.projects, and refuse_held_tombstone calls it on
-- every platform.tombstones INSERT, so the service-context tombstone that the agent pool writes after a
-- fulfilled put whose publication failed (recordFulfilledGeneratedPutFailure) could never be written:
-- the file stayed unblocked instead of being blocked and tombstoned.
--
-- The body below is 0414's with one added first statement. With no run and no agent actor there is no
-- run whose manifest could grant a class, so the answer is 0, which no class rank (1..4) satisfies.
-- Every existing caller already refuses or skips that case before the value matters: 0414's
-- agent_scope_protocol_read and 0417's authority_*_body admit a non-agent actor on their first arm,
-- 0419's delegated_company_source_scope requires ai.run_authority_read_admitted (false without a run)
-- or a legacy run, 0417's lock_read_authority runs only for the bound run's own read-authority capture,
-- and 0419's lock_prospective_input_scope refuses a NULL run first. An agent-actor transaction without
-- its run still raises AGENT_SCOPE_INVALID exactly as before, and every run lookup is unchanged.
-- Same signature, language and volatility, so the OID, grants and dependent policies are unchanged.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR to_regprocedure('ai.run_company_ceiling(uuid)') IS NULL
  OR to_regprocedure('app.current_actor_type()') IS NULL THEN
  RAISE EXCEPTION 'RUN_CEILING_PREREQUISITE_REQUIRED' USING ERRCODE='EN119';END IF;
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
