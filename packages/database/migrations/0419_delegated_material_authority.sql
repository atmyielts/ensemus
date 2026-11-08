-- Real delegated title/file sinks. Source in progress; not registered or enabled independently.
-- Requires0417 plus0416's actual pre-network/paid-result/proposal identity. Existing quarantines
-- remain closed; nullable old transform fields are not a historical repair or completeness claim.
ALTER TABLE ai.model_proposal_inputs ADD COLUMN transform_version text;
ALTER TABLE ai.model_proposal_inputs ADD COLUMN derived_body_sha256 text;
ALTER TABLE ai.model_proposal_inputs ADD CONSTRAINT model_proposal_inputs_title_transform CHECK(
  (transform_version IS NULL AND derived_body_sha256 IS NULL) OR
  (transform_version IS NOT NULL AND transform_version='work-title-v1'
    AND derived_body_sha256 IS NOT NULL AND derived_body_sha256 ~ '^[0-9a-f]{64}$'));
-- Actual fact subject identity is retained when its body is later removed. Old NULL rows cannot be
-- promoted by re-reading a current fact. Claim/package digests keep their original exact encoding.
ALTER TABLE knowledge.evidence_package_facts ADD COLUMN subject_ref text;
ALTER TABLE knowledge.evidence_package_facts ADD CONSTRAINT evidence_package_facts_subject CHECK(subject_ref IS NULL
  OR subject_ref ~ '^(client|project|membership|team|work_unit|knowledge_source):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
CREATE OR REPLACE FUNCTION knowledge.guard_evidence_package_fact() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE package_row record;fact_row record;subject_kind text;subject_id uuid;subject_class text;
BEGIN
  IF TG_RELID<>'knowledge.evidence_package_facts'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_type() NOT IN('user','delegated','agent') THEN RAISE EXCEPTION 'PACKAGE_FACT_TARGET' USING ERRCODE='42501';END IF;
  SELECT * INTO package_row FROM knowledge.evidence_packages WHERE organization_id=NEW.organization_id AND id=NEW.package_id;
  IF NEW.subject_ref IS NULL OR NEW.subject_ref !~ '^(client|project|membership|team|work_unit|knowledge_source):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'PACKAGE_FACT_INPUT_STALE' USING ERRCODE='EN119';END IF;
  subject_kind:=split_part(NEW.subject_ref,':',1);subject_id:=split_part(NEW.subject_ref,':',2)::uuid;
  IF subject_kind='knowledge_source' THEN
    SELECT source.classification INTO subject_class FROM knowledge.sources source WHERE source.organization_id=NEW.organization_id
      AND source.id=subject_id AND source.state='active' AND source.id IN(SELECT knowledge.readable_source_ids(app.current_membership_id())) FOR SHARE NOWAIT;
  ELSIF subject_kind IN('work_unit','project','client') THEN
    IF NOT knowledge.lock_structured_record(subject_kind,subject_id) OR NOT knowledge.structured_record_readable(subject_kind,subject_id,app.current_membership_id()) THEN
      RAISE EXCEPTION 'PACKAGE_FACT_INPUT_STALE' USING ERRCODE='EN119';END IF;
    subject_class:=knowledge.structured_record_class(subject_kind,subject_id);
  ELSE subject_class:='internal';END IF;
  -- Source locks precede the fact lock in the actual compiler publisher. No old subject guess is
  -- substituted here: a new receipt must carry the subject that was actually read in memory.
  SELECT id,subject_ref,classification,trust_state INTO fact_row FROM knowledge.facts WHERE organization_id=NEW.organization_id AND id=NEW.fact_id FOR SHARE NOWAIT;
  IF package_row.id IS NULL OR fact_row.id IS NULL OR NEW.subject_ref IS NULL OR NEW.subject_ref IS DISTINCT FROM fact_row.subject_ref
    OR package_row.viewer_membership_id IS DISTINCT FROM app.current_membership_id() OR NOT(NEW.fact_id=ANY(package_row.verified_fact_ids))
    OR fact_row.trust_state<>'verified' OR subject_class IS NULL
    OR knowledge.class_rank(NEW.classification)<greatest(knowledge.class_rank(fact_row.classification),knowledge.class_rank(subject_class))
    OR NOT EXISTS(SELECT 1 FROM knowledge.fact_evidence evidence WHERE evidence.organization_id=NEW.organization_id AND evidence.fact_id=NEW.fact_id)
    OR EXISTS(SELECT 1 FROM knowledge.fact_evidence evidence WHERE evidence.organization_id=NEW.organization_id AND evidence.fact_id=NEW.fact_id AND NOT EXISTS(
      SELECT 1 FROM knowledge.evidence_items item WHERE item.organization_id=evidence.organization_id AND item.package_id=NEW.package_id
        AND item.chunk_id=evidence.chunk_id AND item.source_id=evidence.source_id AND item.content_sha256=evidence.content_sha256)) THEN
    RAISE EXCEPTION 'PACKAGE_FACT_INPUT_STALE' USING ERRCODE='EN119';END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TABLE ai.delegated_input_receipts (
  organization_id uuid NOT NULL,child_run_id uuid NOT NULL,parent_run_id uuid NOT NULL,parent_receipt_run_id uuid,child_work_unit_id uuid NOT NULL,
  proposal_id uuid NOT NULL,snapshot_id uuid NOT NULL,original_step_id uuid NOT NULL,original_attempt integer NOT NULL,
  tool_step_number integer NOT NULL,request_sha256 text NOT NULL,proposal_payload_sha256 text NOT NULL,
  birth_content_sha256 text NOT NULL,input_inventory jsonb NOT NULL,inventory_sha256 text NOT NULL,
  classification text NOT NULL,born_at timestamptz NOT NULL DEFAULT now(),redacted_at timestamptz,
  redacted_version bigint,disposition_sha256 text,
  CONSTRAINT delegated_input_receipts_pk PRIMARY KEY(organization_id,child_run_id),
  CONSTRAINT delegated_input_receipts_proposal_key UNIQUE(organization_id,proposal_id),
  CONSTRAINT delegated_input_receipts_work_key UNIQUE(organization_id,child_work_unit_id),
  CONSTRAINT delegated_input_receipts_child_fk FOREIGN KEY(organization_id,child_run_id) REFERENCES ai.agent_runs(organization_id,id),
  CONSTRAINT delegated_input_receipts_parent_fk FOREIGN KEY(organization_id,parent_run_id) REFERENCES ai.agent_runs(organization_id,id),
  CONSTRAINT delegated_input_receipts_parent_receipt_fk FOREIGN KEY(organization_id,parent_receipt_run_id) REFERENCES ai.delegated_input_receipts(organization_id,child_run_id),
  CONSTRAINT delegated_input_receipts_work_fk FOREIGN KEY(organization_id,child_work_unit_id) REFERENCES work.work_units(organization_id,id),
  CONSTRAINT delegated_input_receipts_proposal_fk FOREIGN KEY(organization_id,proposal_id) REFERENCES ai.tool_proposals(organization_id,id),
  CONSTRAINT delegated_input_receipts_snapshot_fk FOREIGN KEY(organization_id,snapshot_id) REFERENCES ai.main_input_snapshots(organization_id,id),
  CONSTRAINT delegated_input_receipts_step_fk FOREIGN KEY(organization_id,original_step_id) REFERENCES ai.execution_steps(organization_id,id),
  CONSTRAINT delegated_input_receipts_identity CHECK(child_run_id<>parent_run_id AND original_attempt>0 AND tool_step_number>0),
  CONSTRAINT delegated_input_receipts_parent_proof CHECK(parent_receipt_run_id IS NULL OR parent_receipt_run_id=parent_run_id),
  CONSTRAINT delegated_input_receipts_hashes CHECK(request_sha256 ~ '^[0-9a-f]{64}$' AND proposal_payload_sha256 ~ '^[0-9a-f]{64}$' AND birth_content_sha256 ~ '^[0-9a-f]{64}$' AND inventory_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT delegated_input_receipts_inventory CHECK(jsonb_typeof(input_inventory)='array' AND jsonb_array_length(input_inventory) BETWEEN 1 AND 1000 AND octet_length(input_inventory::text)<=1048576),
  CONSTRAINT delegated_input_receipts_class CHECK(classification IN('public','internal','confidential','restricted')),
  CONSTRAINT delegated_input_receipts_disposition CHECK((redacted_at IS NULL AND redacted_version IS NULL AND disposition_sha256 IS NULL)
    OR(redacted_at IS NOT NULL AND redacted_version IS NOT NULL AND redacted_version>0 AND disposition_sha256 IS NOT NULL AND disposition_sha256 ~ '^[0-9a-f]{64}$'))
);
CREATE INDEX delegated_input_receipts_parent_idx ON ai.delegated_input_receipts(organization_id,parent_run_id,child_run_id);
CREATE TABLE ai.delegated_input_refs (
  organization_id uuid NOT NULL,child_run_id uuid NOT NULL,proof_key_sha256 text NOT NULL,ref_kind text NOT NULL,
  ref_id uuid NOT NULL,content_sha256 text,classification text NOT NULL,source_id uuid,document_id uuid,proof_kind text NOT NULL,fact_package_id uuid,
  CONSTRAINT delegated_input_refs_pk PRIMARY KEY(organization_id,child_run_id,proof_key_sha256),
  CONSTRAINT delegated_input_refs_receipt_fk FOREIGN KEY(organization_id,child_run_id) REFERENCES ai.delegated_input_receipts(organization_id,child_run_id),
  CONSTRAINT delegated_input_refs_fact_receipt_fk FOREIGN KEY(organization_id,fact_package_id,ref_id) REFERENCES knowledge.evidence_package_facts(organization_id,package_id,fact_id),
  CONSTRAINT delegated_input_refs_fact_origin CHECK((ref_kind='fact')=(fact_package_id IS NOT NULL)),
  CONSTRAINT delegated_input_refs_shape CHECK(proof_key_sha256 ~ '^[0-9a-f]{64}$' AND(content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$')
    AND ref_kind IN('work_unit','project','client','object_record','artifact','chunk','document','source','fact','evidence_package','model_call')
    AND classification IN('public','internal','confidential','restricted') AND proof_kind IN('actual_content','read_authority','current_authority','model_metadata'))
);
CREATE INDEX delegated_input_refs_target_idx ON ai.delegated_input_refs(organization_id,ref_kind,ref_id,child_run_id);
CREATE INDEX delegated_input_refs_source_idx ON ai.delegated_input_refs(organization_id,source_id,child_run_id);
ALTER TABLE ai.delegated_input_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.delegated_input_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE ai.delegated_input_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.delegated_input_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY delegated_receipt_metadata ON ai.delegated_input_receipts FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY delegated_ref_metadata ON ai.delegated_input_refs FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
GRANT SELECT ON ai.delegated_input_receipts,ai.delegated_input_refs TO ensemus_app;
-- No append/redaction/eraser capability exists until the actual birth and positive disposition
-- guards below are complete. In particular, these rows cannot be imported or deleted to get zero.
CREATE TRIGGER delegated_input_receipt_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.delegated_input_receipts FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER delegated_input_refs_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.delegated_input_refs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
-- An actual INSERT witness, not a mutable preparation token or xmin-based inference. The deferred
-- reciprocal FK means the copied Work/witness cannot commit without its genuine child receipt.
CREATE TABLE ai.delegated_work_births (
  organization_id uuid NOT NULL,work_unit_id uuid NOT NULL,child_run_id uuid NOT NULL,parent_run_id uuid NOT NULL,
  parent_work_unit_id uuid NOT NULL,proposal_id uuid NOT NULL,snapshot_id uuid NOT NULL,birth_content_sha256 text NOT NULL,
  classification text NOT NULL,inserted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delegated_work_births_pk PRIMARY KEY(organization_id,work_unit_id),
  CONSTRAINT delegated_work_births_identity_key UNIQUE(organization_id,work_unit_id,child_run_id,proposal_id,snapshot_id,birth_content_sha256),
  CONSTRAINT delegated_work_births_work_fk FOREIGN KEY(organization_id,work_unit_id) REFERENCES work.work_units(organization_id,id),
  CONSTRAINT delegated_work_births_parent_fk FOREIGN KEY(organization_id,parent_run_id) REFERENCES ai.agent_runs(organization_id,id),
  CONSTRAINT delegated_work_births_receipt_fk FOREIGN KEY(organization_id,child_run_id) REFERENCES ai.delegated_input_receipts(organization_id,child_run_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT delegated_work_births_hash CHECK(birth_content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT delegated_work_births_class CHECK(classification IN('public','internal','confidential','restricted'))
);
ALTER TABLE ai.delegated_input_receipts ADD CONSTRAINT delegated_input_receipts_insert_witness_fk
  FOREIGN KEY(organization_id,child_work_unit_id,child_run_id,proposal_id,snapshot_id,birth_content_sha256)
  REFERENCES ai.delegated_work_births(organization_id,work_unit_id,child_run_id,proposal_id,snapshot_id,birth_content_sha256);
ALTER TABLE ai.delegated_work_births ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.delegated_work_births FORCE ROW LEVEL SECURITY;
CREATE POLICY delegated_work_birth_metadata ON ai.delegated_work_births FOR SELECT TO ensemus_app
  USING(organization_id=app.current_organization_id());
CREATE POLICY delegated_work_birth_trigger ON ai.delegated_work_births FOR INSERT TO ensemus_agent
  WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()=1 AND app.current_actor_type()='agent'
    AND parent_run_id::text=current_setting('app.agent_run_id',true));
GRANT SELECT ON ai.delegated_work_births TO ensemus_app;
GRANT INSERT ON ai.delegated_work_births TO ensemus_agent;
CREATE TRIGGER delegated_work_birth_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON ai.delegated_work_births FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- This normalizes only the supplied ACTUAL frozen server inventory; it grants no body/read/birth
-- capability. Authority-only entries retain NULL content hashes. Metadata identities are separate.
CREATE FUNCTION ai.delegated_frozen_refs(p_inventory jsonb)
RETURNS TABLE(proof_key_sha256 text,ref_kind text,ref_id uuid,content_sha256 text,classification text,source_id uuid,document_id uuid,proof_kind text,fact_package_id uuid)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE flat jsonb;r jsonb;
BEGIN
  IF jsonb_typeof(p_inventory) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'DELEGATION_FROZEN_INPUT_INVALID' USING ERRCODE='EN119';END IF;
  IF jsonb_array_length(p_inventory) NOT BETWEEN 1 AND 1000
    OR octet_length(p_inventory::text)>1048576 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_inventory) e
      WHERE e->>'kind' IS NULL OR e->>'kind' NOT IN('work_unit','project','client','object_record','artifact','chunk','document','source','fact','evidence_package','model_call','authority_work_unit','authority_project','authority_client','authority_object_record','read_authority','inherited_influence')
        OR(e->>'kind'='read_authority' AND(CASE WHEN jsonb_typeof(e->'authorityInventory')='array'
          THEN jsonb_array_length(e->'authorityInventory') NOT BETWEEN 1 AND 1000 ELSE true END))
        OR(e->>'kind'='inherited_influence' AND(CASE WHEN jsonb_typeof(e->'influenceRefs')='array'
          THEN jsonb_array_length(e->'influenceRefs') NOT BETWEEN 1 AND 1000 ELSE true END))) THEN
    RAISE EXCEPTION 'DELEGATION_FROZEN_INPUT_INVALID' USING ERRCODE='EN119';END IF;
  WITH entries AS(
    SELECT jsonb_build_object('kind',CASE WHEN e->>'kind' LIKE 'authority_%' THEN substr(e->>'kind',11) ELSE e->>'kind' END,
      'id',e->>'id','sha256',e->>'sha256','classification',e->>'classification','sourceId',e->>'sourceId','documentId',e->>'documentId',
      'factPackageId',CASE WHEN e->>'kind'='fact' THEN e->>'packageId' END,
      'proofKind',CASE WHEN e->>'kind'='model_call' THEN 'model_metadata' WHEN e->>'kind'='source' OR e->>'kind' LIKE 'authority_%' THEN 'current_authority' ELSE 'actual_content' END) entry
      FROM jsonb_array_elements(p_inventory) e WHERE e->>'kind' NOT IN('read_authority','inherited_influence')
    UNION SELECT jsonb_build_object('kind',a->>'kind','id',a->>'id','sha256',NULL,'classification',a->>'classification',
      'sourceId',CASE WHEN a->>'kind'='source' THEN a->>'id' ELSE NULL END,
      'documentId',CASE WHEN a->>'kind'='document' THEN a->>'id' ELSE NULL END,'proofKind','read_authority','factPackageId',NULL)
      FROM jsonb_array_elements(p_inventory) e CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN e->>'kind'='read_authority' AND jsonb_typeof(e->'authorityInventory')='array' THEN e->'authorityInventory' ELSE '[]'::jsonb END) a
    UNION SELECT inherited FROM jsonb_array_elements(p_inventory) e CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN e->>'kind'='inherited_influence' AND jsonb_typeof(e->'influenceRefs')='array' THEN e->'influenceRefs' ELSE '[]'::jsonb END) inherited
  ),bounded AS(SELECT entry FROM entries ORDER BY entry::text COLLATE "C" LIMIT 1001)
  SELECT coalesce(jsonb_agg(entry ORDER BY entry::text COLLATE "C"),'[]'::jsonb) INTO flat FROM bounded;
  IF jsonb_array_length(flat) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'DELEGATION_FROZEN_INPUT_LIMIT' USING ERRCODE='EN119';END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(flat) LOOP
    IF r->>'kind' IS NULL OR r->>'kind' NOT IN('work_unit','project','client','object_record','artifact','chunk','document','source','fact','evidence_package','model_call')
      OR r->>'id' IS NULL OR r->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR r->>'classification' IS NULL OR r->>'classification' NOT IN('public','internal','confidential','restricted')
      OR(r->>'sha256' IS NOT NULL AND r->>'sha256' !~ '^[0-9a-f]{64}$')
      OR(r->>'proofKind' IN('actual_content','model_metadata') AND r->>'sha256' IS NULL)
      OR r->>'proofKind' IS NULL OR r->>'proofKind' NOT IN('actual_content','read_authority','current_authority','model_metadata')
      OR(r->>'proofKind'='read_authority' AND r->>'sha256' IS NOT NULL)
      OR((r->>'kind'='fact') IS DISTINCT FROM(r->>'factPackageId' IS NOT NULL))
      OR(r->>'factPackageId' IS NOT NULL AND r->>'factPackageId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR(r->>'sourceId' IS NOT NULL AND r->>'sourceId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR(r->>'documentId' IS NOT NULL AND r->>'documentId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'DELEGATION_FROZEN_INPUT_INVALID' USING ERRCODE='EN119';END IF;
    proof_key_sha256:=encode(sha256(convert_to(r::text,'UTF8')),'hex');
    ref_kind:=r->>'kind';ref_id:=(r->>'id')::uuid;content_sha256:=r->>'sha256';classification:=r->>'classification';
    source_id:=(r->>'sourceId')::uuid;document_id:=(r->>'documentId')::uuid;proof_kind:=r->>'proofKind';
    fact_package_id:=(r->>'factPackageId')::uuid;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION ai.delegated_frozen_refs(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.delegated_frozen_refs(jsonb) TO ensemus_agent;
--> statement-breakpoint
-- Exact native request IDs: identical bytes to idFromRequest(kind,initiator,parent,toolStep),
-- including its fixed version/variant substitutions. No model-selected UUID is birth authority.
CREATE FUNCTION ai.delegated_child_request_id(p_work boolean,p_initiator uuid,p_parent uuid,p_tool_step integer)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  WITH hashed AS(SELECT encode(sha256(convert_to('["'||(CASE WHEN p_work THEN 'agent_child_work' ELSE 'agent_child_run' END)
    ||'","'||p_initiator::text||'","'||p_parent::text||'",'||p_tool_step::text||']','UTF8')),'hex') h)
  SELECT(substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
  FROM hashed WHERE p_work IS NOT NULL AND p_initiator IS NOT NULL AND p_parent IS NOT NULL AND p_tool_step>=0
$$;
REVOKE ALL ON FUNCTION ai.delegated_child_request_id(boolean,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.delegated_child_request_id(boolean,uuid,uuid,integer) TO ensemus_agent;

-- Metadata only. This does not enable child birth: the actual closure locks/Work hash/INSERT receipt
-- and lifecycle/serving guards must be composed before replacing0414's false readiness function.
CREATE FUNCTION ai.delegation_birth_candidate(p_parent uuid,p_child uuid)
RETURNS TABLE(child_work_unit_id uuid,proposal_id uuid,snapshot_id uuid,original_step_id uuid,original_attempt integer,
  tool_step_number integer,request_sha256 text,proposal_payload_sha256 text,birth_content_sha256 text,
  input_inventory jsonb,inventory_sha256 text,classification text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT ai.delegated_child_request_id(true,r.initiator_membership_id,r.id,t.step_number),p.id,s.id,m.id,s.attempt,
    t.step_number,s.request_hash,p.payload_hash,b.derived_body_sha256,s.input_inventory,s.inventory_sha256,
    CASE greatest(1,knowledge.class_rank(r.effective_classification),
      (SELECT max(knowledge.class_rank(i->>'classification')) FROM jsonb_array_elements(s.input_inventory) i))
      WHEN 3 THEN 'restricted' WHEN 2 THEN 'confidential' ELSE 'internal' END
  FROM ai.agent_runs r
    JOIN org.memberships viewer ON viewer.organization_id=r.organization_id AND viewer.id=r.initiator_membership_id AND viewer.status='active'
    JOIN ai.tool_proposals p ON p.organization_id=r.organization_id AND p.run_id=r.id AND p.tool_id='agent.delegate' AND p.status='done'
    JOIN ai.model_proposal_inputs b ON b.organization_id=p.organization_id AND b.proposal_id=p.id AND b.transform_version='work-title-v1' AND b.derived_body_sha256 IS NOT NULL
    JOIN ai.main_input_snapshots s ON s.organization_id=b.organization_id AND s.id=b.snapshot_id AND s.run_id=r.id AND s.step_id=p.step_id
      AND s.state='response_received' AND s.result_kind='tool_call' AND s.result_tool_id=p.tool_id AND s.result_payload_hash=p.payload_hash
      AND s.viewer_membership_id=r.initiator_membership_id AND s.profile_id=r.bound_profile_id AND s.profile_version=r.bound_profile_version
    JOIN ai.execution_steps m ON m.organization_id=s.organization_id AND m.run_id=s.run_id AND m.id=s.step_id AND m.kind='model_turn'
      AND m.state='completed' AND m.outcome='tool_proposed' AND m.attempt=s.attempt
    JOIN ai.execution_steps t ON t.organization_id=m.organization_id AND t.run_id=m.run_id AND t.step_number=m.step_number+1
      AND t.kind='tool_call' AND t.state='completed' AND t.outcome='done'
  WHERE current_user='ensemus_agent' AND app.current_actor_type()='agent' AND r.organization_id=app.current_organization_id()
    AND r.id=p_parent AND r.id::text=current_setting('app.agent_run_id',true) AND r.initiator_membership_id=app.current_membership_id()
    AND r.status IN('running','waiting_for_child') AND ai.run_authority_protocol_version(r.id)='authority-v1'
    AND ai.run_authority_read_admitted(r.id) AND ai.run_authority_ready(r.id,r.initiator_membership_id)
    AND ai.delegated_child_request_id(false,r.initiator_membership_id,r.id,t.step_number)=p_child
    AND NOT EXISTS(SELECT 1 FROM ai.execution_steps later WHERE later.organization_id=r.organization_id AND later.run_id=r.id AND later.step_number>t.step_number)
    AND NOT EXISTS(SELECT 1 FROM ai.run_controls control WHERE control.organization_id=r.organization_id AND control.run_id=r.id AND control.kind='stop')
    AND(r.parent_run_id IS NULL OR EXISTS(SELECT 1 FROM ai.delegated_input_receipts parent_receipt
      WHERE parent_receipt.organization_id=r.organization_id AND parent_receipt.child_run_id=r.id AND parent_receipt.child_work_unit_id=r.work_unit_id AND parent_receipt.redacted_at IS NULL))
    AND NOT EXISTS(SELECT 1 FROM ai.delegated_input_receipts used WHERE used.organization_id=r.organization_id AND used.proposal_id=p.id)
    AND EXISTS(SELECT 1 FROM platform.usage_ledger u JOIN platform.budget_reservations h
      ON h.organization_id=u.organization_id AND h.id=u.reservation_id AND h.run_id=u.run_id AND h.step_id=u.step_id
      WHERE u.organization_id=r.organization_id AND u.run_id=r.id AND u.work_unit_id=r.work_unit_id AND u.step_id=m.id
        AND u.idempotency_key='model:'||r.id::text||':'||m.step_number::text||':'||s.reservation_attempt::text
        AND u.meter='model_input_tokens' AND u.unit='token' AND u.status IN('final','estimated') AND u.corrects_id IS NULL
        AND u.model_call_id IS NULL AND u.model_job_id IS NULL AND u.profile_id=s.profile_id AND u.profile_version=s.profile_version
        AND u.rate_card_id IS NOT NULL AND u.rate_card_version IS NOT NULL AND h.status='settled'
        AND h.model_call_id IS NULL AND h.model_job_id IS NULL AND h.attempt=s.reservation_attempt)
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.input_inventory) i WHERE i->>'kind'='read_authority'
      AND i->>'inputKind'='work_unit' AND i->>'id'=r.work_unit_id::text)
$$;
REVOKE ALL ON FUNCTION ai.delegation_birth_candidate(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.delegation_birth_candidate(uuid,uuid) TO ensemus_agent;
--> statement-breakpoint
-- Fresh named-viewer metadata only. Mutable structured/fact hashes stay historical; immutable
-- artifact/chunk/document/package/call identities retain their actual byte/request integrity.
CREATE FUNCTION ai.frozen_ref_current_class(p_kind text,p_id uuid,p_hash text,p_source uuid,p_document uuid,p_viewer uuid)
RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE current_class text;subject_reference text;subject_kind text;subject_id uuid;
BEGIN
  IF p_viewer IS NULL OR NOT EXISTS(SELECT 1 FROM org.memberships viewer WHERE viewer.organization_id=app.current_organization_id()
    AND viewer.id=p_viewer AND viewer.status='active') THEN RETURN NULL;END IF;
  IF p_kind IN('work_unit','project','client','object_record') THEN
    IF p_kind='work_unit' THEN
      IF NOT knowledge.work_own_scope_readable_0419(p_id,p_viewer) THEN RETURN NULL;END IF;
    ELSIF NOT knowledge.structured_record_readable(p_kind,p_id,p_viewer) THEN RETURN NULL;END IF;
    current_class:=knowledge.structured_record_class(p_kind,p_id);
  ELSIF p_kind='artifact' THEN
    SELECT catalog.classification INTO current_class FROM knowledge.artifact_acl_catalog catalog
      WHERE catalog.organization_id=app.current_organization_id() AND catalog.artifact_id=p_id AND catalog.alive
        AND(p_hash IS NULL OR catalog.sha256=p_hash) AND knowledge.artifact_readable(catalog.artifact_id,p_viewer);
  ELSIF p_kind IN('source','document','chunk') THEN
    IF p_kind='source' THEN
      SELECT source_row.classification INTO current_class FROM knowledge.sources source_row
        WHERE source_row.organization_id=app.current_organization_id() AND source_row.id=p_id AND source_row.state='active'
          AND source_row.id IN(SELECT knowledge.readable_source_ids(p_viewer))
          AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=source_row.organization_id AND tomb.target_type='knowledge_source' AND tomb.target_id=source_row.id);
    ELSIF p_kind='document' THEN
      SELECT document_row.classification INTO current_class FROM knowledge.documents document_row
        JOIN knowledge.sources source_row ON source_row.organization_id=document_row.organization_id AND source_row.id=document_row.source_id
        WHERE document_row.organization_id=app.current_organization_id() AND document_row.id=p_id AND document_row.state='searchable' AND document_row.superseded_at IS NULL
          AND(p_source IS NULL OR document_row.source_id=p_source) AND(p_hash IS NULL OR document_row.content_sha256=p_hash)
          AND source_row.state='active' AND source_row.id IN(SELECT knowledge.readable_source_ids(p_viewer))
          AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=source_row.organization_id AND tomb.target_type='knowledge_source' AND tomb.target_id=source_row.id);
    ELSE
      SELECT document_row.classification INTO current_class FROM knowledge.chunks chunk_row
        JOIN knowledge.documents document_row ON document_row.organization_id=chunk_row.organization_id AND document_row.id=chunk_row.document_id
        JOIN knowledge.sources source_row ON source_row.organization_id=chunk_row.organization_id AND source_row.id=chunk_row.source_id
        WHERE chunk_row.organization_id=app.current_organization_id() AND chunk_row.id=p_id AND p_hash IS NOT NULL AND chunk_row.content_sha256=p_hash
          AND chunk_row.source_id=p_source AND(p_document IS NULL OR chunk_row.document_id=p_document)
          AND document_row.state='searchable' AND document_row.superseded_at IS NULL AND source_row.state='active'
          AND source_row.id IN(SELECT knowledge.readable_source_ids(p_viewer))
          AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=source_row.organization_id AND tomb.target_type='knowledge_source' AND tomb.target_id=source_row.id);
    END IF;
  ELSIF p_kind='fact' THEN
    SELECT fact_row.classification,fact_row.subject_ref INTO current_class,subject_reference FROM knowledge.facts fact_row
      WHERE fact_row.organization_id=app.current_organization_id() AND fact_row.id=p_id;
    -- Fact SELECT has an existing service inspection exception. It cannot replace the actual
    -- named viewer for derived serving; inspect only the typed subject metadata independently.
    IF subject_reference IS NULL OR split_part(subject_reference,':',2) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL;END IF;
    subject_kind:=split_part(subject_reference,':',1);subject_id:=split_part(subject_reference,':',2)::uuid;
    IF subject_kind IN('work_unit','project','client') THEN
      IF NOT knowledge.structured_record_readable(subject_kind,subject_id,p_viewer) THEN RETURN NULL;END IF;
    ELSIF subject_kind='knowledge_source' THEN
      IF NOT EXISTS(SELECT 1 FROM knowledge.sources source_row WHERE source_row.organization_id=app.current_organization_id()
        AND source_row.id=subject_id AND source_row.state='active' AND source_row.id IN(SELECT knowledge.readable_source_ids(p_viewer))
        AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=source_row.organization_id
          AND tomb.target_type='knowledge_source' AND tomb.target_id=source_row.id)) THEN RETURN NULL;END IF;
    ELSIF subject_kind='membership' THEN
      IF NOT EXISTS(SELECT 1 FROM org.memberships subject_member WHERE subject_member.organization_id=app.current_organization_id() AND subject_member.id=subject_id) THEN RETURN NULL;END IF;
    ELSIF subject_kind='team' THEN
      IF NOT EXISTS(SELECT 1 FROM org.teams subject_team WHERE subject_team.organization_id=app.current_organization_id() AND subject_team.id=subject_id) THEN RETURN NULL;END IF;
    ELSE RETURN NULL;END IF;
  ELSIF p_kind='evidence_package' THEN
    SELECT package_row.strongest_classification INTO current_class FROM knowledge.evidence_packages package_row
      WHERE package_row.organization_id=app.current_organization_id() AND package_row.id=p_id AND p_hash IS NOT NULL AND package_row.package_sha256=p_hash;
  ELSIF p_kind='model_call' THEN
    SELECT call_row.classification INTO current_class FROM ai.model_call_attempts call_row
      WHERE call_row.organization_id=app.current_organization_id() AND call_row.id=p_id AND p_hash IS NOT NULL AND call_row.request_hash=p_hash;
  ELSE RETURN NULL;END IF;
  IF current_class IS NULL OR current_class NOT IN('public','internal','confidential','restricted') THEN RETURN NULL;END IF;
  RETURN current_class;
END $$;
REVOKE ALL ON FUNCTION ai.frozen_ref_current_class(text,uuid,text,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.frozen_ref_current_class(text,uuid,text,uuid,uuid,uuid) TO ensemus_app;
--> statement-breakpoint
-- Before the copied Work INSERT. All original sources precede document/catalog/record locks;
-- control/checkpoint/run locks stay with the existing body->run kernel and its final birth guard.
CREATE FUNCTION ai.lock_frozen_input_refs(p_inventory jsonb,p_viewer uuid) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE frozen record;observed text;floor_rank integer:=0;result_class text;
BEGIN
  FOR frozen IN SELECT source_row.id FROM knowledge.sources source_row WHERE source_row.organization_id=app.current_organization_id()
    AND source_row.id IN(SELECT input.ref_id FROM ai.delegated_frozen_refs(p_inventory) input WHERE input.ref_kind='source'
      UNION SELECT input.source_id FROM ai.delegated_frozen_refs(p_inventory) input WHERE input.source_id IS NOT NULL)
    ORDER BY source_row.id FOR SHARE NOWAIT LOOP NULL;END LOOP;
  FOR frozen IN SELECT document_row.id FROM knowledge.documents document_row WHERE document_row.organization_id=app.current_organization_id()
    AND document_row.id IN(SELECT input.ref_id FROM ai.delegated_frozen_refs(p_inventory) input WHERE input.ref_kind='document'
      UNION SELECT input.document_id FROM ai.delegated_frozen_refs(p_inventory) input WHERE input.document_id IS NOT NULL)
    ORDER BY document_row.id FOR SHARE NOWAIT LOOP NULL;END LOOP;
  FOR frozen IN SELECT DISTINCT input.ref_id FROM ai.delegated_frozen_refs(p_inventory) input WHERE input.ref_kind='artifact' ORDER BY input.ref_id LOOP
    PERFORM knowledge.lock_artifact_catalog(frozen.ref_id);
  END LOOP;
  FOR frozen IN SELECT ordered.ref_kind,ordered.ref_id FROM(SELECT DISTINCT input.ref_kind,input.ref_id
    FROM ai.delegated_frozen_refs(p_inventory) input WHERE input.ref_kind IN('work_unit','project','client','object_record')) ordered
    ORDER BY ordered.ref_kind COLLATE "C",ordered.ref_id LOOP
    IF NOT knowledge.lock_structured_record(frozen.ref_kind,frozen.ref_id) THEN RETURN NULL;END IF;
  END LOOP;
  FOR frozen IN SELECT input.* FROM ai.delegated_frozen_refs(p_inventory) input LOOP
    IF frozen.ref_kind='fact' THEN
      IF NOT knowledge.fact_authority_receipt_live(frozen.fact_package_id,frozen.ref_id,frozen.content_sha256,'restricted') THEN RETURN NULL;END IF;
      SELECT original.classification INTO observed FROM knowledge.evidence_package_facts original
        WHERE original.organization_id=app.current_organization_id() AND original.package_id=frozen.fact_package_id
          AND original.fact_id=frozen.ref_id AND original.content_sha256=frozen.content_sha256;
    ELSE observed:=ai.frozen_ref_current_class(frozen.ref_kind,frozen.ref_id,frozen.content_sha256,frozen.source_id,frozen.document_id,p_viewer);END IF;
    IF observed IS NULL THEN RETURN NULL;END IF;
    floor_rank:=greatest(floor_rank,knowledge.class_rank(observed),knowledge.class_rank(frozen.classification));
  END LOOP;
  result_class:=CASE floor_rank WHEN 3 THEN 'restricted' WHEN 2 THEN 'confidential' WHEN 1 THEN 'internal' ELSE 'public' END;
  IF NOT knowledge.retained_input_scope_readable(p_inventory,p_viewer,result_class) THEN RETURN NULL;END IF;
  RETURN result_class;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'DELEGATION_INPUT_BUSY' USING ERRCODE='55P03';
END $$;
REVOKE ALL ON FUNCTION ai.lock_frozen_input_refs(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.lock_frozen_input_refs(jsonb,uuid) TO ensemus_agent;
CREATE FUNCTION ai.lock_delegation_birth(p_parent uuid,p_child uuid) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE birth record;fresh_birth record;current_class text;floor_rank integer;candidate_count integer:=0;
BEGIN
  FOR birth IN SELECT candidate.* FROM ai.delegation_birth_candidate(p_parent,p_child) candidate LOOP
    candidate_count:=candidate_count+1;
    IF candidate_count>1 THEN RAISE EXCEPTION 'DELEGATION_BIRTH_AMBIGUOUS' USING ERRCODE='EN119';END IF;
  END LOOP;
  IF candidate_count<>1 THEN RETURN NULL;END IF;
  current_class:=ai.lock_frozen_input_refs(birth.input_inventory,app.current_membership_id());
  IF current_class IS NULL THEN RETURN NULL;END IF;
  floor_rank:=greatest(1,knowledge.class_rank(birth.classification),knowledge.class_rank(current_class));
  SELECT candidate.* INTO fresh_birth FROM ai.delegation_birth_candidate(p_parent,p_child) candidate;
  IF NOT FOUND OR ROW(fresh_birth.proposal_id,fresh_birth.snapshot_id,fresh_birth.original_step_id,fresh_birth.original_attempt,
    fresh_birth.tool_step_number,fresh_birth.request_sha256,fresh_birth.proposal_payload_sha256,fresh_birth.birth_content_sha256,fresh_birth.inventory_sha256)
    IS DISTINCT FROM ROW(birth.proposal_id,birth.snapshot_id,birth.original_step_id,birth.original_attempt,birth.tool_step_number,
      birth.request_sha256,birth.proposal_payload_sha256,birth.birth_content_sha256,birth.inventory_sha256) THEN RETURN NULL;END IF;
  floor_rank:=greatest(floor_rank,knowledge.class_rank(fresh_birth.classification));
  RETURN CASE floor_rank WHEN 3 THEN 'restricted' WHEN 2 THEN 'confidential' ELSE 'internal' END;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'DELEGATION_INPUT_BUSY' USING ERRCODE='55P03';
END $$;
REVOKE ALL ON FUNCTION ai.lock_delegation_birth(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.lock_delegation_birth(uuid,uuid) TO ensemus_agent;
--> statement-breakpoint
-- Actual new-child INSERT proof. 0414's public readiness remains false until the serving and
-- positive-disposition guards at the end of this migration are complete. No historical promotion.
CREATE FUNCTION ai.validate_delegation_birth(p_child ai.agent_runs) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE birth record;parent_row record;witness ai.delegated_work_births;floor_class text;
BEGIN
  IF current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent'
    OR p_child.organization_id IS DISTINCT FROM app.current_organization_id() OR p_child.parent_run_id IS NULL
    OR p_child.parent_run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) THEN RETURN false;END IF;
  floor_class:=ai.lock_delegation_birth(p_child.parent_run_id,p_child.id);
  IF floor_class IS NULL THEN RETURN false;END IF;
  -- The sources/catalog closures precede this kernel's Work -> run order. Every inverse lock is
  -- NOWAIT; never sleep or retry while retaining a copied-body/control lock.
  PERFORM 1 FROM ai.run_input_checkpoints checkpoint WHERE checkpoint.organization_id=p_child.organization_id
    AND checkpoint.run_id=p_child.parent_run_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT parent.id,parent.work_unit_id,parent.initiator_membership_id INTO parent_row FROM ai.agent_runs parent
    WHERE parent.organization_id=p_child.organization_id AND parent.id=p_child.parent_run_id FOR SHARE NOWAIT;
  IF NOT FOUND OR parent_row.initiator_membership_id IS DISTINCT FROM p_child.initiator_membership_id THEN RETURN false;END IF;
  SELECT candidate.* INTO birth FROM ai.delegation_birth_candidate(p_child.parent_run_id,p_child.id) candidate;
  IF NOT FOUND OR p_child.work_unit_id IS DISTINCT FROM birth.child_work_unit_id
    OR knowledge.class_rank(p_child.effective_classification)<knowledge.class_rank(floor_class) THEN RETURN false;END IF;
  PERFORM 1 FROM ai.execution_steps step WHERE step.organization_id=p_child.organization_id AND step.run_id=p_child.parent_run_id
    AND(step.id=birth.original_step_id OR step.step_number=birth.tool_step_number) ORDER BY step.step_number FOR SHARE NOWAIT;
  PERFORM 1 FROM ai.tool_proposals proposal WHERE proposal.organization_id=p_child.organization_id AND proposal.id=birth.proposal_id FOR SHARE NOWAIT;
  SELECT * INTO witness FROM ai.delegated_work_births actual WHERE actual.organization_id=p_child.organization_id AND actual.work_unit_id=p_child.work_unit_id;
  IF NOT FOUND OR ROW(witness.child_run_id,witness.parent_run_id,witness.parent_work_unit_id,witness.proposal_id,witness.snapshot_id,witness.birth_content_sha256)
    IS DISTINCT FROM ROW(p_child.id,p_child.parent_run_id,parent_row.work_unit_id,birth.proposal_id,birth.snapshot_id,birth.birth_content_sha256)
    OR knowledge.class_rank(witness.classification)<knowledge.class_rank(floor_class)
    OR NOT ai.run_authority_read_admitted(p_child.parent_run_id) THEN RETURN false;END IF;
  -- Recheck after the exact step/proposal locks, including committed stop and current attempt.
  RETURN EXISTS(SELECT 1 FROM ai.delegation_birth_candidate(p_child.parent_run_id,p_child.id) fresh
    WHERE ROW(fresh.proposal_id,fresh.snapshot_id,fresh.original_step_id,fresh.original_attempt,fresh.tool_step_number,
      fresh.request_sha256,fresh.proposal_payload_sha256,fresh.birth_content_sha256,fresh.inventory_sha256)
      =ROW(birth.proposal_id,birth.snapshot_id,birth.original_step_id,birth.original_attempt,birth.tool_step_number,
      birth.request_sha256,birth.proposal_payload_sha256,birth.birth_content_sha256,birth.inventory_sha256));
END $$;
REVOKE ALL ON FUNCTION ai.validate_delegation_birth(ai.agent_runs) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.validate_delegation_birth(ai.agent_runs) TO ensemus_agent;

CREATE FUNCTION ai.guard_delegated_work_birth_witness() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
    OR body.version<>1 OR body.status<>'draft' OR body.objective IS NOT NULL
    OR body.parent_id IS DISTINCT FROM parent_row.work_unit_id OR body.owner_membership_id IS DISTINCT FROM parent_row.owner_membership_id
    OR body.project_id IS DISTINCT FROM parent_row.parent_record_id OR body.created_by_membership_id IS DISTINCT FROM parent_row.initiator_membership_id
    OR encode(sha256(convert_to('{"objective":null,"title":'||to_json(body.title)::text||'}','UTF8')),'hex') IS DISTINCT FROM birth.birth_content_sha256 THEN
    RAISE EXCEPTION 'DELEGATED_WORK_INSERT_WITNESS_MISMATCH' USING ERRCODE='EN119';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_delegated_work_birth_witness() FROM PUBLIC;
CREATE TRIGGER delegated_work_birth_witness_guard BEFORE INSERT ON ai.delegated_work_births FOR EACH ROW EXECUTE FUNCTION ai.guard_delegated_work_birth_witness();
CREATE FUNCTION ai.record_delegated_work_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE parent_row record;birth record;child_id uuid;floor_class text;
BEGIN
  IF TG_RELID<>'work.work_units'::regclass OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'DELEGATED_WORK_INSERT_TARGET' USING ERRCODE='42501';END IF;
  IF app.current_actor_type() IS DISTINCT FROM 'agent' OR NEW.parent_id IS NULL THEN RETURN NEW;END IF;
  IF current_user<>'ensemus_agent' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'DELEGATED_WORK_INSERT_DENIED' USING ERRCODE='42501';END IF;
  SELECT run.id,run.initiator_membership_id INTO parent_row FROM ai.agent_runs run WHERE run.organization_id=NEW.organization_id
    AND run.id::text=current_setting('app.agent_run_id',true) AND run.work_unit_id=NEW.parent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELEGATION_INPUT_PROOF_UNAVAILABLE' USING ERRCODE='EN119';END IF;
  SELECT candidate.*,ai.delegated_child_request_id(false,parent_row.initiator_membership_id,parent_row.id,candidate.tool_step_number) actual_child
    INTO birth FROM ai.delegation_birth_candidate(parent_row.id,
      (SELECT ai.delegated_child_request_id(false,parent_row.initiator_membership_id,parent_row.id,step.step_number)
       FROM ai.execution_steps step WHERE step.organization_id=NEW.organization_id AND step.run_id=parent_row.id ORDER BY step.step_number DESC LIMIT 1)) candidate
    WHERE candidate.child_work_unit_id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELEGATION_INPUT_PROOF_UNAVAILABLE' USING ERRCODE='EN119';END IF;
  child_id:=birth.actual_child;floor_class:=ai.lock_delegation_birth(parent_row.id,child_id);
  IF floor_class IS NULL OR knowledge.class_rank(NEW.classification)<knowledge.class_rank(floor_class) THEN
    RAISE EXCEPTION 'DELEGATION_INPUT_PROOF_UNAVAILABLE' USING ERRCODE='EN119';END IF;
  INSERT INTO ai.delegated_work_births(organization_id,work_unit_id,child_run_id,parent_run_id,parent_work_unit_id,
    proposal_id,snapshot_id,birth_content_sha256,classification,inserted_at)
    VALUES(NEW.organization_id,NEW.id,child_id,parent_row.id,NEW.parent_id,birth.proposal_id,birth.snapshot_id,birth.birth_content_sha256,NEW.classification,NEW.created_at);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.record_delegated_work_insert() FROM PUBLIC;
CREATE TRIGGER zz_delegated_work_actual_insert AFTER INSERT ON work.work_units FOR EACH ROW EXECUTE FUNCTION ai.record_delegated_work_insert();
CREATE FUNCTION ai.guard_pending_delegated_work() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'work.work_units'::regclass OR TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'DELEGATED_WORK_UPDATE_TARGET' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM ai.delegated_work_births witness WHERE witness.organization_id=OLD.organization_id AND witness.work_unit_id=OLD.id
    AND NOT EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=witness.organization_id AND receipt.child_run_id=witness.child_run_id)) THEN
    RAISE EXCEPTION 'DELEGATED_WORK_BIRTH_PENDING' USING ERRCODE='EN119';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_pending_delegated_work() FROM PUBLIC;
CREATE TRIGGER delegated_work_pending_update BEFORE UPDATE ON work.work_units FOR EACH ROW EXECUTE FUNCTION ai.guard_pending_delegated_work();

CREATE OR REPLACE FUNCTION ai.guard_delegation_input_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'ai.agent_runs'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'DELEGATION_INPUT_TARGET' USING ERRCODE='42501';END IF;
  IF NEW.parent_run_id IS NOT NULL AND(NOT ai.delegation_influence_ready(NEW.parent_run_id,NEW.id)
    OR NOT ai.validate_delegation_birth(NEW)) THEN
    RAISE EXCEPTION 'DELEGATION_INPUT_PROOF_UNAVAILABLE' USING ERRCODE='EN119';END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- These append rights are solely for an actual nested INSERT trigger. Calling the table/function
-- directly cannot supply a receipt: depth, exact native run, candidate and every field are checked.
CREATE POLICY delegated_receipt_birth_append ON ai.delegated_input_receipts FOR INSERT TO ensemus_agent
  WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()=1 AND app.current_actor_type()='agent'
    AND parent_run_id::text=current_setting('app.agent_run_id',true));
