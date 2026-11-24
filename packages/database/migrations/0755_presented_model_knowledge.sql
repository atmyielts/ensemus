-- FLAGGED FOR HUMAN SECURITY REVIEW
-- IDs and ordinals of the passages in the actual provider request, after context compaction.
-- Legacy snapshots have no such receipt. The existing snapshot guard makes this column immutable.
ALTER TABLE ai.main_input_snapshots ADD COLUMN presented_knowledge jsonb;
--> statement-breakpoint
GRANT SELECT (presented_knowledge) ON ai.main_input_snapshots TO ensemus_agent;
--> statement-breakpoint

CREATE FUNCTION ai.check_presented_model_knowledge() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE selected_package_id uuid; passage_keys jsonb; key_count integer;
BEGIN
 IF NEW.presented_knowledge IS NULL THEN RETURN NEW; END IF;
 passage_keys:=NEW.presented_knowledge->'ordinals';
 IF jsonb_typeof(NEW.presented_knowledge) IS DISTINCT FROM 'object'
  OR (NEW.presented_knowledge-ARRAY['packageId','ordinals'])<>'{}'::jsonb
  OR coalesce(NEW.presented_knowledge->>'packageId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR jsonb_typeof(passage_keys) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'PRESENTED_KNOWLEDGE_INVALID' USING ERRCODE='EN119';
 END IF;
 key_count:=jsonb_array_length(passage_keys);
 IF key_count NOT BETWEEN 1 AND 1000 OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(passage_keys) element
  WHERE jsonb_typeof(element)<>'number' OR element::text !~ '^[1-9][0-9]{0,3}$'
 ) THEN RAISE EXCEPTION 'PRESENTED_KNOWLEDGE_INVALID' USING ERRCODE='EN119';END IF;
 selected_package_id:=(NEW.presented_knowledge->>'packageId')::uuid;
 IF NOT EXISTS(
  SELECT 1 FROM knowledge.evidence_packages package
  JOIN ai.agent_runs run ON run.organization_id=package.organization_id AND run.id=package.run_id
  WHERE package.organization_id=NEW.organization_id AND package.id=selected_package_id
    AND run.id=NEW.run_id AND package.work_unit_id=run.work_unit_id
    AND package.viewer_membership_id=NEW.viewer_membership_id AND package.purpose='agent_turn'
    AND EXISTS(
     SELECT 1 FROM jsonb_array_elements(NEW.input_inventory) receipt
     WHERE receipt->>'kind'='evidence_package' AND receipt->>'id'=package.id::text
       AND receipt->>'sha256'=package.package_sha256
    )
 ) OR key_count<>(
  SELECT count(*) FROM knowledge.evidence_items item
  WHERE item.organization_id=NEW.organization_id AND item.package_id=selected_package_id
    AND item.ordinal IN(SELECT element::integer FROM jsonb_array_elements_text(passage_keys) element)
 ) THEN RAISE EXCEPTION 'PRESENTED_KNOWLEDGE_UNBOUND' USING ERRCODE='EN119';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ai.check_presented_model_knowledge() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER main_snapshot_presented_knowledge BEFORE INSERT ON ai.main_input_snapshots
FOR EACH ROW EXECUTE FUNCTION ai.check_presented_model_knowledge();
