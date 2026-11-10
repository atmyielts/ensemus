-- Exact trusted main-attempt input prefixes. Requires 0214,0216,0411,0414.
-- First source checkpoint intentionally leaves 0414 child birth/serving/purge gates closed.
-- No prompt, tool arguments, title, claim or provider output is copied into these relations.
CREATE TABLE ai.main_input_snapshots (
  organization_id uuid NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,step_id uuid NOT NULL,
  attempt integer NOT NULL,reservation_attempt integer NOT NULL,writer_token uuid NOT NULL,
  request_hash text NOT NULL,profile_id uuid NOT NULL,profile_version integer NOT NULL,
  viewer_membership_id uuid NOT NULL,input_inventory jsonb NOT NULL,inventory_sha256 text NOT NULL,
  state text NOT NULL DEFAULT 'prepared',result_kind text,result_tool_id text,result_payload_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT main_input_snapshots_pk PRIMARY KEY(organization_id,id),
  CONSTRAINT main_input_snapshots_attempt_key UNIQUE(organization_id,run_id,step_id,attempt,reservation_attempt),
  CONSTRAINT main_input_snapshots_run_fk FOREIGN KEY(organization_id,run_id) REFERENCES ai.agent_runs(organization_id,id),
  CONSTRAINT main_input_snapshots_step_fk FOREIGN KEY(organization_id,step_id) REFERENCES ai.execution_steps(organization_id,id),
  CONSTRAINT main_input_snapshots_profile_fk FOREIGN KEY(organization_id,profile_id) REFERENCES ai.model_profiles(organization_id,id),
  CONSTRAINT main_input_snapshots_identity CHECK(attempt>0 AND reservation_attempt>=attempt AND profile_version>0
    AND request_hash ~ '^[0-9a-f]{64}$' AND inventory_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT main_input_snapshots_inventory CHECK(jsonb_typeof(input_inventory)='array' AND jsonb_array_length(input_inventory) BETWEEN 1 AND 1000 AND octet_length(input_inventory::text)<=1048576),
  CONSTRAINT main_input_snapshots_state CHECK((state IN('prepared','dispatched') AND result_kind IS NULL AND result_tool_id IS NULL AND result_payload_hash IS NULL)
    OR(state='response_received' AND result_payload_hash IS NOT NULL AND result_payload_hash ~ '^[0-9a-f]{64}$' AND result_kind IS NOT NULL AND ((result_kind='final' AND result_tool_id IS NULL) OR(result_kind='tool_call' AND result_tool_id IS NOT NULL))))
);
CREATE TABLE ai.model_proposal_inputs (
  organization_id uuid NOT NULL,proposal_id uuid NOT NULL,snapshot_id uuid NOT NULL,
  CONSTRAINT model_proposal_inputs_pk PRIMARY KEY(organization_id,proposal_id),
  CONSTRAINT model_proposal_inputs_proposal_fk FOREIGN KEY(organization_id,proposal_id) REFERENCES ai.tool_proposals(organization_id,id),
  CONSTRAINT model_proposal_inputs_snapshot_fk FOREIGN KEY(organization_id,snapshot_id) REFERENCES ai.main_input_snapshots(organization_id,id)
);
ALTER TABLE ai.main_input_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.main_input_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.model_proposal_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.model_proposal_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY snapshot_tenant_read ON ai.main_input_snapshots FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY snapshot_own_write ON ai.main_input_snapshots TO ensemus_agent
  USING(organization_id=app.current_organization_id() AND app.current_actor_type()='agent' AND run_id::text=current_setting('app.agent_run_id',true))
  WITH CHECK(organization_id=app.current_organization_id() AND app.current_actor_type()='agent' AND run_id::text=current_setting('app.agent_run_id',true));
CREATE POLICY proposal_input_tenant_read ON ai.model_proposal_inputs FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY proposal_input_append ON ai.model_proposal_inputs FOR INSERT TO ensemus_agent WITH CHECK(organization_id=app.current_organization_id() AND app.current_actor_type()='agent');
-- Runtime writer token stays agent-private. All other values are content-free retained authority.
GRANT SELECT(organization_id,id,run_id,step_id,attempt,reservation_attempt,request_hash,profile_id,profile_version,viewer_membership_id,input_inventory,inventory_sha256,state,result_kind,result_tool_id,result_payload_hash,created_at) ON ai.main_input_snapshots TO ensemus_app;
GRANT SELECT(writer_token),INSERT,UPDATE(state,result_kind,result_tool_id,result_payload_hash) ON ai.main_input_snapshots TO ensemus_agent;
GRANT SELECT ON ai.model_proposal_inputs TO ensemus_app;
GRANT INSERT ON ai.model_proposal_inputs TO ensemus_agent;
CREATE TABLE knowledge.evidence_package_facts (
  organization_id uuid NOT NULL,package_id uuid NOT NULL,fact_id uuid NOT NULL,content_sha256 text NOT NULL,classification text NOT NULL,
  CONSTRAINT evidence_package_facts_pk PRIMARY KEY(organization_id,package_id,fact_id),
  CONSTRAINT evidence_package_facts_package_fk FOREIGN KEY(organization_id,package_id) REFERENCES knowledge.evidence_packages(organization_id,id),
  CONSTRAINT evidence_package_facts_hash CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT evidence_package_facts_class CHECK(classification IN('public','internal','confidential','restricted'))
);
ALTER TABLE knowledge.evidence_package_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.evidence_package_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY package_facts_tenant ON knowledge.evidence_package_facts TO ensemus_app
  USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON knowledge.evidence_package_facts TO ensemus_app;
CREATE FUNCTION knowledge.guard_evidence_package_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;f record;
BEGIN
  IF TG_RELID<>'knowledge.evidence_package_facts'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_type() NOT IN('user','delegated','agent') THEN RAISE EXCEPTION 'PACKAGE_FACT_TARGET' USING ERRCODE='42501';END IF;
  SELECT * INTO p FROM knowledge.evidence_packages WHERE organization_id=NEW.organization_id AND id=NEW.package_id;
  SELECT id,classification,trust_state INTO f FROM knowledge.facts WHERE organization_id=NEW.organization_id AND id=NEW.fact_id FOR SHARE;
  IF p.id IS NULL OR f.id IS NULL OR p.viewer_membership_id IS DISTINCT FROM app.current_membership_id() OR NOT(NEW.fact_id=ANY(p.verified_fact_ids))
    OR f.trust_state<>'verified' OR knowledge.class_rank(NEW.classification)<knowledge.class_rank(f.classification)
    OR NOT EXISTS(SELECT 1 FROM knowledge.fact_evidence e WHERE e.organization_id=NEW.organization_id AND e.fact_id=NEW.fact_id)
    OR EXISTS(SELECT 1 FROM knowledge.fact_evidence e WHERE e.organization_id=NEW.organization_id AND e.fact_id=NEW.fact_id AND NOT EXISTS(
      SELECT 1 FROM knowledge.evidence_items i WHERE i.organization_id=e.organization_id AND i.package_id=NEW.package_id AND i.chunk_id=e.chunk_id AND i.source_id=e.source_id AND i.content_sha256=e.content_sha256)) THEN
    RAISE EXCEPTION 'PACKAGE_FACT_INPUT_STALE' USING ERRCODE='EN119';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_evidence_package_fact() FROM PUBLIC;
CREATE TRIGGER evidence_package_fact_guard BEFORE INSERT ON knowledge.evidence_package_facts FOR EACH ROW EXECUTE FUNCTION knowledge.guard_evidence_package_fact();
CREATE TRIGGER evidence_package_fact_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON knowledge.evidence_package_facts FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- Frozen metadata only. Historical hashes are retained without equality against mutable records.
-- Current parent authority refs have no body hash: they are not fabricated historical reads.
CREATE FUNCTION ai.current_main_input_inventory(p_run uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH observations AS(
    SELECT o.input_kind kind,o.input_id id,o.input_sha256 hash,o.classification FROM ai.run_input_observations o
      WHERE o.organization_id=app.current_organization_id() AND o.run_id=p_run
      ORDER BY o.input_kind COLLATE "C",o.input_id,o.input_sha256 COLLATE "C" LIMIT 1001
  ),nodes AS(
    SELECT id,hash FROM observations WHERE kind='artifact'
    UNION SELECT i.input_artifact_id,i.input_sha256 FROM knowledge.artifact_lineage_inputs i JOIN observations o ON o.kind='artifact' AND o.id=i.artifact_id WHERE i.organization_id=app.current_organization_id()
  ),packages AS(
    SELECT p.id FROM knowledge.evidence_packages p WHERE p.organization_id=app.current_organization_id() AND p.run_id=p_run
    UNION SELECT b.package_id FROM knowledge.artifact_lineage_packages b JOIN nodes n ON n.id=b.artifact_id WHERE b.organization_id=app.current_organization_id()
    UNION SELECT p.id FROM knowledge.evidence_packages p JOIN knowledge.artifact_lineage l ON l.organization_id=p.organization_id AND l.execution_kind='agent_run' AND l.execution_id=p.run_id JOIN nodes n ON n.id=l.artifact_id WHERE p.organization_id=app.current_organization_id()
  ),calls AS(
    SELECT c.id,c.request_hash,c.classification FROM ai.model_call_attempts c WHERE c.organization_id=app.current_organization_id() AND c.run_id=p_run
  ),chunks AS(
    SELECT i.chunk_id id,i.content_sha256 hash,i.classification,i.source_id,i.document_id FROM knowledge.evidence_items i JOIN packages p ON p.id=i.package_id WHERE i.organization_id=app.current_organization_id()
    UNION SELECT i.chunk_id,i.content_sha256,a.classification,i.source_id,i.document_id FROM knowledge.artifact_citations i JOIN nodes n ON n.id=i.artifact_id JOIN knowledge.artifact_acl_catalog a ON a.organization_id=i.organization_id AND a.artifact_id=i.artifact_id WHERE i.organization_id=app.current_organization_id()
    UNION SELECT i.input_id,i.sha256,i.classification,i.source_id,c.document_id FROM ai.model_call_inputs i JOIN calls a ON a.id=i.call_id LEFT JOIN knowledge.chunks c ON c.organization_id=i.organization_id AND c.id=i.input_id WHERE i.organization_id=app.current_organization_id() AND i.kind='chunk'
  ),records AS(
    SELECT kind,id,hash,classification FROM observations WHERE kind<>'artifact'
    UNION SELECT r.record_kind,r.record_id,r.record_sha256,r.classification FROM knowledge.artifact_lineage_records r JOIN nodes n ON n.id=r.artifact_id WHERE r.organization_id=app.current_organization_id()
    UNION SELECT i.kind,i.input_id,i.sha256,i.classification FROM ai.model_call_inputs i JOIN calls c ON c.id=i.call_id WHERE i.organization_id=app.current_organization_id() AND i.kind<>'chunk'
  ),projects AS(
    SELECT id FROM records WHERE kind='project'
    UNION SELECT c.parent_record_id FROM knowledge.structured_record_catalog c JOIN records r ON r.kind='work_unit' AND r.id=c.record_id WHERE c.organization_id=app.current_organization_id() AND c.record_kind='work_unit' AND c.parent_record_id IS NOT NULL
  ),authority AS(
    SELECT kind,id FROM records
    UNION SELECT 'project',id FROM projects
    UNION SELECT 'client',c.parent_record_id FROM knowledge.structured_record_catalog c JOIN projects p ON p.id=c.record_id WHERE c.organization_id=app.current_organization_id() AND c.record_kind='project' AND c.parent_record_id IS NOT NULL
  ),sources AS(
    SELECT source_id id FROM chunks
    UNION SELECT s.source_id FROM knowledge.artifact_lineage_sources s JOIN nodes n ON n.id=s.artifact_id WHERE s.organization_id=app.current_organization_id()
  ),entries AS(
    SELECT kind,id,hash,classification,NULL::uuid source_id,NULL::uuid document_id FROM observations
    UNION SELECT 'artifact',n.id,n.hash,a.classification,NULL::uuid,NULL::uuid FROM nodes n JOIN knowledge.artifact_acl_catalog a ON a.organization_id=app.current_organization_id() AND a.artifact_id=n.id
    UNION SELECT kind,id,hash,classification,NULL::uuid,NULL::uuid FROM records
    UNION SELECT 'evidence_package',p.id,p.package_sha256,p.strongest_classification,NULL::uuid,NULL::uuid FROM knowledge.evidence_packages p JOIN packages i ON i.id=p.id WHERE p.organization_id=app.current_organization_id()
    UNION SELECT 'fact',f.fact_id,f.content_sha256,f.classification,NULL::uuid,NULL::uuid FROM knowledge.evidence_package_facts f JOIN packages p ON p.id=f.package_id WHERE f.organization_id=app.current_organization_id()
    -- A legacy package is not promoted by looking up its current claims. Missing real receipts
    -- remain an explicit invalid entry; the snapshot guard refuses before any model reservation.
    UNION SELECT 'unproven_fact',v.id,NULL,NULL,NULL::uuid,NULL::uuid FROM knowledge.evidence_packages p JOIN packages i ON i.id=p.id CROSS JOIN LATERAL unnest(p.verified_fact_ids) v(id)
      WHERE p.organization_id=app.current_organization_id() AND NOT EXISTS(SELECT 1 FROM knowledge.evidence_package_facts f WHERE f.organization_id=p.organization_id AND f.package_id=p.id AND f.fact_id=v.id)
    UNION SELECT 'model_call',id,request_hash,classification,NULL::uuid,NULL::uuid FROM calls
    UNION SELECT 'chunk',id,hash,classification,source_id,document_id FROM chunks
    UNION SELECT 'source',s.id,NULL,s.classification,s.id,NULL::uuid FROM knowledge.sources s JOIN sources i ON i.id=s.id WHERE s.organization_id=app.current_organization_id()
    UNION SELECT 'document',d.id,d.content_sha256,d.classification,d.source_id,d.id FROM knowledge.documents d WHERE d.organization_id=app.current_organization_id() AND d.id IN(SELECT document_id FROM chunks)
    UNION SELECT 'authority_'||kind,id,NULL,knowledge.structured_record_class(kind,id),NULL::uuid,NULL::uuid FROM authority
  ),bounded AS(
    SELECT jsonb_build_object('kind',kind,'id',id,'sha256',hash,'classification',classification,'sourceId',source_id,'documentId',document_id) entry FROM entries
    ORDER BY kind COLLATE "C",id,hash COLLATE "C",classification COLLATE "C",source_id,document_id LIMIT 1001
  ) SELECT coalesce(jsonb_agg(entry ORDER BY entry::text COLLATE "C"),'[]'::jsonb) FROM bounded
$$;
REVOKE ALL ON FUNCTION ai.current_main_input_inventory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.current_main_input_inventory(uuid) TO ensemus_agent;
--> statement-breakpoint
CREATE FUNCTION ai.guard_main_input_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;inventory jsonb;
BEGIN
  IF TG_RELID<>'ai.main_input_snapshots'::regclass OR TG_OP NOT IN('INSERT','UPDATE') OR current_user<>'ensemus_agent'
    OR app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR NEW.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR NEW.viewer_membership_id IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'MAIN_SNAPSHOT_TARGET' USING ERRCODE='42501';END IF;
  PERFORM 1 FROM ai.run_input_checkpoints WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id FOR SHARE;
  SELECT e.kind,e.state,e.attempt,r.initiator_membership_id INTO s FROM ai.execution_steps e JOIN ai.agent_runs r ON r.organization_id=e.organization_id AND r.id=e.run_id
    WHERE e.organization_id=NEW.organization_id AND e.id=NEW.step_id AND e.run_id=NEW.run_id FOR SHARE OF e NOWAIT;
  IF NOT FOUND OR s.kind<>'model_turn' OR s.state<>'in_flight' OR s.attempt<>NEW.attempt OR s.initiator_membership_id<>NEW.viewer_membership_id OR NOT ai.run_input_admitted(NEW.run_id)
    OR NOT ai.run_inputs_readable(NEW.run_id,NEW.viewer_membership_id) THEN
    RAISE EXCEPTION 'MAIN_SNAPSHOT_ATTEMPT_STALE' USING ERRCODE='EN119';END IF;
  IF TG_OP='INSERT' THEN
    inventory:=ai.current_main_input_inventory(NEW.run_id);
    IF NEW.state<>'prepared' OR NEW.input_inventory IS DISTINCT FROM inventory OR jsonb_array_length(inventory) NOT BETWEEN 1 AND 1000
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(inventory) i WHERE i->>'classification' IS NULL OR i->>'classification' NOT IN('public','internal','confidential','restricted')
        OR i->>'kind' NOT IN('work_unit','project','client','object_record','artifact','chunk','document','source','fact','evidence_package','model_call','authority_work_unit','authority_project','authority_client','authority_object_record')
        OR(i->>'kind' NOT IN('source','authority_work_unit','authority_project','authority_client','authority_object_record') AND(i->>'sha256' IS NULL OR i->>'sha256' !~ '^[0-9a-f]{64}$')))
      OR NEW.inventory_sha256 IS DISTINCT FROM encode(sha256(convert_to(inventory::text,'UTF8')),'hex')
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(inventory) i JOIN ai.agent_runs r ON r.organization_id=NEW.organization_id AND r.id=NEW.run_id
        WHERE i->>'kind'='work_unit' AND i->>'id'=r.work_unit_id::text) THEN
      RAISE EXCEPTION 'MAIN_SNAPSHOT_INCOMPLETE' USING ERRCODE='EN119';END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['state','result_kind','result_tool_id','result_payload_hash']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','result_kind','result_tool_id','result_payload_hash']) THEN
      RAISE EXCEPTION 'MAIN_SNAPSHOT_IMMUTABLE' USING ERRCODE='42501';END IF;
    IF OLD.state='prepared' AND NEW.state='dispatched' THEN
      IF NEW.input_inventory IS DISTINCT FROM ai.current_main_input_inventory(NEW.run_id) THEN RAISE EXCEPTION 'MAIN_SNAPSHOT_CHANGED' USING ERRCODE='EN119';END IF;
    ELSIF OLD.state='dispatched' AND NEW.state='response_received' THEN
      IF current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM('model-result-v1:'||NEW.run_id::text||':'||NEW.step_id::text||':'||NEW.attempt::text) THEN
        RAISE EXCEPTION 'MAIN_SNAPSHOT_RESULT_UNBOUND' USING ERRCODE='EN119';END IF;
    ELSE RAISE EXCEPTION 'MAIN_SNAPSHOT_ALREADY_CLAIMED' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_main_input_snapshot() FROM PUBLIC;