CREATE POLICY delegated_ref_birth_append ON ai.delegated_input_refs FOR INSERT TO ensemus_agent
  WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()=1 AND app.current_actor_type()='agent');
GRANT INSERT ON ai.delegated_input_receipts,ai.delegated_input_refs TO ensemus_agent;
CREATE FUNCTION ai.guard_delegated_birth_append() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE candidate record;child ai.agent_runs;receipt ai.delegated_input_receipts;
BEGIN
  IF TG_OP<>'INSERT' OR TG_RELID NOT IN('ai.delegated_input_receipts'::regclass,'ai.delegated_input_refs'::regclass)
    OR current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent' OR pg_trigger_depth()<>2
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'DELEGATED_BIRTH_APPEND_DENIED' USING ERRCODE='42501';END IF;
  SELECT * INTO child FROM ai.agent_runs WHERE organization_id=NEW.organization_id AND id=NEW.child_run_id;
  IF NOT FOUND OR child.parent_run_id IS NULL OR child.parent_run_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true)
    OR child.initiator_membership_id IS DISTINCT FROM app.current_membership_id() OR child.status<>'queued' OR child.version<>1
    OR ai.run_authority_protocol_version(child.id) IS DISTINCT FROM 'authority-v1' THEN
    RAISE EXCEPTION 'DELEGATED_BIRTH_APPEND_DENIED' USING ERRCODE='42501';END IF;
  IF TG_RELID='ai.delegated_input_receipts'::regclass THEN
    SELECT * INTO candidate FROM ai.delegation_birth_candidate(child.parent_run_id,child.id);
    IF NOT FOUND OR ROW(NEW.parent_run_id,NEW.child_work_unit_id,NEW.proposal_id,NEW.snapshot_id,NEW.original_step_id,NEW.original_attempt,
      NEW.tool_step_number,NEW.request_sha256,NEW.proposal_payload_sha256,NEW.birth_content_sha256,NEW.input_inventory,NEW.inventory_sha256)
      IS DISTINCT FROM ROW(child.parent_run_id,child.work_unit_id,candidate.proposal_id,candidate.snapshot_id,candidate.original_step_id,candidate.original_attempt,
      candidate.tool_step_number,candidate.request_sha256,candidate.proposal_payload_sha256,candidate.birth_content_sha256,candidate.input_inventory,candidate.inventory_sha256)
      OR NEW.parent_receipt_run_id IS DISTINCT FROM(SELECT parent.child_run_id FROM ai.delegated_input_receipts parent
        WHERE parent.organization_id=NEW.organization_id AND parent.child_run_id=NEW.parent_run_id AND parent.redacted_at IS NULL)
      OR NEW.classification IS DISTINCT FROM child.effective_classification OR NEW.born_at IS DISTINCT FROM child.created_at
      OR NEW.redacted_at IS NOT NULL OR NEW.redacted_version IS NOT NULL OR NEW.disposition_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'DELEGATED_BIRTH_RECEIPT_MISMATCH' USING ERRCODE='EN119';END IF;
  ELSE
    SELECT * INTO receipt FROM ai.delegated_input_receipts WHERE organization_id=NEW.organization_id AND child_run_id=NEW.child_run_id;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM ai.delegated_frozen_refs(receipt.input_inventory) frozen
      WHERE ROW(NEW.proof_key_sha256,NEW.ref_kind,NEW.ref_id,NEW.content_sha256,NEW.classification,NEW.source_id,NEW.document_id,NEW.proof_kind,NEW.fact_package_id)
        IS NOT DISTINCT FROM ROW(frozen.proof_key_sha256,frozen.ref_kind,frozen.ref_id,frozen.content_sha256,frozen.classification,frozen.source_id,frozen.document_id,frozen.proof_kind,frozen.fact_package_id)) THEN
      RAISE EXCEPTION 'DELEGATED_BIRTH_REF_MISMATCH' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.guard_delegated_birth_append() FROM PUBLIC;
