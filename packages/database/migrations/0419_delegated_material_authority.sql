-- Real delegated title/file sinks. Source in progress; not registered or enabled independently.
-- Requires0417 plus0416's actual pre-network/paid-result/proposal identity. Existing quarantines
-- remain closed; nullable old transform fields are not a historical repair or completeness claim.
ALTER TABLE ai.model_proposal_inputs ADD COLUMN transform_version text;
ALTER TABLE ai.model_proposal_inputs ADD COLUMN derived_body_sha256 text;
ALTER TABLE ai.model_proposal_inputs ADD CONSTRAINT model_proposal_inputs_title_transform CHECK(
  (transform_version IS NULL AND derived_body_sha256 IS NULL) OR
  (transform_version IS NOT NULL AND transform_version='work-title-v1'
    AND derived_body_sha256 IS NOT NULL AND derived_body_sha256 ~ '^[0-9a-f]{64}$'));
--> statement-breakpoint
CREATE TABLE ai.delegated_input_receipts (
  organization_id uuid NOT NULL,child_run_id uuid NOT NULL,parent_run_id uuid NOT NULL,child_work_unit_id uuid NOT NULL,
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
  CONSTRAINT delegated_input_receipts_work_fk FOREIGN KEY(organization_id,child_work_unit_id) REFERENCES work.work_units(organization_id,id),
  CONSTRAINT delegated_input_receipts_proposal_fk FOREIGN KEY(organization_id,proposal_id) REFERENCES ai.tool_proposals(organization_id,id),
  CONSTRAINT delegated_input_receipts_snapshot_fk FOREIGN KEY(organization_id,snapshot_id) REFERENCES ai.main_input_snapshots(organization_id,id),
  CONSTRAINT delegated_input_receipts_step_fk FOREIGN KEY(organization_id,original_step_id) REFERENCES ai.execution_steps(organization_id,id),
  CONSTRAINT delegated_input_receipts_identity CHECK(child_run_id<>parent_run_id AND original_attempt>0 AND tool_step_number>0),
  CONSTRAINT delegated_input_receipts_hashes CHECK(request_sha256 ~ '^[0-9a-f]{64}$' AND proposal_payload_sha256 ~ '^[0-9a-f]{64}$' AND birth_content_sha256 ~ '^[0-9a-f]{64}$' AND inventory_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT delegated_input_receipts_inventory CHECK(jsonb_typeof(input_inventory)='array' AND jsonb_array_length(input_inventory) BETWEEN 1 AND 1000 AND octet_length(input_inventory::text)<=1048576),
  CONSTRAINT delegated_input_receipts_class CHECK(classification IN('public','internal','confidential','restricted')),
  CONSTRAINT delegated_input_receipts_disposition CHECK((redacted_at IS NULL AND redacted_version IS NULL AND disposition_sha256 IS NULL)
    OR(redacted_at IS NOT NULL AND redacted_version IS NOT NULL AND redacted_version>0 AND disposition_sha256 IS NOT NULL AND disposition_sha256 ~ '^[0-9a-f]{64}$'))
);
CREATE INDEX delegated_input_receipts_parent_idx ON ai.delegated_input_receipts(organization_id,parent_run_id,child_run_id);
CREATE TABLE ai.delegated_input_refs (
  organization_id uuid NOT NULL,child_run_id uuid NOT NULL,proof_key_sha256 text NOT NULL,ref_kind text NOT NULL,
  ref_id uuid NOT NULL,content_sha256 text,classification text NOT NULL,source_id uuid,document_id uuid,proof_kind text NOT NULL,
  CONSTRAINT delegated_input_refs_pk PRIMARY KEY(organization_id,child_run_id,proof_key_sha256),
  CONSTRAINT delegated_input_refs_receipt_fk FOREIGN KEY(organization_id,child_run_id) REFERENCES ai.delegated_input_receipts(organization_id,child_run_id),
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
--> statement-breakpoint
-- This normalizes only the supplied ACTUAL frozen server inventory; it grants no body/read/birth
-- capability. Authority-only entries retain NULL content hashes. Metadata identities are separate.
CREATE FUNCTION ai.delegated_frozen_refs(p_inventory jsonb)
RETURNS TABLE(proof_key_sha256 text,ref_kind text,ref_id uuid,content_sha256 text,classification text,source_id uuid,document_id uuid,proof_kind text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE flat jsonb;r jsonb;
BEGIN
  IF jsonb_typeof(p_inventory) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'DELEGATION_FROZEN_INPUT_INVALID' USING ERRCODE='EN119';END IF;
  IF jsonb_array_length(p_inventory) NOT BETWEEN 1 AND 1000
    OR octet_length(p_inventory::text)>1048576 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_inventory) e
      WHERE e->>'kind' IS NULL OR e->>'kind' NOT IN('work_unit','project','client','object_record','artifact','chunk','document','source','fact','evidence_package','model_call','authority_work_unit','authority_project','authority_client','authority_object_record','read_authority')
        OR(e->>'kind'='read_authority' AND(CASE WHEN jsonb_typeof(e->'authorityInventory')='array'
          THEN jsonb_array_length(e->'authorityInventory') NOT BETWEEN 1 AND 1000 ELSE true END))) THEN
    RAISE EXCEPTION 'DELEGATION_FROZEN_INPUT_INVALID' USING ERRCODE='EN119';END IF;
  WITH entries AS(
    SELECT jsonb_build_object('kind',CASE WHEN e->>'kind' LIKE 'authority_%' THEN substr(e->>'kind',11) ELSE e->>'kind' END,
      'id',e->>'id','sha256',e->>'sha256','classification',e->>'classification','sourceId',e->>'sourceId','documentId',e->>'documentId',
      'proofKind',CASE WHEN e->>'kind'='model_call' THEN 'model_metadata' WHEN e->>'kind'='source' OR e->>'kind' LIKE 'authority_%' THEN 'current_authority' ELSE 'actual_content' END) entry
      FROM jsonb_array_elements(p_inventory) e WHERE e->>'kind'<>'read_authority'
    UNION SELECT jsonb_build_object('kind',a->>'kind','id',a->>'id','sha256',NULL,'classification',a->>'classification',
      'sourceId',CASE WHEN a->>'kind'='source' THEN a->>'id' ELSE NULL END,
      'documentId',CASE WHEN a->>'kind'='document' THEN a->>'id' ELSE NULL END,'proofKind','read_authority')
      FROM jsonb_array_elements(p_inventory) e CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN e->>'kind'='read_authority' AND jsonb_typeof(e->'authorityInventory')='array' THEN e->'authorityInventory' ELSE '[]'::jsonb END) a
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
      OR(r->>'sourceId' IS NOT NULL AND r->>'sourceId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR(r->>'documentId' IS NOT NULL AND r->>'documentId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'DELEGATION_FROZEN_INPUT_INVALID' USING ERRCODE='EN119';END IF;
    proof_key_sha256:=encode(sha256(convert_to(r::text,'UTF8')),'hex');
    ref_kind:=r->>'kind';ref_id:=(r->>'id')::uuid;content_sha256:=r->>'sha256';classification:=r->>'classification';
    source_id:=(r->>'sourceId')::uuid;document_id:=(r->>'documentId')::uuid;proof_kind:=r->>'proofKind';
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION ai.delegated_frozen_refs(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.delegated_frozen_refs(jsonb) TO ensemus_agent;