CREATE TRIGGER main_input_snapshot_guard BEFORE INSERT OR UPDATE ON ai.main_input_snapshots FOR EACH ROW EXECUTE FUNCTION ai.guard_main_input_snapshot();
CREATE FUNCTION ai.guard_model_proposal_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;s record;
BEGIN
  IF TG_RELID<>'ai.model_proposal_inputs'::regclass OR TG_OP<>'INSERT' OR current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN RAISE EXCEPTION 'MODEL_PROPOSAL_INPUT_TARGET' USING ERRCODE='42501';END IF;
  SELECT * INTO p FROM ai.tool_proposals WHERE organization_id=NEW.organization_id AND id=NEW.proposal_id;
  SELECT * INTO s FROM ai.main_input_snapshots WHERE organization_id=NEW.organization_id AND id=NEW.snapshot_id FOR SHARE;
  IF p.id IS NULL OR s.id IS NULL OR p.run_id<>s.run_id OR p.step_id<>s.step_id OR p.run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true)
    OR s.state<>'response_received' OR s.result_kind<>'tool_call' OR s.result_tool_id<>p.tool_id OR s.result_payload_hash<>p.payload_hash
    OR NOT ai.run_input_admitted(p.run_id) OR current_setting('app.knowledge_model_protocol',true) IS DISTINCT FROM('model-result-v1:'||s.run_id::text||':'||s.step_id::text||':'||s.attempt::text)
    OR NOT EXISTS(SELECT 1 FROM ai.execution_steps e WHERE e.organization_id=s.organization_id AND e.id=s.step_id AND e.run_id=s.run_id AND e.attempt=s.attempt AND e.state='in_flight' AND e.kind='model_turn') THEN
    RAISE EXCEPTION 'MODEL_PROPOSAL_INPUT_UNBOUND' USING ERRCODE='EN119';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_model_proposal_input() FROM PUBLIC;
CREATE TRIGGER model_proposal_input_guard BEFORE INSERT ON ai.model_proposal_inputs FOR EACH ROW EXECUTE FUNCTION ai.guard_model_proposal_input();
-- Until delegated sinks have real positive disposition, metadata removal is refused, even to eraser.
CREATE TRIGGER main_input_snapshot_keep BEFORE DELETE OR TRUNCATE ON ai.main_input_snapshots FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER model_proposal_input_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.model_proposal_inputs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