CREATE TRIGGER delegated_receipt_birth_guard BEFORE INSERT ON ai.delegated_input_receipts FOR EACH ROW EXECUTE FUNCTION ai.guard_delegated_birth_append();
CREATE TRIGGER delegated_ref_birth_guard BEFORE INSERT ON ai.delegated_input_refs FOR EACH ROW EXECUTE FUNCTION ai.guard_delegated_birth_append();
CREATE FUNCTION ai.record_delegated_input_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE birth record;
BEGIN
  IF TG_RELID<>'ai.agent_runs'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'DELEGATED_BIRTH_TARGET' USING ERRCODE='42501';END IF;
  IF NEW.parent_run_id IS NULL THEN RETURN NEW;END IF;
  SELECT candidate.* INTO birth FROM ai.delegation_birth_candidate(NEW.parent_run_id,NEW.id) candidate;
  IF NOT FOUND THEN RAISE EXCEPTION 'DELEGATION_INPUT_PROOF_UNAVAILABLE' USING ERRCODE='EN119';END IF;
  INSERT INTO ai.delegated_input_receipts(organization_id,child_run_id,parent_run_id,parent_receipt_run_id,child_work_unit_id,
    proposal_id,snapshot_id,original_step_id,original_attempt,tool_step_number,request_sha256,proposal_payload_sha256,
    birth_content_sha256,input_inventory,inventory_sha256,classification,born_at)
  VALUES(NEW.organization_id,NEW.id,NEW.parent_run_id,(SELECT parent.child_run_id FROM ai.delegated_input_receipts parent
      WHERE parent.organization_id=NEW.organization_id AND parent.child_run_id=NEW.parent_run_id AND parent.redacted_at IS NULL),
    NEW.work_unit_id,birth.proposal_id,birth.snapshot_id,birth.original_step_id,birth.original_attempt,birth.tool_step_number,
    birth.request_sha256,birth.proposal_payload_sha256,birth.birth_content_sha256,birth.input_inventory,birth.inventory_sha256,NEW.effective_classification,NEW.created_at);
  INSERT INTO ai.delegated_input_refs(organization_id,child_run_id,proof_key_sha256,ref_kind,ref_id,content_sha256,classification,source_id,document_id,proof_kind,fact_package_id)
    SELECT NEW.organization_id,NEW.id,frozen.* FROM ai.delegated_frozen_refs(birth.input_inventory) frozen;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.record_delegated_input_birth() FROM PUBLIC;
-- Alphabetically after both actual run/checkpoint birth writers; never a historical backfill.
CREATE TRIGGER zz_delegated_input_actual_birth AFTER INSERT ON ai.agent_runs FOR EACH ROW EXECUTE FUNCTION ai.record_delegated_input_birth();
--> statement-breakpoint
-- Pinned child protection and fresh named-viewer access are independent. A mutable current body
-- hash is never substituted for a captured input hash. No NULL/service viewer exception exists.
CREATE FUNCTION ai.delegated_receipt_readable(p_child uuid,p_viewer uuid,p_protection text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE receipt ai.delegated_input_receipts;ref record;current_class text;ref_count integer:=0;
BEGIN
  IF p_viewer IS NULL OR p_protection IS NULL OR p_protection NOT IN('public','internal','confidential','restricted') THEN RETURN false;END IF;
  SELECT * INTO receipt FROM ai.delegated_input_receipts actual WHERE actual.organization_id=app.current_organization_id() AND actual.child_run_id=p_child;
  IF NOT FOUND OR receipt.redacted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ai.delegated_work_births witness
    WHERE witness.organization_id=receipt.organization_id AND witness.work_unit_id=receipt.child_work_unit_id
      AND ROW(witness.child_run_id,witness.parent_run_id,witness.proposal_id,witness.snapshot_id,witness.birth_content_sha256)
      =ROW(receipt.child_run_id,receipt.parent_run_id,receipt.proposal_id,receipt.snapshot_id,receipt.birth_content_sha256)) THEN RETURN false;END IF;
  IF knowledge.class_rank(receipt.classification)>knowledge.class_rank(p_protection) THEN RETURN false;END IF;
  FOR ref IN SELECT frozen.* FROM ai.delegated_input_refs frozen WHERE frozen.organization_id=receipt.organization_id AND frozen.child_run_id=receipt.child_run_id LOOP
    ref_count:=ref_count+1;
    IF ref_count>1000 OR knowledge.class_rank(ref.classification)>knowledge.class_rank(p_protection) THEN RETURN false;END IF;
    current_class:=ai.frozen_ref_current_class(ref.ref_kind,ref.ref_id,ref.content_sha256,ref.source_id,ref.document_id,p_viewer);
    IF current_class IS NULL OR knowledge.class_rank(current_class)>knowledge.class_rank(p_protection) THEN RETURN false;END IF;
  END LOOP;
  RETURN ref_count>0;
END $$;
REVOKE ALL ON FUNCTION ai.delegated_receipt_readable(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.delegated_receipt_readable(uuid,uuid,text) TO ensemus_app;

CREATE OR REPLACE FUNCTION knowledge.inherited_work_inputs_readable(p_work uuid,p_viewer uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS(SELECT 1 FROM ai.unproven_child_work_inputs unknown_input
      WHERE unknown_input.organization_id=app.current_organization_id() AND unknown_input.work_unit_id=p_work)
    AND NOT EXISTS(SELECT 1 FROM ai.delegated_work_births witness WHERE witness.organization_id=app.current_organization_id() AND witness.work_unit_id=p_work
      AND NOT EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=witness.organization_id AND receipt.child_run_id=witness.child_run_id))
    AND NOT EXISTS(SELECT 1 FROM ai.agent_runs child WHERE child.organization_id=app.current_organization_id() AND child.work_unit_id=p_work AND child.parent_run_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=child.organization_id AND receipt.child_run_id=child.id))
    AND NOT EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=app.current_organization_id() AND receipt.child_work_unit_id=p_work
      AND NOT ai.delegated_receipt_readable(receipt.child_run_id,p_viewer,knowledge.work_scope_class(p_work)))
$$;
-- Preserve 0411's body-free public class helper while adding the independently pinned birth floor.
CREATE FUNCTION knowledge.work_scope_base_class_0419(p_work uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE greatest(knowledge.class_rank(own.classification),coalesce(knowledge.class_rank(knowledge.structured_record_class('project',own.parent_record_id)),0))
    WHEN 3 THEN 'restricted' WHEN 2 THEN 'confidential' WHEN 1 THEN 'internal' ELSE 'public' END
  FROM knowledge.structured_record_catalog own WHERE own.organization_id=app.current_organization_id()
    AND own.record_kind='work_unit' AND own.record_id=p_work AND own.alive
    AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=own.organization_id AND tomb.target_type='work_unit' AND tomb.target_id=own.record_id)
    AND(own.parent_record_id IS NULL OR knowledge.structured_record_class('project',own.parent_record_id) IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION knowledge.work_scope_base_class_0419(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.work_scope_base_class_0419(uuid) TO ensemus_app;
CREATE OR REPLACE FUNCTION knowledge.work_scope_class(p_work uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE greatest(knowledge.class_rank(base.classification),coalesce((SELECT max(knowledge.class_rank(receipt.classification))
      FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=app.current_organization_id() AND receipt.child_work_unit_id=p_work),0))
    WHEN 3 THEN 'restricted' WHEN 2 THEN 'confidential' WHEN 1 THEN 'internal' ELSE 'public' END
  FROM(SELECT knowledge.work_scope_base_class_0419(p_work) classification) base WHERE base.classification IS NOT NULL
$$;
-- This is a current read/dispatch admission only, not permission to create a child. Legacy children
-- without actual birth evidence remain denied for agents and all human Work/file viewers alike.
CREATE OR REPLACE FUNCTION ai.run_scope_preflight(p_run uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(current_user='ensemus_agent' AND app.current_actor_type()='agent' AND current_setting('app.agent_input_protocol',true)='v1'
    AND current_setting('app.agent_run_id',true)=p_run::text AND EXISTS(
      SELECT 1 FROM ai.run_input_checkpoints checkpoint JOIN ai.agent_runs run ON run.organization_id=checkpoint.organization_id AND run.id=checkpoint.run_id
        JOIN org.memberships viewer ON viewer.organization_id=run.organization_id AND viewer.id=run.initiator_membership_id AND viewer.status='active'
      WHERE checkpoint.organization_id=app.current_organization_id() AND checkpoint.run_id=p_run AND checkpoint.history_complete
        AND checkpoint.protocol_version='v1' AND checkpoint.fenced_at IS NULL AND run.initiator_membership_id=app.current_membership_id()
        AND run.status IN('queued','preparing','running','paused','waiting_for_approval','waiting_for_child','verifying')
        AND knowledge.inherited_work_inputs_readable(run.work_unit_id,run.initiator_membership_id)
        AND(run.parent_run_id IS NULL OR EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=run.organization_id
          AND receipt.child_run_id=run.id AND receipt.parent_run_id=run.parent_run_id AND receipt.child_work_unit_id=run.work_unit_id AND receipt.redacted_at IS NULL))),false)
$$;
--> statement-breakpoint
-- A Work read through work.read, a fact subject, an auxiliary call or an artifact is an influence
-- too. Do not limit inheritance to the run's target Work or allow its source scope to disappear.
CREATE FUNCTION ai.run_inherited_receipt_ids(p_run uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  WITH work_refs AS(
    SELECT run.work_unit_id id FROM ai.agent_runs run WHERE run.organization_id=app.current_organization_id() AND run.id=p_run
    UNION SELECT(entry->>'id')::uuid FROM jsonb_array_elements(ai.main_input_base_inventory_0417(p_run)) entry
      WHERE entry->>'kind' IN('work_unit','authority_work_unit')
    UNION SELECT(ref->>'id')::uuid FROM ai.run_read_authorities authority CROSS JOIN LATERAL jsonb_array_elements(authority.authority_inventory) ref
      WHERE authority.organization_id=app.current_organization_id() AND authority.run_id=p_run AND ref->>'kind'='work_unit'
  ) SELECT receipt.child_run_id FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=app.current_organization_id()
    AND receipt.child_work_unit_id IN(SELECT id FROM work_refs) ORDER BY receipt.child_run_id
$$;
REVOKE ALL ON FUNCTION ai.run_inherited_receipt_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.run_inherited_receipt_ids(uuid) TO ensemus_agent;
CREATE FUNCTION ai.lock_run_inherited_inputs(p_run uuid,p_viewer uuid)
RETURNS TABLE(classification text,input_count integer,source_ids uuid[]) LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE receipt ai.delegated_input_receipts;target_work uuid;current_class text;floor_rank integer:=0;
BEGIN
  IF current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent'
    OR p_run::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR p_viewer IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'INHERITED_INPUT_PRINCIPAL_REQUIRED' USING ERRCODE='42501';END IF;
  SELECT run.work_unit_id INTO target_work FROM ai.agent_runs run WHERE run.organization_id=app.current_organization_id()
    AND run.id=p_run AND run.initiator_membership_id=p_viewer;
  IF NOT FOUND THEN RAISE EXCEPTION 'INHERITED_INPUT_PRINCIPAL_REQUIRED' USING ERRCODE='EN119';END IF;
  IF NOT knowledge.inherited_work_inputs_readable(target_work,p_viewer) THEN RAISE EXCEPTION 'INHERITED_INPUT_PROOF_UNAVAILABLE' USING ERRCODE='EN119';END IF;
  FOR receipt IN SELECT actual.* FROM ai.delegated_input_receipts actual WHERE actual.organization_id=app.current_organization_id()
    AND actual.child_run_id IN(SELECT ai.run_inherited_receipt_ids(p_run)) ORDER BY actual.child_run_id LOOP
    current_class:=ai.lock_frozen_input_refs(receipt.input_inventory,p_viewer);
    IF current_class IS NULL OR NOT knowledge.inherited_work_inputs_readable(receipt.child_work_unit_id,p_viewer) THEN
      RAISE EXCEPTION 'INHERITED_INPUT_PROOF_UNAVAILABLE' USING ERRCODE='EN119';END IF;
    floor_rank:=greatest(floor_rank,knowledge.class_rank(current_class));
  END LOOP;
  classification:=CASE floor_rank WHEN 3 THEN 'restricted' WHEN 2 THEN 'confidential' WHEN 1 THEN 'internal' ELSE 'public' END;
  SELECT count(*)::integer INTO input_count FROM ai.delegated_input_refs ref WHERE ref.organization_id=app.current_organization_id()
    AND ref.child_run_id IN(SELECT ai.run_inherited_receipt_ids(p_run));
  SELECT coalesce(array_agg(id ORDER BY id),ARRAY[]::uuid[]) INTO source_ids FROM(
    SELECT DISTINCT coalesce(ref.source_id,CASE WHEN ref.ref_kind='source' THEN ref.ref_id END) id
      FROM ai.delegated_input_refs ref WHERE ref.organization_id=app.current_organization_id() AND ref.child_run_id IN(SELECT ai.run_inherited_receipt_ids(p_run))
  ) sources WHERE id IS NOT NULL;
  IF input_count>1000 THEN RAISE EXCEPTION 'INHERITED_INPUT_PROOF_UNAVAILABLE' USING ERRCODE='EN119';END IF;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION ai.lock_run_inherited_inputs(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.lock_run_inherited_inputs(uuid,uuid) TO ensemus_agent;

-- Preserve the public OID, retaining direct actual reads and a distinct immutable inherited
-- influence envelope. These are not child observations; future parent reads never enter it.
CREATE OR REPLACE FUNCTION ai.current_main_input_inventory(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE receipt_count bigint;receipt_bytes bigint;result jsonb;
BEGIN
  SELECT count(*),coalesce(sum(octet_length(a.authority_inventory::text)),0) INTO receipt_count,receipt_bytes
    FROM ai.run_read_authorities a WHERE a.organization_id=app.current_organization_id() AND a.run_id=p_run;
  IF receipt_count>1000 OR receipt_bytes>1048576 THEN RAISE EXCEPTION 'MAIN_READ_AUTHORITY_LIMIT' USING ERRCODE='EN119';END IF;
  WITH entries AS(
    SELECT value entry FROM jsonb_array_elements(ai.main_input_base_inventory_0417(p_run)) WHERE value->>'kind'<>'fact'
    UNION SELECT jsonb_build_object('kind','fact','id',fact.fact_id,'sha256',fact.content_sha256,'classification',fact.classification,
      'packageId',fact.package_id,'subjectRef',fact.subject_ref)
      FROM knowledge.evidence_package_facts fact WHERE fact.organization_id=app.current_organization_id()
        AND fact.package_id IN(SELECT(entry->>'id')::uuid FROM jsonb_array_elements(ai.main_input_base_inventory_0417(p_run)) entry WHERE entry->>'kind'='evidence_package')
    UNION SELECT jsonb_build_object('kind','source','id',split_part(fact.subject_ref,':',2)::uuid,'sha256',NULL,
      'classification',fact.classification,'sourceId',split_part(fact.subject_ref,':',2)::uuid,'documentId',NULL::uuid)
      FROM knowledge.evidence_package_facts fact WHERE fact.organization_id=app.current_organization_id() AND fact.subject_ref LIKE 'knowledge_source:%'
        AND fact.package_id IN(SELECT(entry->>'id')::uuid FROM jsonb_array_elements(ai.main_input_base_inventory_0417(p_run)) entry WHERE entry->>'kind'='evidence_package')
    UNION SELECT jsonb_build_object('kind','unproven_fact_authority','id',fact.fact_id,'sha256',fact.content_sha256,'classification',fact.classification)
      FROM knowledge.evidence_package_facts fact WHERE fact.organization_id=app.current_organization_id() AND fact.subject_ref IS NULL
        AND fact.package_id IN(SELECT(entry->>'id')::uuid FROM jsonb_array_elements(ai.main_input_base_inventory_0417(p_run)) entry WHERE entry->>'kind'='evidence_package')
    UNION SELECT jsonb_build_object('kind','read_authority','id',a.input_id,'sha256',a.authority_sha256,
      'classification',(SELECT value->>'classification' FROM jsonb_array_elements(a.authority_inventory)
        ORDER BY knowledge.class_rank(value->>'classification') DESC LIMIT 1),
      'sourceId',NULL::uuid,'documentId',NULL::uuid,'inputKind',a.input_kind,'inputSha256',a.input_sha256,
      'authorizationWorkUnitId',a.authorization_work_unit_id,'authorityInventory',a.authority_inventory)
      FROM ai.run_read_authorities a WHERE a.organization_id=app.current_organization_id() AND a.run_id=p_run
    UNION SELECT jsonb_build_object('kind','inherited_influence','id',receipt.child_run_id,'sha256',receipt.inventory_sha256,
      'classification',receipt.classification,'workUnitId',receipt.child_work_unit_id,'birthContentSha256',receipt.birth_content_sha256,
      'influenceRefs',(SELECT jsonb_agg(jsonb_build_object('kind',ref.ref_kind,'id',ref.ref_id,'sha256',ref.content_sha256,
        'classification',ref.classification,'sourceId',ref.source_id,'documentId',ref.document_id,'proofKind',ref.proof_kind,'factPackageId',ref.fact_package_id)
        ORDER BY ref.proof_key_sha256 COLLATE "C") FROM ai.delegated_input_refs ref
          WHERE ref.organization_id=receipt.organization_id AND ref.child_run_id=receipt.child_run_id))
      FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=app.current_organization_id()
        AND receipt.child_run_id IN(SELECT ai.run_inherited_receipt_ids(p_run)) AND receipt.redacted_at IS NULL
  ),bounded AS(SELECT entry FROM entries ORDER BY entry::text COLLATE "C" LIMIT 1001)
  SELECT coalesce(jsonb_agg(entry ORDER BY entry::text COLLATE "C"),'[]'::jsonb) INTO result FROM bounded;
  IF octet_length(result::text)>1048576 THEN RAISE EXCEPTION 'MAIN_READ_AUTHORITY_LIMIT' USING ERRCODE='EN119';END IF;
  PERFORM 1 FROM ai.delegated_frozen_refs(result);
  RETURN result;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ai.guard_main_input_snapshot() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
    OR NOT ai.run_inputs_readable(NEW.run_id,NEW.viewer_membership_id) THEN RAISE EXCEPTION 'MAIN_SNAPSHOT_ATTEMPT_STALE' USING ERRCODE='EN119';END IF;
  IF TG_OP='INSERT' THEN
    inventory:=ai.current_main_input_inventory(NEW.run_id);
    IF NEW.state<>'prepared' OR NEW.input_inventory IS DISTINCT FROM inventory OR jsonb_array_length(inventory) NOT BETWEEN 1 AND 1000
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(inventory) i WHERE i->>'classification' IS NULL OR i->>'classification' NOT IN('public','internal','confidential','restricted')
        OR i->>'kind' NOT IN('work_unit','project','client','object_record','artifact','chunk','document','source','fact','evidence_package','model_call','authority_work_unit','authority_project','authority_client','authority_object_record','read_authority','inherited_influence')
        OR(i->>'kind' NOT IN('source','authority_work_unit','authority_project','authority_client','authority_object_record') AND(i->>'sha256' IS NULL OR i->>'sha256' !~ '^[0-9a-f]{64}$')))
      OR NEW.inventory_sha256 IS DISTINCT FROM encode(sha256(convert_to(inventory::text,'UTF8')),'hex')
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(inventory) i JOIN ai.agent_runs r ON r.organization_id=NEW.organization_id AND r.id=NEW.run_id
        WHERE i->>'kind'='work_unit' AND i->>'id'=r.work_unit_id::text) THEN RAISE EXCEPTION 'MAIN_SNAPSHOT_INCOMPLETE' USING ERRCODE='EN119';END IF;
  ELSE
    IF(to_jsonb(NEW)-ARRAY['state','result_kind','result_tool_id','result_payload_hash']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','result_kind','result_tool_id','result_payload_hash']) THEN
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
--> statement-breakpoint
CREATE FUNCTION ai.run_source_scope_allows(p_run uuid,p_source uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE cursor_run uuid:=p_run;seen uuid[]:=ARRAY[]::uuid[];node record;scope text;found_source boolean;previous_depth integer;
BEGIN
  IF p_source IS NULL OR current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent'
    OR p_run::text IS DISTINCT FROM current_setting('app.agent_run_id',true) THEN RETURN false;END IF;
  LOOP
    IF cursor_run IS NULL OR cursor_run=ANY(seen) OR cardinality(seen)>=6 THEN RETURN false;END IF;
    seen:=array_append(seen,cursor_run);
    SELECT run.parent_run_id,run.depth,version.spec INTO node FROM ai.agent_runs run JOIN ai.agent_versions version
      ON version.organization_id=run.organization_id AND version.id=run.agent_version_id WHERE run.organization_id=app.current_organization_id()
      AND run.id=cursor_run AND run.initiator_membership_id=app.current_membership_id();
    IF NOT FOUND OR node.depth NOT BETWEEN 0 AND 5 OR(previous_depth IS NOT NULL AND node.depth<>previous_depth-1)
      OR jsonb_typeof(node.spec->'context'->'allowed_scopes') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
    IF jsonb_array_length(node.spec->'context'->'allowed_scopes')>1000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(node.spec->'context'->'allowed_scopes') entry
      WHERE jsonb_typeof(entry)<>'string') THEN RETURN false;END IF;
    found_source:=false;
    FOR scope IN SELECT value FROM jsonb_array_elements_text(node.spec->'context'->'allowed_scopes') value LOOP
      IF lower(btrim(scope))='knowledge' OR lower(btrim(scope)) LIKE 'knowledge.%' THEN
        IF scope !~ '^knowledge\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.read$' THEN RETURN false;END IF;
        IF split_part(scope,'.',2)::uuid=p_source THEN found_source:=true;END IF;
      END IF;
    END LOOP;
    IF NOT found_source THEN RETURN false;END IF;
    IF node.parent_run_id IS NULL THEN RETURN node.depth=0;END IF;
    previous_depth:=node.depth;cursor_run:=node.parent_run_id;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION ai.run_source_scope_allows(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.run_source_scope_allows(uuid,uuid) TO ensemus_agent;
CREATE FUNCTION ai.work_inherited_scope_allows(p_work uuid,p_run uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt JOIN ai.delegated_input_refs ref
    ON ref.organization_id=receipt.organization_id AND ref.child_run_id=receipt.child_run_id
    WHERE receipt.organization_id=app.current_organization_id() AND receipt.child_work_unit_id=p_work
      AND((ref.ref_kind='source' AND NOT ai.run_source_scope_allows(p_run,ref.ref_id))
        OR(ref.source_id IS NOT NULL AND NOT ai.run_source_scope_allows(p_run,ref.source_id))))
$$;
REVOKE ALL ON FUNCTION ai.work_inherited_scope_allows(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.work_inherited_scope_allows(uuid,uuid) TO ensemus_agent;
CREATE FUNCTION ai.prospective_input_scope_allows(p_kind text,p_id uuid,p_work uuid,p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_kind='work_unit' THEN ai.work_inherited_scope_allows(p_id,p_run)
    WHEN p_kind='artifact' THEN
      ai.work_inherited_scope_allows(p_work,p_run)
      AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_required_sources(p_id) source_id WHERE NOT ai.run_source_scope_allows(p_run,source_id))
      AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_required_records(p_id) ref WHERE ref.record_kind='work_unit' AND NOT ai.work_inherited_scope_allows(ref.record_id,p_run))
    WHEN p_kind IN('project','client','object_record') THEN true ELSE false END
$$;
REVOKE ALL ON FUNCTION ai.prospective_input_scope_allows(text,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.prospective_input_scope_allows(text,uuid,uuid,uuid) TO ensemus_agent;
CREATE FUNCTION ai.lock_prospective_input_scope(p_kind text,p_id uuid,p_work uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE receipt ai.delegated_input_receipts;current_class text;run_key uuid:=nullif(current_setting('app.agent_run_id',true),'')::uuid;
BEGIN
  IF current_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent' OR run_key IS NULL
    OR NOT ai.run_authority_read_admitted(run_key) THEN RETURN false;END IF;
  FOR receipt IN SELECT actual.* FROM ai.delegated_input_receipts actual WHERE actual.organization_id=app.current_organization_id()
    AND actual.child_work_unit_id IN(
      SELECT p_id WHERE p_kind='work_unit' UNION SELECT p_work WHERE p_kind='artifact'
      UNION SELECT ref.record_id FROM knowledge.artifact_required_records(p_id) ref WHERE p_kind='artifact' AND ref.record_kind='work_unit')
    ORDER BY actual.child_run_id LOOP
    current_class:=ai.lock_frozen_input_refs(receipt.input_inventory,app.current_membership_id());
    IF current_class IS NULL OR NOT knowledge.inherited_work_inputs_readable(receipt.child_work_unit_id,app.current_membership_id()) THEN RETURN false;END IF;
    IF ai.run_company_ceiling(run_key) IS NOT NULL AND knowledge.class_rank(current_class)>ai.run_company_ceiling(run_key) THEN RETURN false;END IF;
  END LOOP;
  RETURN ai.prospective_input_scope_allows(p_kind,p_id,p_work,run_key);
END $$;
REVOKE ALL ON FUNCTION ai.lock_prospective_input_scope(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.lock_prospective_input_scope(text,uuid,uuid) TO ensemus_agent;
-- Even a bundled writer that skipped the new prospective-read helper cannot read a child title or
-- source-derived file with no immutable Knowledge grant. Metadata helpers do not recurse body RLS.
CREATE POLICY delegated_company_source_scope ON work.work_units AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING(CASE WHEN(session_user='ensemus_agent' OR app.current_actor_type()='agent')
    AND EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=work_units.organization_id AND receipt.child_work_unit_id=work_units.id) THEN
    (NOT ai.run_authority_required(nullif(current_setting('app.agent_run_id',true),'')::uuid)
      OR ai.run_authority_read_admitted(nullif(current_setting('app.agent_run_id',true),'')::uuid))
    AND ai.work_inherited_scope_allows(work_units.id,nullif(current_setting('app.agent_run_id',true),'')::uuid)
    AND(ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid) IS NULL
      OR knowledge.class_rank(knowledge.work_scope_class(work_units.id))<=ai.run_company_ceiling(nullif(current_setting('app.agent_run_id',true),'')::uuid))
    ELSE true END);
CREATE POLICY derived_company_source_scope ON work.artifacts AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING(CASE WHEN(session_user='ensemus_agent' OR app.current_actor_type()='agent') AND(
    EXISTS(SELECT 1 FROM knowledge.artifact_required_sources(artifacts.id)) OR EXISTS(
      SELECT 1 FROM knowledge.artifact_required_records(artifacts.id) record JOIN ai.delegated_input_receipts receipt
        ON receipt.organization_id=artifacts.organization_id AND receipt.child_work_unit_id=record.record_id WHERE record.record_kind='work_unit')) THEN
    (NOT ai.run_authority_required(nullif(current_setting('app.agent_run_id',true),'')::uuid)
      OR ai.run_authority_read_admitted(nullif(current_setting('app.agent_run_id',true),'')::uuid))
    AND ai.prospective_input_scope_allows('artifact',artifacts.id,NULL,nullif(current_setting('app.agent_run_id',true),'')::uuid)
    ELSE true END);
--> statement-breakpoint
-- A generated file retains its own genuine pre-put prefix. The proof is not reconstructed later
-- from current Work parents or a now-empty run, and its exact writer identity cannot be replaced.
CREATE TABLE knowledge.artifact_authority_receipts (
  organization_id uuid NOT NULL,artifact_id uuid NOT NULL,work_unit_id uuid NOT NULL,run_id uuid,viewer_membership_id uuid,
  protocol_version text NOT NULL,write_id uuid NOT NULL,generation bigint NOT NULL,artifact_sha256 text NOT NULL,
  classification text NOT NULL,input_inventory jsonb NOT NULL,inventory_sha256 text NOT NULL,captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_authority_receipts_pk PRIMARY KEY(organization_id,artifact_id),
  CONSTRAINT artifact_authority_receipts_artifact_fk FOREIGN KEY(organization_id,artifact_id) REFERENCES knowledge.artifact_lineage(organization_id,artifact_id),
  CONSTRAINT artifact_authority_receipts_work_fk FOREIGN KEY(organization_id,work_unit_id) REFERENCES work.work_units(organization_id,id),
  CONSTRAINT artifact_authority_receipts_run_fk FOREIGN KEY(organization_id,run_id) REFERENCES ai.agent_runs(organization_id,id),
  CONSTRAINT artifact_authority_receipts_protocol CHECK((protocol_version='authority-v1' AND run_id IS NOT NULL AND viewer_membership_id IS NOT NULL)
    OR(protocol_version='system-template-v1' AND run_id IS NULL AND viewer_membership_id IS NULL)),
  CONSTRAINT artifact_authority_receipts_identity CHECK(generation>0 AND artifact_sha256 ~ '^[0-9a-f]{64}$' AND inventory_sha256 ~ '^[0-9a-f]{64}$' AND classification IN('public','internal','confidential','restricted')),
  CONSTRAINT artifact_authority_receipts_inventory CHECK(jsonb_typeof(input_inventory)='array' AND jsonb_array_length(input_inventory) BETWEEN 1 AND 1000 AND octet_length(input_inventory::text)<=1048576)
);
CREATE TABLE knowledge.artifact_authority_refs (
  organization_id uuid NOT NULL,artifact_id uuid NOT NULL,proof_key_sha256 text NOT NULL,ref_kind text NOT NULL,ref_id uuid NOT NULL,
  content_sha256 text,classification text NOT NULL,source_id uuid,document_id uuid,proof_kind text NOT NULL,fact_package_id uuid,
  CONSTRAINT artifact_authority_refs_pk PRIMARY KEY(organization_id,artifact_id,proof_key_sha256),
  CONSTRAINT artifact_authority_refs_receipt_fk FOREIGN KEY(organization_id,artifact_id) REFERENCES knowledge.artifact_authority_receipts(organization_id,artifact_id),
  CONSTRAINT artifact_authority_refs_fact_receipt_fk FOREIGN KEY(organization_id,fact_package_id,ref_id) REFERENCES knowledge.evidence_package_facts(organization_id,package_id,fact_id),
  CONSTRAINT artifact_authority_refs_fact_origin CHECK((ref_kind='fact')=(fact_package_id IS NOT NULL)),
  CONSTRAINT artifact_authority_refs_shape CHECK(proof_key_sha256 ~ '^[0-9a-f]{64}$' AND(content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$')
    AND ref_kind IN('work_unit','project','client','object_record','artifact','chunk','document','source','fact','evidence_package','model_call')
    AND classification IN('public','internal','confidential','restricted') AND proof_kind IN('actual_content','read_authority','current_authority','model_metadata')
    AND(proof_kind NOT IN('actual_content','model_metadata') OR content_sha256 IS NOT NULL) AND(proof_kind<>'read_authority' OR content_sha256 IS NULL))
);
CREATE INDEX artifact_authority_refs_source_idx ON knowledge.artifact_authority_refs(organization_id,source_id,artifact_id);
CREATE INDEX artifact_authority_refs_target_idx ON knowledge.artifact_authority_refs(organization_id,ref_kind,ref_id,artifact_id);
ALTER TABLE knowledge.artifact_authority_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.artifact_authority_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge.artifact_authority_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.artifact_authority_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_authority_metadata ON knowledge.artifact_authority_receipts FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
CREATE POLICY artifact_authority_ref_metadata ON knowledge.artifact_authority_refs FOR SELECT TO ensemus_app USING(organization_id=app.current_organization_id());
GRANT SELECT ON knowledge.artifact_authority_receipts,knowledge.artifact_authority_refs TO ensemus_app;
CREATE TRIGGER artifact_authority_receipt_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON knowledge.artifact_authority_receipts FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
CREATE TRIGGER artifact_authority_refs_keep BEFORE UPDATE OR DELETE OR TRUNCATE ON knowledge.artifact_authority_refs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_change();
--> statement-breakpoint
-- Pure tenant metadata/normalization helpers; app already reads these catalogs. No body, marker or
-- read capability is added. Actual system output uses a distinct known-template protocol below.
GRANT EXECUTE ON FUNCTION ai.delegated_frozen_refs(jsonb),ai.structured_read_authorities(text,uuid),ai.current_read_authority_inventory(text,uuid,uuid) TO ensemus_app;
CREATE FUNCTION knowledge.known_checklist_authority(p_artifact uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE header knowledge.artifact_lineage;body_work record;criterion jsonb;rendered text;criteria_lines text;criteria_json text;
  record_hash text;authority jsonb;authority_hash text;protection text;
BEGIN
  IF current_user<>'ensemus_app' OR session_user<>'ensemus_app' OR NOT knowledge.is_service_actor() THEN RETURN NULL;END IF;
  SELECT * INTO header FROM knowledge.artifact_lineage actual WHERE actual.organization_id=app.current_organization_id() AND actual.artifact_id=p_artifact;
  IF NOT FOUND OR header.execution_kind<>'system' OR header.executor_ref<>'ensemus/completion-checklist/v1'
    OR header.execution_id IS NULL OR header.work_unit_id IS NULL THEN RETURN NULL;END IF;
  -- Existing caller RLS applies. A service cannot use this function to obtain arbitrary Work bodies;
  -- only the exact enum/ID template digest leaves it. Unproven child Work remains unavailable.
  SELECT work.id,work.completion_criteria INTO body_work FROM work.work_units work
    WHERE work.organization_id=header.organization_id AND work.id=header.work_unit_id AND work.status='running' AND work.run_id=header.execution_id::text;
  IF NOT FOUND OR jsonb_typeof(body_work.completion_criteria) IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
  IF jsonb_array_length(body_work.completion_criteria)>1000 THEN RETURN NULL;END IF;
  FOR criterion IN SELECT value FROM jsonb_array_elements(body_work.completion_criteria) LOOP
    IF jsonb_typeof(criterion) IS DISTINCT FROM 'object' OR criterion->>'kind' IS NULL
      OR criterion->>'kind' NOT IN('artifact_exists','reviewer_approved','external_receipt')
      OR criterion IS DISTINCT FROM jsonb_build_object('kind',criterion->>'kind') THEN RETURN NULL;END IF;
  END LOOP;
  SELECT string_agg('- [ ] '||CASE value->>'kind'
      WHEN 'artifact_exists' THEN 'Someone attaches the file that shows the result.'
      WHEN 'reviewer_approved' THEN 'A reviewer approves this work as it stands.'
      WHEN 'external_receipt' THEN 'The outside system confirms it happened.' END,E'\n' ORDER BY ordinal),
    string_agg('{"kind":'||to_json(value->>'kind')::text||'}',',' ORDER BY ordinal)
    INTO criteria_lines,criteria_json FROM jsonb_array_elements(body_work.completion_criteria) WITH ORDINALITY entries(value,ordinal);
  rendered:='# Completion checklist'||E'\n\n'
    ||'Ensemus wrote this list. It has not checked any of this, and this file is not evidence.'||E'\n'
    ||'A person decides when this work is done.'||E'\n\nWork: '||body_work.id::text||E'\n\n'
    ||coalesce(criteria_lines,'- [ ] The accountable owner confirms the outcome. No evidence was asked for.')||E'\n';
  IF header.artifact_sha256 IS DISTINCT FROM encode(sha256(convert_to(rendered,'UTF8')),'hex') OR header.size_bytes<>octet_length(rendered) THEN RETURN NULL;END IF;
  record_hash:=encode(sha256(convert_to('{"completionCriteria":['||coalesce(criteria_json,'')||'],"id":'||to_json(body_work.id::text)::text||'}','UTF8')),'hex');
  IF EXISTS(SELECT 1 FROM knowledge.artifact_lineage_inputs input WHERE input.organization_id=header.organization_id AND input.artifact_id=header.artifact_id)
    OR EXISTS(SELECT 1 FROM knowledge.artifact_lineage_packages package WHERE package.organization_id=header.organization_id AND package.artifact_id=header.artifact_id)
    OR EXISTS(SELECT 1 FROM knowledge.artifact_lineage_sources source WHERE source.organization_id=header.organization_id AND source.artifact_id=header.artifact_id) THEN RETURN NULL;END IF;
  protection:=knowledge.structured_record_class('work_unit',header.work_unit_id);
  authority:=ai.current_read_authority_inventory('work_unit',header.work_unit_id,NULL);
  IF protection IS NULL OR authority IS NULL OR jsonb_array_length(authority) NOT BETWEEN 1 AND 1000 THEN RETURN NULL;END IF;
  authority_hash:=encode(sha256(convert_to(authority::text,'UTF8')),'hex');
  RETURN jsonb_build_array(jsonb_build_object('kind','work_unit','id',header.work_unit_id,'sha256',record_hash,'classification',protection),
    jsonb_build_object('kind','read_authority','id',header.work_unit_id,'sha256',authority_hash,'classification',protection,
      'inputKind','work_unit','inputSha256',record_hash,'authorityInventory',authority));
END $$;
REVOKE ALL ON FUNCTION knowledge.known_checklist_authority(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.known_checklist_authority(uuid) TO ensemus_app;
CREATE FUNCTION knowledge.current_artifact_authority_inventory(p_artifact uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE header knowledge.artifact_lineage;inventory jsonb;
BEGIN
  SELECT * INTO header FROM knowledge.artifact_lineage actual WHERE actual.organization_id=app.current_organization_id() AND actual.artifact_id=p_artifact;
  IF NOT FOUND OR header.state<>'pending' OR header.write_state<>'active' OR NOT header.inventory_complete OR NOT header.structured_inventory_complete
    OR header.physical_purged_at IS NOT NULL OR header.held THEN RETURN NULL;END IF;
  IF header.execution_kind='agent_run' THEN
    IF current_user<>'ensemus_agent' OR session_user<>'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent'
      OR header.execution_id::text IS DISTINCT FROM current_setting('app.agent_run_id',true) OR header.viewer_membership_id IS DISTINCT FROM app.current_membership_id()
      OR ai.run_authority_protocol_version(header.execution_id) IS DISTINCT FROM 'authority-v1' OR NOT ai.run_authority_read_admitted(header.execution_id)
      OR NOT ai.run_authority_ready(header.execution_id,header.viewer_membership_id) OR NOT EXISTS(SELECT 1 FROM ai.agent_runs run
        WHERE run.organization_id=header.organization_id AND run.id=header.execution_id AND run.work_unit_id=header.work_unit_id AND run.initiator_membership_id=header.viewer_membership_id) THEN RETURN NULL;END IF;
    inventory:=ai.current_main_input_inventory(header.execution_id);
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(inventory) input WHERE input->>'kind'='read_authority'
      AND input->>'inputKind'='work_unit' AND input->>'id'=header.work_unit_id::text) THEN RETURN NULL;END IF;
  ELSIF header.execution_kind='system' THEN inventory:=knowledge.known_checklist_authority(p_artifact);
  ELSE RETURN NULL;END IF;
  IF inventory IS NULL OR jsonb_array_length(inventory) NOT BETWEEN 1 AND 1000 OR octet_length(inventory::text)>1048576 THEN RETURN NULL;END IF;
  IF EXISTS(SELECT 1 FROM ai.delegated_frozen_refs(inventory) ref WHERE knowledge.class_rank(ref.classification)>knowledge.class_rank(header.classification)) THEN RETURN NULL;END IF;
  RETURN inventory;
END $$;
REVOKE ALL ON FUNCTION knowledge.current_artifact_authority_inventory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.current_artifact_authority_inventory(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE POLICY artifact_authority_actual_append ON knowledge.artifact_authority_receipts FOR INSERT TO ensemus_app
  WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()=1 AND app.current_actor_type() IN('agent','service'));
CREATE POLICY artifact_authority_ref_actual_append ON knowledge.artifact_authority_refs FOR INSERT TO ensemus_app
  WITH CHECK(organization_id=app.current_organization_id() AND pg_trigger_depth()=1 AND app.current_actor_type() IN('agent','service'));
GRANT INSERT ON knowledge.artifact_authority_receipts,knowledge.artifact_authority_refs TO ensemus_app;
CREATE FUNCTION knowledge.guard_artifact_authority_append() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE header knowledge.artifact_lineage;receipt knowledge.artifact_authority_receipts;inventory jsonb;current_class text;ref record;
BEGIN
  IF TG_RELID NOT IN('knowledge.artifact_authority_receipts'::regclass,'knowledge.artifact_authority_refs'::regclass) OR TG_OP<>'INSERT'
    OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() OR pg_trigger_depth()<>2 THEN
    RAISE EXCEPTION 'ARTIFACT_AUTHORITY_APPEND_DENIED' USING ERRCODE='42501';END IF;
  IF TG_RELID='knowledge.artifact_authority_receipts'::regclass THEN
    SELECT * INTO header FROM knowledge.artifact_lineage actual WHERE actual.organization_id=NEW.organization_id AND actual.artifact_id=NEW.artifact_id;
    inventory:=knowledge.current_artifact_authority_inventory(NEW.artifact_id);
    IF header.artifact_id IS NULL OR inventory IS NULL OR ROW(NEW.work_unit_id,NEW.run_id,NEW.viewer_membership_id,NEW.protocol_version,
      NEW.write_id,NEW.generation,NEW.artifact_sha256,NEW.classification,NEW.input_inventory,NEW.inventory_sha256)
      IS DISTINCT FROM ROW(header.work_unit_id,CASE WHEN header.execution_kind='agent_run' THEN header.execution_id END,header.viewer_membership_id,
      CASE WHEN header.execution_kind='agent_run' THEN 'authority-v1' ELSE 'system-template-v1' END,
      header.write_id,header.generation,header.artifact_sha256,header.classification,inventory,encode(sha256(convert_to(inventory::text,'UTF8')),'hex')) THEN
      RAISE EXCEPTION 'ARTIFACT_AUTHORITY_INPUT_UNPROVEN' USING ERRCODE='EN119';END IF;
    IF NEW.protocol_version='authority-v1' THEN
      current_class:=ai.lock_frozen_input_refs(inventory,header.viewer_membership_id);
      IF current_class IS NULL OR knowledge.class_rank(current_class)>knowledge.class_rank(header.classification) THEN
        RAISE EXCEPTION 'ARTIFACT_AUTHORITY_INPUT_UNPROVEN' USING ERRCODE='EN119';END IF;
    ELSE
      FOR ref IN SELECT frozen.* FROM ai.delegated_frozen_refs(inventory) frozen LOOP
        IF ref.ref_kind NOT IN('work_unit','project','client') OR NOT knowledge.lock_structured_record(ref.ref_kind,ref.ref_id)
          OR knowledge.structured_record_class(ref.ref_kind,ref.ref_id) IS NULL
          OR knowledge.class_rank(knowledge.structured_record_class(ref.ref_kind,ref.ref_id))>knowledge.class_rank(header.classification) THEN
          RAISE EXCEPTION 'ARTIFACT_TEMPLATE_INPUT_UNPROVEN' USING ERRCODE='EN119';END IF;
      END LOOP;
    END IF;
    NEW.captured_at:=clock_timestamp();
  ELSE
    SELECT * INTO receipt FROM knowledge.artifact_authority_receipts actual WHERE actual.organization_id=NEW.organization_id AND actual.artifact_id=NEW.artifact_id;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM ai.delegated_frozen_refs(receipt.input_inventory) frozen
      WHERE ROW(NEW.proof_key_sha256,NEW.ref_kind,NEW.ref_id,NEW.content_sha256,NEW.classification,NEW.source_id,NEW.document_id,NEW.proof_kind,NEW.fact_package_id)
        IS NOT DISTINCT FROM ROW(frozen.proof_key_sha256,frozen.ref_kind,frozen.ref_id,frozen.content_sha256,frozen.classification,frozen.source_id,frozen.document_id,frozen.proof_kind,frozen.fact_package_id)) THEN
      RAISE EXCEPTION 'ARTIFACT_AUTHORITY_REF_UNPROVEN' USING ERRCODE='EN119';END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_artifact_authority_append() FROM PUBLIC;
CREATE TRIGGER artifact_authority_receipt_append BEFORE INSERT ON knowledge.artifact_authority_receipts FOR EACH ROW EXECUTE FUNCTION knowledge.guard_artifact_authority_append();
CREATE TRIGGER artifact_authority_ref_append BEFORE INSERT ON knowledge.artifact_authority_refs FOR EACH ROW EXECUTE FUNCTION knowledge.guard_artifact_authority_append();
CREATE FUNCTION knowledge.capture_artifact_authority_birth() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE inventory jsonb;
BEGIN
  IF TG_RELID<>'knowledge.artifact_lineage'::regclass OR TG_OP<>'INSERT' OR NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'ARTIFACT_AUTHORITY_BIRTH_TARGET' USING ERRCODE='42501';END IF;
  IF NEW.execution_kind='manual' THEN RETURN NEW;END IF;
  inventory:=knowledge.current_artifact_authority_inventory(NEW.artifact_id);
  IF inventory IS NULL THEN RAISE EXCEPTION 'ARTIFACT_AUTHORITY_INPUT_UNPROVEN' USING ERRCODE='EN119';END IF;
  INSERT INTO knowledge.artifact_authority_receipts(organization_id,artifact_id,work_unit_id,run_id,viewer_membership_id,protocol_version,
    write_id,generation,artifact_sha256,classification,input_inventory,inventory_sha256)
  VALUES(NEW.organization_id,NEW.artifact_id,NEW.work_unit_id,CASE WHEN NEW.execution_kind='agent_run' THEN NEW.execution_id END,
    NEW.viewer_membership_id,CASE WHEN NEW.execution_kind='agent_run' THEN 'authority-v1' ELSE 'system-template-v1' END,
    NEW.write_id,NEW.generation,NEW.artifact_sha256,NEW.classification,inventory,encode(sha256(convert_to(inventory::text,'UTF8')),'hex'));
  INSERT INTO knowledge.artifact_authority_refs(organization_id,artifact_id,proof_key_sha256,ref_kind,ref_id,content_sha256,classification,source_id,document_id,proof_kind,fact_package_id)
    SELECT NEW.organization_id,NEW.artifact_id,frozen.* FROM ai.delegated_frozen_refs(inventory) frozen;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.capture_artifact_authority_birth() FROM PUBLIC;
CREATE TRIGGER zz_artifact_authority_actual_birth AFTER INSERT ON knowledge.artifact_lineage FOR EACH ROW EXECUTE FUNCTION knowledge.capture_artifact_authority_birth();
CREATE FUNCTION knowledge.artifact_authority_complete(p_artifact uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM knowledge.artifact_authority_receipts receipt JOIN knowledge.artifact_lineage header
    ON header.organization_id=receipt.organization_id AND header.artifact_id=receipt.artifact_id
    WHERE receipt.organization_id=app.current_organization_id() AND receipt.artifact_id=p_artifact
      AND ROW(receipt.work_unit_id,receipt.run_id,receipt.viewer_membership_id,receipt.write_id,receipt.generation,receipt.artifact_sha256,receipt.classification)
        IS NOT DISTINCT FROM ROW(header.work_unit_id,CASE WHEN header.execution_kind='agent_run' THEN header.execution_id END,header.viewer_membership_id,
          header.write_id,header.generation,header.artifact_sha256,header.classification)
      AND((header.execution_kind='agent_run' AND receipt.protocol_version='authority-v1') OR(header.execution_kind='system' AND receipt.protocol_version='system-template-v1'))
      AND receipt.inventory_sha256=encode(sha256(convert_to(receipt.input_inventory::text,'UTF8')),'hex')
      AND NOT EXISTS(SELECT proof_key_sha256,ref_kind,ref_id,content_sha256,classification,source_id,document_id,proof_kind,fact_package_id FROM ai.delegated_frozen_refs(receipt.input_inventory)
        EXCEPT SELECT ref.proof_key_sha256,ref.ref_kind,ref.ref_id,ref.content_sha256,ref.classification,ref.source_id,ref.document_id,ref.proof_kind,ref.fact_package_id
          FROM knowledge.artifact_authority_refs ref WHERE ref.organization_id=receipt.organization_id AND ref.artifact_id=receipt.artifact_id)
      AND NOT EXISTS(SELECT ref.proof_key_sha256,ref.ref_kind,ref.ref_id,ref.content_sha256,ref.classification,ref.source_id,ref.document_id,ref.proof_kind,ref.fact_package_id
          FROM knowledge.artifact_authority_refs ref WHERE ref.organization_id=receipt.organization_id AND ref.artifact_id=receipt.artifact_id
        EXCEPT SELECT proof_key_sha256,ref_kind,ref_id,content_sha256,classification,source_id,document_id,proof_kind,fact_package_id FROM ai.delegated_frozen_refs(receipt.input_inventory))),false)
$$;
REVOKE ALL ON FUNCTION knowledge.artifact_authority_complete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.artifact_authority_complete(uuid) TO ensemus_app;
CREATE FUNCTION knowledge.require_artifact_authority_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'knowledge.artifact_lineage'::regclass OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ARTIFACT_AUTHORITY_COMPLETENESS_TARGET' USING ERRCODE='42501';END IF;
  IF NEW.execution_kind IN('agent_run','system') AND NOT knowledge.artifact_authority_complete(NEW.artifact_id) THEN
    RAISE EXCEPTION 'ARTIFACT_AUTHORITY_INCOMPLETE' USING ERRCODE='EN119';END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.require_artifact_authority_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER artifact_authority_complete_at_birth AFTER INSERT ON knowledge.artifact_lineage DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION knowledge.require_artifact_authority_complete();
--> statement-breakpoint
-- Internal exact-row metadata seam: selecting facts as the caller would invoke subject Work body
-- RLS and recurse into this same retained-input closure. No claim or new caller table grant.
CREATE POLICY fact_authority_exact_metadata ON knowledge.facts FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id()
    AND organization_id=nullif(current_setting('knowledge.fact_authority_org',true),'')::uuid
    AND id=nullif(current_setting('knowledge.fact_authority_fact',true),'')::uuid);
CREATE POLICY fact_receipt_authority_exact_metadata ON knowledge.evidence_package_facts FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id()
    AND organization_id=nullif(current_setting('knowledge.fact_authority_org',true),'')::uuid
    AND fact_id=nullif(current_setting('knowledge.fact_authority_fact',true),'')::uuid
    AND package_id=nullif(current_setting('knowledge.fact_authority_package',true),'')::uuid);
CREATE FUNCTION knowledge.fact_authority_metadata(p_fact uuid)
RETURNS TABLE(id uuid,subject_ref text,classification text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_org text:=current_setting('knowledge.fact_authority_org',true);previous_fact text:=current_setting('knowledge.fact_authority_fact',true);
BEGIN
  IF current_user<>'ensemus_migrator' OR app.current_organization_id() IS NULL OR p_fact IS NULL THEN
    RAISE EXCEPTION 'FACT_AUTHORITY_METADATA_TARGET' USING ERRCODE='42501';END IF;
  BEGIN
    PERFORM set_config('knowledge.fact_authority_org',app.current_organization_id()::text,true);
    PERFORM set_config('knowledge.fact_authority_fact',p_fact::text,true);
    RETURN QUERY SELECT fact.id,fact.subject_ref,fact.classification FROM knowledge.facts fact
      WHERE fact.organization_id=app.current_organization_id() AND fact.id=p_fact;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('knowledge.fact_authority_org',coalesce(previous_org,''),true);
    PERFORM set_config('knowledge.fact_authority_fact',coalesce(previous_fact,''),true);
    RAISE;
  END;
  PERFORM set_config('knowledge.fact_authority_org',coalesce(previous_org,''),true);
  PERFORM set_config('knowledge.fact_authority_fact',coalesce(previous_fact,''),true);
END $$;
REVOKE ALL ON FUNCTION knowledge.fact_authority_metadata(uuid) FROM PUBLIC;
-- Intentionally NO app/agent/dispatcher EXECUTE. Only this fixed definer boolean can call the
-- getter as its owner; the named viewer and original source/subject ACL stay with the closure.
CREATE FUNCTION knowledge.fact_authority_receipt_live(p_package uuid,p_fact uuid,p_claim_hash text,p_protection text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_org text:=current_setting('knowledge.fact_authority_org',true);
  previous_fact text:=current_setting('knowledge.fact_authority_fact',true);
  previous_package text:=current_setting('knowledge.fact_authority_package',true);
  receipt knowledge.evidence_package_facts;live_fact record;matches boolean:=false;
BEGIN
  IF current_user<>'ensemus_migrator' OR app.current_organization_id() IS NULL OR p_package IS NULL OR p_fact IS NULL THEN RETURN false;END IF;
  BEGIN
    PERFORM set_config('knowledge.fact_authority_org',app.current_organization_id()::text,true);
    PERFORM set_config('knowledge.fact_authority_fact',p_fact::text,true);
    PERFORM set_config('knowledge.fact_authority_package',p_package::text,true);
    IF p_claim_hash IS NULL OR p_claim_hash !~ '^[0-9a-f]{64}$' OR p_protection IS NULL OR p_protection NOT IN('public','internal','confidential','restricted') THEN
      RAISE EXCEPTION 'FACT_AUTHORITY_RECEIPT_TARGET' USING ERRCODE='42501';END IF;
    SELECT * INTO receipt FROM knowledge.evidence_package_facts actual WHERE actual.organization_id=app.current_organization_id()
      AND actual.package_id=p_package AND actual.fact_id=p_fact AND actual.content_sha256=p_claim_hash AND actual.subject_ref IS NOT NULL;
    IF FOUND THEN
      SELECT * INTO live_fact FROM knowledge.fact_authority_metadata(p_fact);
      matches:=FOUND AND live_fact.id=p_fact AND live_fact.subject_ref=receipt.subject_ref
        AND knowledge.class_rank(live_fact.classification)<=knowledge.class_rank(p_protection)
        AND knowledge.class_rank(receipt.classification)<=knowledge.class_rank(p_protection);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('knowledge.fact_authority_org',coalesce(previous_org,''),true);
    PERFORM set_config('knowledge.fact_authority_fact',coalesce(previous_fact,''),true);
    PERFORM set_config('knowledge.fact_authority_package',coalesce(previous_package,''),true);
    RAISE;
  END;
  PERFORM set_config('knowledge.fact_authority_org',coalesce(previous_org,''),true);
  PERFORM set_config('knowledge.fact_authority_fact',coalesce(previous_fact,''),true);
  PERFORM set_config('knowledge.fact_authority_package',coalesce(previous_package,''),true);
  RETURN coalesce(matches,false);
END $$;
REVOKE ALL ON FUNCTION knowledge.fact_authority_receipt_live(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.fact_authority_receipt_live(uuid,uuid,text,text) TO ensemus_app;
--> statement-breakpoint
-- Internal own-Work permission without recursing into inherited bodies. The public predicate adds
-- the full graph below. Ordinary Work keeps 0411's exact owner/admin/assignment + parent rules;
-- a derived Work's independent birth protection cannot be weakened by lowering its raw label.
CREATE FUNCTION knowledge.work_own_scope_readable_0419(p_work uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog own JOIN org.memberships viewer
    ON viewer.organization_id=own.organization_id AND viewer.id=p_viewer AND viewer.status='active'
    CROSS JOIN LATERAL(SELECT greatest(knowledge.class_rank(own.classification),coalesce((SELECT max(knowledge.class_rank(receipt.classification))
      FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=own.organization_id AND receipt.child_work_unit_id=own.record_id),0)) own_rank) protection
    WHERE own.organization_id=app.current_organization_id() AND own.record_kind='work_unit' AND own.record_id=p_work AND own.alive
      AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=own.organization_id AND tomb.target_type='work_unit' AND tomb.target_id=own.record_id)
      AND(protection.own_rank<=1 OR own.owner_membership_id=p_viewer OR(protection.own_rank=2 AND viewer.role IN('owner','admin'))
        OR EXISTS(SELECT 1 FROM knowledge.structured_work_assignments assignment WHERE assignment.organization_id=own.organization_id
          AND assignment.work_unit_id=own.record_id AND assignment.membership_id=p_viewer))
      AND(own.parent_record_id IS NULL OR knowledge.structured_record_readable('project',own.parent_record_id,p_viewer)))
$$;
REVOKE ALL ON FUNCTION knowledge.work_own_scope_readable_0419(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.work_own_scope_readable_0419(uuid,uuid) TO ensemus_app;
-- This material floor is separate from own-record ACL: a private current parent still uses its
-- actual named-reader rules, while copied Work material retains its independently pinned birth
-- protection after a raw-label lowering. Missing/dead Work never becomes a class-only permission.
CREATE FUNCTION knowledge.work_material_class_0419(p_work uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN current_class.classification IS NULL THEN NULL ELSE CASE greatest(knowledge.class_rank(current_class.classification),
    coalesce((SELECT max(knowledge.class_rank(receipt.classification)) FROM ai.delegated_input_receipts receipt
      WHERE receipt.organization_id=app.current_organization_id() AND receipt.child_work_unit_id=p_work),0))
    WHEN 3 THEN 'restricted' WHEN 2 THEN 'confidential' WHEN 1 THEN 'internal' ELSE 'public' END END
  FROM(SELECT knowledge.work_scope_class(p_work) classification) current_class
$$;
REVOKE ALL ON FUNCTION knowledge.work_material_class_0419(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.work_material_class_0419(uuid) TO ensemus_app;
CREATE FUNCTION knowledge.retained_scope_node(p_kind text,p_id uuid,p_hash text,p_historical_class text,p_source uuid,p_document uuid,p_package uuid,p_cap integer)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('kind',p_kind,'id',p_id,'sha256',p_hash,'historicalClass',p_historical_class,
    'sourceId',p_source,'documentId',p_document,'packageId',p_package,'cap',p_cap)
$$;
REVOKE ALL ON FUNCTION knowledge.retained_scope_node(text,uuid,text,text,uuid,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.retained_scope_node(text,uuid,text,text,uuid,uuid,uuid,integer) TO ensemus_app;

-- Least fixed point over a bounded AND/OR graph. A file needs one genuinely readable Work link,
-- while every actual frozen input is required. Cycles do not authorize themselves. Fixed 1000-bit
-- masks bound memory even for flattened ancestor DAGs; no recursive body-RLS or mutable GUC memo.
CREATE FUNCTION knowledge.retained_input_scope_readable(p_inventory jsonb,p_viewer uuid,p_protection text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE zero_mask bit(1000):=repeat('0',1000)::bit(1000);roots bit(1000):=repeat('0',1000)::bit(1000);
  base_mask bit(1000):=repeat('0',1000)::bit(1000);solution bit(1000):=repeat('0',1000)::bit(1000);
  alternative_required bit(1000):=repeat('0',1000)::bit(1000);
  and_masks bit(1000)[]:=ARRAY[]::bit(1000)[];or_masks bit(1000)[]:=ARRAY[]::bit(1000)[];
  nodes jsonb:='[]'::jsonb;positions jsonb:='{}'::jsonb;children jsonb;entry jsonb;node jsonb;child jsonb;seed record;
  node_key text;child_key text;position integer;child_position integer;node_count integer:=0;cursor_position integer:=0;
  kind text;target uuid;expected_hash text;historical_class text;cap integer;live_class text;allowed boolean;changed boolean;
  node_source_id uuid;node_document_id uuid;node_package_id uuid;viewer_role text;catalog knowledge.artifact_acl_catalog;
  header knowledge.artifact_lineage;receipt ai.delegated_input_receipts;fact_receipt knowledge.evidence_package_facts;
  record_ref record;link record;links_seen integer;loop_number integer;body_protection integer;edges_seen integer;
BEGIN
  IF p_viewer IS NULL OR p_protection IS NULL OR p_protection NOT IN('public','internal','confidential','restricted') THEN RETURN false;END IF;
  SELECT viewer.role INTO viewer_role FROM org.memberships viewer WHERE viewer.organization_id=app.current_organization_id() AND viewer.id=p_viewer AND viewer.status='active';
  IF NOT FOUND THEN RETURN false;END IF;
  FOR seed IN SELECT ref.* FROM ai.delegated_frozen_refs(p_inventory) ref LOOP
    entry:=knowledge.retained_scope_node(seed.ref_kind,seed.ref_id,seed.content_sha256,seed.classification,seed.source_id,seed.document_id,seed.fact_package_id,knowledge.class_rank(p_protection));
    node_key:=encode(sha256(convert_to(entry::text,'UTF8')),'hex');
    IF NOT(positions?node_key) THEN
      IF node_count>=1000 THEN RETURN false;END IF;
      positions:=jsonb_set(positions,ARRAY[node_key],to_jsonb(node_count));nodes:=nodes||jsonb_build_array(entry);
      and_masks:=array_append(and_masks,zero_mask);or_masks:=array_append(or_masks,zero_mask);node_count:=node_count+1;
    END IF;
    roots:=set_bit(roots,(positions->>node_key)::integer,1);
  END LOOP;
  IF node_count=0 THEN RETURN false;END IF;
  WHILE cursor_position<node_count LOOP
    position:=cursor_position;cursor_position:=cursor_position+1;node:=nodes->position;
    kind:=node->>'kind';target:=(node->>'id')::uuid;expected_hash:=node->>'sha256';historical_class:=node->>'historicalClass';
    node_source_id:=(node->>'sourceId')::uuid;node_document_id:=(node->>'documentId')::uuid;node_package_id:=(node->>'packageId')::uuid;cap:=(node->>'cap')::integer;
    allowed:=cap BETWEEN 0 AND 3 AND(historical_class IS NULL OR knowledge.class_rank(historical_class)<=cap);children:='[]'::jsonb;
    IF kind='work_unit' THEN
      live_class:=knowledge.work_material_class_0419(target);
      allowed:=allowed AND live_class IS NOT NULL AND knowledge.class_rank(live_class)<=cap AND knowledge.work_own_scope_readable_0419(target,p_viewer)
        AND NOT EXISTS(SELECT 1 FROM ai.unproven_child_work_inputs unknown_input WHERE unknown_input.organization_id=app.current_organization_id() AND unknown_input.work_unit_id=target)
        AND NOT EXISTS(SELECT 1 FROM ai.agent_runs child_run WHERE child_run.organization_id=app.current_organization_id() AND child_run.work_unit_id=target AND child_run.parent_run_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM ai.delegated_input_receipts actual WHERE actual.organization_id=child_run.organization_id AND actual.child_run_id=child_run.id))
        AND NOT EXISTS(SELECT 1 FROM ai.delegated_work_births witness WHERE witness.organization_id=app.current_organization_id() AND witness.work_unit_id=target
          AND NOT EXISTS(SELECT 1 FROM ai.delegated_input_receipts actual WHERE actual.organization_id=witness.organization_id AND actual.child_run_id=witness.child_run_id));
      IF allowed THEN
        body_protection:=least(cap,knowledge.class_rank(live_class));
        FOR receipt IN SELECT actual.* FROM ai.delegated_input_receipts actual WHERE actual.organization_id=app.current_organization_id() AND actual.child_work_unit_id=target LOOP
          IF receipt.redacted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ai.delegated_work_births witness WHERE witness.organization_id=receipt.organization_id
            AND ROW(witness.work_unit_id,witness.child_run_id,witness.parent_run_id,witness.proposal_id,witness.snapshot_id,witness.birth_content_sha256,witness.classification)
              =ROW(receipt.child_work_unit_id,receipt.child_run_id,receipt.parent_run_id,receipt.proposal_id,receipt.snapshot_id,receipt.birth_content_sha256,receipt.classification)) THEN allowed:=false;EXIT;END IF;
          FOR record_ref IN SELECT ref.* FROM ai.delegated_input_refs ref WHERE ref.organization_id=receipt.organization_id AND ref.child_run_id=receipt.child_run_id LOOP
            children:=children||jsonb_build_array(jsonb_build_object('alternative',false,'node',knowledge.retained_scope_node(record_ref.ref_kind,record_ref.ref_id,
              record_ref.content_sha256,record_ref.classification,record_ref.source_id,record_ref.document_id,record_ref.fact_package_id,body_protection)));
          END LOOP;
          IF NOT EXISTS(SELECT 1 FROM ai.delegated_input_refs ref WHERE ref.organization_id=receipt.organization_id AND ref.child_run_id=receipt.child_run_id) THEN allowed:=false;EXIT;END IF;
        END LOOP;
      END IF;
    ELSIF kind='artifact' THEN
      SELECT * INTO catalog FROM knowledge.artifact_acl_catalog actual WHERE actual.organization_id=app.current_organization_id() AND actual.artifact_id=target;
      allowed:=allowed AND FOUND AND catalog.alive AND(expected_hash IS NULL OR catalog.sha256=expected_hash)
        AND knowledge.class_rank(catalog.classification)<=cap AND catalog.provenance_state NOT IN('pending','blocked')
        AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=app.current_organization_id() AND tomb.target_type='artifact' AND tomb.target_id=target);
      SELECT * INTO header FROM knowledge.artifact_lineage actual WHERE actual.organization_id=app.current_organization_id() AND actual.artifact_id=target;
      IF FOUND THEN
        allowed:=allowed AND header.inventory_complete AND header.state='bound' AND header.write_state='settled' AND header.physical_purged_at IS NULL
          AND header.artifact_sha256=catalog.sha256;
        IF header.execution_kind IN('agent_run','system') THEN
          allowed:=allowed AND header.structured_inventory_complete AND knowledge.artifact_authority_complete(target);
          IF allowed THEN
          FOR record_ref IN SELECT ref.* FROM knowledge.artifact_authority_refs ref WHERE ref.organization_id=app.current_organization_id() AND ref.artifact_id=target LOOP
            children:=children||jsonb_build_array(jsonb_build_object('alternative',false,'node',knowledge.retained_scope_node(record_ref.ref_kind,record_ref.ref_id,
              record_ref.content_sha256,record_ref.classification,record_ref.source_id,record_ref.document_id,record_ref.fact_package_id,least(cap,knowledge.class_rank(catalog.classification)))));
          END LOOP;
          END IF;
        ELSIF header.execution_kind<>'manual' THEN allowed:=false;END IF;
      ELSIF catalog.provenance_state='bound' THEN allowed:=false;END IF;
      IF catalog.classification IN('confidential','restricted') THEN
        allowed:=allowed AND((catalog.classification='confidential' AND viewer_role IN('owner','admin')) OR EXISTS(
          SELECT 1 FROM knowledge.artifact_work_links linked JOIN knowledge.structured_record_catalog work_meta
            ON work_meta.organization_id=linked.organization_id AND work_meta.record_kind='work_unit' AND work_meta.record_id=linked.work_unit_id AND work_meta.alive
          WHERE linked.organization_id=app.current_organization_id() AND linked.artifact_id=target AND(work_meta.owner_membership_id=p_viewer
            OR EXISTS(SELECT 1 FROM knowledge.structured_work_assignments assignment WHERE assignment.organization_id=work_meta.organization_id
              AND assignment.work_unit_id=work_meta.record_id AND assignment.membership_id=p_viewer))));
      END IF;
      IF allowed THEN
      alternative_required:=set_bit(alternative_required,position,1);links_seen:=0;
      FOR link IN SELECT linked.work_unit_id FROM knowledge.artifact_work_links linked WHERE linked.organization_id=app.current_organization_id() AND linked.artifact_id=target
        ORDER BY linked.work_unit_id LIMIT 1001 LOOP
        links_seen:=links_seen+1;IF links_seen>1000 THEN RETURN false;END IF;
        live_class:=knowledge.work_material_class_0419(link.work_unit_id);
        IF live_class IS NOT NULL THEN children:=children||jsonb_build_array(jsonb_build_object('alternative',true,
          'node',knowledge.retained_scope_node('work_unit',link.work_unit_id,NULL,NULL,NULL,NULL,NULL,knowledge.class_rank(live_class))));END IF;
      END LOOP;
      body_protection:=least(cap,knowledge.class_rank(catalog.classification));
      FOR record_ref IN SELECT input.input_artifact_id id,input.input_sha256 hash FROM knowledge.artifact_lineage_inputs input
        WHERE input.organization_id=app.current_organization_id() AND input.artifact_id=target LOOP
        children:=children||jsonb_build_array(jsonb_build_object('alternative',false,'node',knowledge.retained_scope_node('artifact',record_ref.id,record_ref.hash,NULL,NULL,NULL,NULL,body_protection)));
      END LOOP;
      FOR record_ref IN SELECT record.* FROM knowledge.artifact_required_records(target) record LOOP
        children:=children||jsonb_build_array(jsonb_build_object('alternative',false,'node',knowledge.retained_scope_node(record_ref.record_kind,record_ref.record_id,
          record_ref.record_sha256,record_ref.classification,NULL,NULL,NULL,body_protection)));
      END LOOP;
      FOR record_ref IN SELECT knowledge.artifact_required_sources(target) id LOOP
        children:=children||jsonb_build_array(jsonb_build_object('alternative',false,'node',knowledge.retained_scope_node('source',record_ref.id,NULL,NULL,record_ref.id,NULL,NULL,body_protection)));
      END LOOP;
      END IF;
    ELSIF kind='fact' THEN
      SELECT * INTO fact_receipt FROM knowledge.evidence_package_facts actual WHERE actual.organization_id=app.current_organization_id()
        AND actual.package_id=node_package_id AND actual.fact_id=target AND actual.content_sha256=expected_hash AND actual.subject_ref IS NOT NULL;
      allowed:=allowed AND FOUND AND knowledge.fact_authority_receipt_live(node_package_id,target,expected_hash,CASE cap WHEN 3 THEN 'restricted' WHEN 2 THEN 'confidential' WHEN 1 THEN 'internal' ELSE 'public' END);
      IF allowed THEN
        IF split_part(fact_receipt.subject_ref,':',1) IN('work_unit','project','client') THEN
          children:=children||jsonb_build_array(jsonb_build_object('alternative',false,'node',knowledge.retained_scope_node(split_part(fact_receipt.subject_ref,':',1),
            split_part(fact_receipt.subject_ref,':',2)::uuid,NULL,NULL,NULL,NULL,NULL,cap)));
        ELSIF split_part(fact_receipt.subject_ref,':',1)='knowledge_source' THEN
          children:=children||jsonb_build_array(jsonb_build_object('alternative',false,'node',knowledge.retained_scope_node('source',split_part(fact_receipt.subject_ref,':',2)::uuid,
            NULL,NULL,split_part(fact_receipt.subject_ref,':',2)::uuid,NULL,NULL,cap)));
        ELSIF split_part(fact_receipt.subject_ref,':',1)='membership' THEN
          allowed:=EXISTS(SELECT 1 FROM org.memberships subject_member WHERE subject_member.organization_id=app.current_organization_id() AND subject_member.id=split_part(fact_receipt.subject_ref,':',2)::uuid);
        ELSIF split_part(fact_receipt.subject_ref,':',1)='team' THEN
          allowed:=EXISTS(SELECT 1 FROM org.teams subject_team WHERE subject_team.organization_id=app.current_organization_id() AND subject_team.id=split_part(fact_receipt.subject_ref,':',2)::uuid);
        ELSE allowed:=false;END IF;
        edges_seen:=0;
        FOR record_ref IN SELECT item.* FROM knowledge.evidence_items item WHERE item.organization_id=app.current_organization_id() AND item.package_id=node_package_id ORDER BY item.ordinal LIMIT 1001 LOOP
          edges_seen:=edges_seen+1;IF edges_seen>1000 THEN RETURN false;END IF;
          children:=children||jsonb_build_array(jsonb_build_object('alternative',false,'node',knowledge.retained_scope_node('chunk',record_ref.chunk_id,record_ref.content_sha256,
            record_ref.classification,record_ref.source_id,record_ref.document_id,NULL,cap)));
        END LOOP;
        IF NOT EXISTS(SELECT 1 FROM knowledge.evidence_items item WHERE item.organization_id=app.current_organization_id() AND item.package_id=node_package_id) THEN allowed:=false;END IF;
      END IF;
    ELSE
      live_class:=ai.frozen_ref_current_class(kind,target,expected_hash,node_source_id,node_document_id,p_viewer);
      allowed:=allowed AND live_class IS NOT NULL AND knowledge.class_rank(live_class)<=cap;
    END IF;
    IF allowed THEN base_mask:=set_bit(base_mask,position,1);END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(children) LOOP
      child:=entry->'node';child_key:=encode(sha256(convert_to(child::text,'UTF8')),'hex');
      IF NOT(positions?child_key) THEN
        IF node_count>=1000 THEN RETURN false;END IF;
        positions:=jsonb_set(positions,ARRAY[child_key],to_jsonb(node_count));nodes:=nodes||jsonb_build_array(child);
        and_masks:=array_append(and_masks,zero_mask);or_masks:=array_append(or_masks,zero_mask);node_count:=node_count+1;
      END IF;
      child_position:=(positions->>child_key)::integer;
      IF(entry->>'alternative')::boolean THEN or_masks[position+1]:=set_bit(or_masks[position+1],child_position,1);
      ELSE and_masks[position+1]:=set_bit(and_masks[position+1],child_position,1);END IF;
    END LOOP;
  END LOOP;
  FOR loop_number IN 1..node_count LOOP
    changed:=false;
    FOR position IN 0..node_count-1 LOOP
      IF get_bit(solution,position)=0 AND get_bit(base_mask,position)=1 AND(and_masks[position+1]&solution)=and_masks[position+1]
        AND(get_bit(alternative_required,position)=0 OR(or_masks[position+1]&solution)<>zero_mask) THEN
        solution:=set_bit(solution,position,1);changed:=true;
      END IF;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;
  RETURN(roots&solution)=roots;
EXCEPTION WHEN SQLSTATE 'EN119' THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION knowledge.retained_input_scope_readable(jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.retained_input_scope_readable(jsonb,uuid,text) TO ensemus_app;
--> statement-breakpoint
-- Fixed entry points always build the complete graph from retained actual proof. Callers cannot
-- submit a success flag, visited map, alternative Work or shorter input list for body serving.
CREATE OR REPLACE FUNCTION ai.delegated_receipt_readable(p_child uuid,p_viewer uuid,p_protection text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=app.current_organization_id()
    AND receipt.child_run_id=p_child AND receipt.redacted_at IS NULL AND knowledge.class_rank(receipt.classification)<=knowledge.class_rank(p_protection)
    AND EXISTS(SELECT 1 FROM ai.delegated_work_births witness WHERE witness.organization_id=receipt.organization_id
      AND ROW(witness.work_unit_id,witness.child_run_id,witness.parent_run_id,witness.proposal_id,witness.snapshot_id,witness.birth_content_sha256,witness.classification)
        =ROW(receipt.child_work_unit_id,receipt.child_run_id,receipt.parent_run_id,receipt.proposal_id,receipt.snapshot_id,receipt.birth_content_sha256,receipt.classification))
    AND knowledge.retained_input_scope_readable(receipt.input_inventory,p_viewer,p_protection)),false)
$$;
CREATE OR REPLACE FUNCTION knowledge.work_scope_readable(p_work uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT knowledge.work_own_scope_readable_0419(p_work,p_viewer) AND knowledge.inherited_work_inputs_readable(p_work,p_viewer)
$$;
CREATE OR REPLACE FUNCTION knowledge.artifact_readable(p_artifact uuid,p_viewer uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE catalog knowledge.artifact_acl_catalog;
BEGIN
  SELECT * INTO catalog FROM knowledge.artifact_acl_catalog actual WHERE actual.organization_id=app.current_organization_id() AND actual.artifact_id=p_artifact AND actual.alive;
  IF NOT FOUND THEN RETURN false;END IF;
  IF p_viewer IS NULL THEN
    -- Preserve only the existing ordinary human-file service ACL. Generated bytes always need a
    -- named viewer; M2 review/hash uses the separate exact control metadata projection.
    RETURN knowledge.is_service_actor() AND catalog.provenance_state='ordinary' AND catalog.classification IN('public','internal')
      AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_lineage header WHERE header.organization_id=catalog.organization_id AND header.artifact_id=catalog.artifact_id)
      AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_required_sources(p_artifact))
      AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=catalog.organization_id AND tomb.target_type='artifact' AND tomb.target_id=catalog.artifact_id)
      AND EXISTS(SELECT 1 FROM knowledge.artifact_work_links linked WHERE linked.organization_id=catalog.organization_id AND linked.artifact_id=catalog.artifact_id);
  END IF;
  RETURN knowledge.retained_input_scope_readable(jsonb_build_array(jsonb_build_object('kind','artifact','id',p_artifact,'sha256',catalog.sha256,
    'classification',catalog.classification)),p_viewer,catalog.classification);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION knowledge.artifact_required_sources(p_artifact uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  WITH nodes AS(SELECT p_artifact id UNION SELECT input.input_artifact_id FROM knowledge.artifact_lineage_inputs input
    WHERE input.organization_id=app.current_organization_id() AND input.artifact_id=p_artifact)
  SELECT source.source_id FROM knowledge.artifact_lineage_sources source JOIN nodes node ON node.id=source.artifact_id
    WHERE source.organization_id=app.current_organization_id()
  UNION SELECT item.source_id FROM knowledge.evidence_items item JOIN knowledge.artifact_lineage_packages package
    ON package.organization_id=item.organization_id AND package.package_id=item.package_id JOIN nodes node ON node.id=package.artifact_id
    WHERE item.organization_id=app.current_organization_id()
  UNION SELECT citation.source_id FROM knowledge.artifact_citations citation JOIN nodes node ON node.id=citation.artifact_id
    WHERE citation.organization_id=app.current_organization_id()
  UNION SELECT ref.source_id FROM knowledge.artifact_authority_refs ref JOIN nodes node ON node.id=ref.artifact_id
    WHERE ref.organization_id=app.current_organization_id() AND ref.source_id IS NOT NULL
  UNION SELECT ref.ref_id FROM knowledge.artifact_authority_refs ref JOIN nodes node ON node.id=ref.artifact_id
    WHERE ref.organization_id=app.current_organization_id() AND ref.ref_kind='source'
$$;
--> statement-breakpoint
-- M2 consumes review IDs/hash, never generated object bytes. Only a native keyless app-service
-- control call for the exact held Work/run/requester/version can inspect these candidate IDs.
CREATE POLICY held_review_control_work_read ON work.work_units FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND organization_id=nullif(current_setting('work.review_control_org',true),'')::uuid
    AND id=nullif(current_setting('work.review_control_work',true),'')::uuid AND app.current_actor_type()='service' AND session_user='ensemus_app');
CREATE POLICY held_review_control_work_lock ON work.work_units FOR UPDATE TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND organization_id=nullif(current_setting('work.review_control_org',true),'')::uuid
    AND id=nullif(current_setting('work.review_control_work',true),'')::uuid AND app.current_actor_type()='service' AND session_user='ensemus_app') WITH CHECK(false);
CREATE POLICY held_review_control_approval_read ON work.approvals FOR SELECT TO ensemus_migrator
  USING(organization_id=app.current_organization_id() AND organization_id=nullif(current_setting('work.review_control_org',true),'')::uuid
    AND work_unit_id=nullif(current_setting('work.review_control_work',true),'')::uuid AND app.current_actor_type()='service' AND session_user='ensemus_app');
CREATE FUNCTION work.held_review_artifact_ids(p_work uuid,p_version bigint,p_run text,p_requester uuid)
RETURNS TABLE(id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_org text:=current_setting('work.review_control_org',true);previous_work text:=current_setting('work.review_control_work',true);
  actual record;review_runs bigint;
BEGIN
  IF current_user<>'ensemus_migrator' OR session_user<>'ensemus_app' OR app.current_actor_type() IS DISTINCT FROM 'service'
    OR app.current_organization_id() IS NULL OR p_work IS NULL OR p_requester IS NULL OR p_version IS NULL THEN
    RAISE EXCEPTION 'HELD_REVIEW_CONTROL_TARGET' USING ERRCODE='42501';END IF;
  BEGIN
    PERFORM set_config('work.review_control_org',app.current_organization_id()::text,true);
    PERFORM set_config('work.review_control_work',p_work::text,true);
    SELECT work.id,work.version,work.status,work.run_id,work.run_requested_by_membership_id,work.execution_plan INTO actual
      FROM work.work_units work WHERE work.organization_id=app.current_organization_id() AND work.id=p_work FOR SHARE NOWAIT;
    IF NOT FOUND OR actual.version<>p_version OR actual.execution_plan IS DISTINCT FROM 'checklist'
      OR actual.run_requested_by_membership_id IS DISTINCT FROM p_requester THEN
      RAISE EXCEPTION 'HELD_REVIEW_CONTROL_STALE' USING ERRCODE='42501';END IF;
    IF actual.status IN('running','awaiting_approval') THEN
      IF p_run IS NULL OR actual.run_id IS DISTINCT FROM p_run THEN RAISE EXCEPTION 'HELD_REVIEW_CONTROL_STALE' USING ERRCODE='42501';END IF;
    ELSIF actual.status='verifying' AND actual.run_id IS NULL AND p_run IS NULL THEN
      -- The shared kernel releases run_id before checking stale reviews. Only its actual retained
      -- current M2 review may carry that released control identity; never guess by time/order.
      SELECT count(DISTINCT approval.run_id) INTO review_runs FROM work.approvals approval WHERE approval.organization_id=app.current_organization_id()
        AND approval.work_unit_id=p_work AND approval.tool_name='work.review' AND approval.status IN('pending','approved')
        AND approval.requested_by_membership_id=p_requester AND approval.run_id IS NOT NULL;
      IF review_runs<>1 THEN RAISE EXCEPTION 'HELD_REVIEW_CONTROL_STALE' USING ERRCODE='42501';END IF;
    ELSE RAISE EXCEPTION 'HELD_REVIEW_CONTROL_STALE' USING ERRCODE='42501';END IF;
    RETURN QUERY SELECT catalog.artifact_id FROM knowledge.artifact_work_links linked JOIN knowledge.artifact_acl_catalog catalog
      ON catalog.organization_id=linked.organization_id AND catalog.artifact_id=linked.artifact_id
      WHERE linked.organization_id=app.current_organization_id() AND linked.work_unit_id=p_work AND catalog.alive
      ORDER BY catalog.artifact_id LIMIT 1001;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('work.review_control_org',coalesce(previous_org,''),true);
    PERFORM set_config('work.review_control_work',coalesce(previous_work,''),true);
    RAISE;
  END;
  PERFORM set_config('work.review_control_org',coalesce(previous_org,''),true);
  PERFORM set_config('work.review_control_work',coalesce(previous_work,''),true);
END $$;
REVOKE ALL ON FUNCTION work.held_review_artifact_ids(uuid,bigint,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION work.held_review_artifact_ids(uuid,bigint,text,uuid) TO ensemus_app;
