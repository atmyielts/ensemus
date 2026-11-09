-- REVIEWED SECURITY SQL (ADR-024 D4, WORK-07). Changes here need human review, never agent approval.
-- 0532 (upgrade): additive repair for registered 0208 and 0419, which are pushed, so neither is edited.
--
-- WORK-07 and ADR-024 promise that an approval paused by one release can be decided after upgrading.
-- A plan run paused for review on a release before 0208 holds the plan's completion checklist, which
-- that release's worker wrote as the service (created_by_membership_id NULL). 0208 reclassified every
-- such file as provenance 'pending' with an 'unknown' / 'legacy/unknown' lineage header, and 0419's
-- knowledge.retained_input_scope_readable refuses that header, so artifact_input_fence hides the
-- checklist from everyone. The paused review was bound to the work's files including that checklist,
-- so after the upgrade the hash the reviewer would be shown no longer matches and the decision is
-- refused APPROVAL_STALE (the upgrade gate's refusal code). The work can never leave the pause.
--
-- The lineage header is immutable and retained (0208 guards), so it cannot be rewritten into 0419's
-- system-template protocol, and trusting every legacy service file would reopen what 0208 closed.
-- Instead a legacy file is requalified only when its exact bytes are proven, at every read, to be the
-- deterministic plan checklist of its own Work record, with the same template, criteria validation and
-- digest comparison as 0419's knowledge.known_checklist_authority. Such bytes derive from nothing but
-- the Work's ID and its criterion kinds, so the file's only input is that Work record.
--
-- 1. knowledge.legacy_checklist_proven(artifact) is true only for:
--    - the exact header 0208 wrote ('unknown', 'legacy/unknown', no execution, viewer or inventory,
--      generation 1, write state 'unknown', state still 'pending', never purged), which no runtime
--      writer can create (0208's guard admits only agent_run, system and manual headers);
--    - a live catalog row still 'pending' with the header's digest and size;
--    - exactly one Work link, to the header's Work, whose plan is 'checklist';
--    - no knowledge source, package, file input, structured record, citation or authority receipt;
--    - bytes whose SHA-256 and size equal the checklist that Work's current criteria render. Releases
--      from 0004 to before 0208 wrote the same lines, except that the oldest worded an empty list
--      differently; both wordings are accepted, and nothing else is.
--    It reads only catalogs and the Work row, as the caller under the caller's own RLS, never
--    work.artifacts (that would recurse into the fence) and never any file's bytes. A caller who
--    cannot read the Work proves nothing. It is STABLE, invoker rights, search_path pg_catalog.
--
-- 2. knowledge.retained_input_scope_readable is 0419's text with one change in its artifact branch:
--    a proven legacy checklist passes the 'pending' catalog and lineage-protocol checks, and gets its
--    Work record as a required input, capped at the file's class, as 0419's template inventory does.
--    Every other check still applies to it unchanged: live catalog, expected digest, class cap,
--    tombstone, confidential/restricted viewer rule, a readable Work link, and its file inputs,
--    records and sources (none). Nothing else changes: an unproven or tampered legacy file, every
--    other 'unknown' header, and a null viewer (the service's ordinary-file path) stay refused.
--    CREATE OR REPLACE keeps the function's OID, owner and 0419's ACL; it stays invoker rights with
--    search_path pg_catalog, which the check below confirms first.
--
-- No table, policy, grant on a table, role or stored row changes. work.artifacts keeps provenance
-- 'pending', so the checklist still never counts as completion evidence.
DO $$ BEGIN
 IF current_user<>'ensemus_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'LEGACY_CHECKLIST_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
 IF to_regprocedure('knowledge.retained_input_scope_readable(jsonb,uuid,text)') IS NULL
  OR to_regprocedure('knowledge.known_checklist_authority(uuid)') IS NULL
  OR to_regprocedure('knowledge.retained_scope_node(text,uuid,text,text,uuid,uuid,uuid,integer)') IS NULL
  OR to_regprocedure('knowledge.artifact_authority_bindings_complete(uuid)') IS NULL
  OR to_regclass('knowledge.artifact_lineage_records') IS NULL OR to_regclass('knowledge.artifact_authority_receipts') IS NULL
  OR to_regclass('knowledge.artifact_citations') IS NULL
  OR to_regprocedure('knowledge.legacy_checklist_proven(uuid)') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='knowledge.retained_input_scope_readable(jsonb,uuid,text)'::regprocedure
   AND NOT p.prosecdef AND p.provolatile='s' AND p.proconfig=ARRAY['search_path=pg_catalog']) THEN
  RAISE EXCEPTION 'LEGACY_CHECKLIST_SOURCE_REQUIRED' USING ERRCODE='EN850';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION knowledge.legacy_checklist_proven(p_artifact uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE header knowledge.artifact_lineage;catalog knowledge.artifact_acl_catalog;body_work record;criterion jsonb;
  criteria_lines text;opening text;rendered text;ending text;links integer;
BEGIN
  IF p_artifact IS NULL OR app.current_organization_id() IS NULL THEN RETURN false;END IF;
  SELECT * INTO header FROM knowledge.artifact_lineage actual WHERE actual.organization_id=app.current_organization_id() AND actual.artifact_id=p_artifact;
  IF NOT FOUND OR header.execution_kind<>'unknown' OR header.executor_ref<>'legacy/unknown' OR header.execution_id IS NOT NULL
    OR header.viewer_membership_id IS NOT NULL OR header.inventory_complete OR header.inventory_sha256 IS NOT NULL
    OR header.state<>'pending' OR header.write_state<>'unknown' OR header.generation<>1 OR header.physical_purged_at IS NOT NULL
    OR header.work_unit_id IS NULL OR header.object_key IS DISTINCT FROM(header.organization_id::text||'/artifacts/'||header.artifact_id::text) THEN
    RETURN false;END IF;
  SELECT * INTO catalog FROM knowledge.artifact_acl_catalog actual WHERE actual.organization_id=header.organization_id AND actual.artifact_id=p_artifact;
  IF NOT FOUND OR NOT catalog.alive OR catalog.provenance_state<>'pending' OR catalog.physical_purged_at IS NOT NULL
    OR catalog.sha256 IS DISTINCT FROM header.artifact_sha256 OR catalog.size_bytes IS DISTINCT FROM header.size_bytes THEN RETURN false;END IF;
  SELECT count(*) INTO links FROM knowledge.artifact_work_links linked WHERE linked.organization_id=header.organization_id AND linked.artifact_id=p_artifact;
  IF links<>1 OR NOT EXISTS(SELECT 1 FROM knowledge.artifact_work_links linked WHERE linked.organization_id=header.organization_id
    AND linked.artifact_id=p_artifact AND linked.work_unit_id=header.work_unit_id) THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM knowledge.artifact_lineage_inputs input WHERE input.organization_id=header.organization_id AND input.artifact_id=p_artifact)
    OR EXISTS(SELECT 1 FROM knowledge.artifact_lineage_packages package WHERE package.organization_id=header.organization_id AND package.artifact_id=p_artifact)
    OR EXISTS(SELECT 1 FROM knowledge.artifact_lineage_sources source WHERE source.organization_id=header.organization_id AND source.artifact_id=p_artifact)
    OR EXISTS(SELECT 1 FROM knowledge.artifact_lineage_records record WHERE record.organization_id=header.organization_id AND record.artifact_id=p_artifact)
    OR EXISTS(SELECT 1 FROM knowledge.artifact_citations citation WHERE citation.organization_id=header.organization_id AND citation.artifact_id=p_artifact)
    OR EXISTS(SELECT 1 FROM knowledge.artifact_authority_receipts receipt WHERE receipt.organization_id=header.organization_id AND receipt.artifact_id=p_artifact) THEN
    RETURN false;END IF;
  -- The caller's own RLS applies. Only a yes/no about an exact enum/ID template leaves this function.
  SELECT work.id,work.completion_criteria,work.execution_plan INTO body_work FROM work.work_units work
    WHERE work.organization_id=header.organization_id AND work.id=header.work_unit_id;
  IF NOT FOUND OR body_work.execution_plan IS DISTINCT FROM 'checklist'
    OR jsonb_typeof(body_work.completion_criteria) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(body_work.completion_criteria)>1000 THEN RETURN false;END IF;
  FOR criterion IN SELECT value FROM jsonb_array_elements(body_work.completion_criteria) LOOP
    IF jsonb_typeof(criterion) IS DISTINCT FROM 'object' OR criterion->>'kind' IS NULL
      OR criterion->>'kind' NOT IN('artifact_exists','reviewer_approved','external_receipt')
      OR criterion IS DISTINCT FROM jsonb_build_object('kind',criterion->>'kind') THEN RETURN false;END IF;
  END LOOP;
  SELECT string_agg('- [ ] '||CASE value->>'kind'
      WHEN 'artifact_exists' THEN 'Someone attaches the file that shows the result.'
      WHEN 'reviewer_approved' THEN 'A reviewer approves this work as it stands.'
      WHEN 'external_receipt' THEN 'The outside system confirms it happened.' END,E'\n' ORDER BY ordinal)
    INTO criteria_lines FROM jsonb_array_elements(body_work.completion_criteria) WITH ORDINALITY entries(value,ordinal);
  opening:='# Completion checklist'||E'\n\n'
    ||'Ensemus wrote this list. It has not checked any of this, and this file is not evidence.'||E'\n'
    ||'A person decides when this work is done.'||E'\n\nWork: '||body_work.id::text||E'\n\n';
  FOREACH ending IN ARRAY ARRAY[
    coalesce(criteria_lines,'- [ ] The accountable owner confirms the outcome. No evidence was asked for.'),
    coalesce(criteria_lines,'- [ ] Someone confirms the outcome was reached. No other evidence was asked for.')] LOOP
    rendered:=opening||ending||E'\n';
    IF header.artifact_sha256=encode(sha256(convert_to(rendered,'UTF8')),'hex') AND header.size_bytes=octet_length(rendered) THEN RETURN true;END IF;
  END LOOP;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION knowledge.legacy_checklist_proven(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.legacy_checklist_proven(uuid) TO ensemus_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION knowledge.retained_input_scope_readable(p_inventory jsonb,p_viewer uuid,p_protection text) RETURNS boolean
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
  catalog_found boolean;legacy_checklist boolean;
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
    allowed:=cap BETWEEN 1 AND 4 AND(historical_class IS NULL OR knowledge.class_rank(historical_class)<=cap);children:='[]'::jsonb;
    IF kind='work_unit' THEN
      live_class:=knowledge.work_scope_class(target);
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
      catalog_found:=FOUND;
      -- 0532: a pre-0208 plan checklist whose bytes are proven to be its own Work's exact template.
      legacy_checklist:=catalog_found AND catalog.alive AND catalog.provenance_state='pending' AND knowledge.legacy_checklist_proven(target);
      allowed:=allowed AND catalog_found AND catalog.alive AND(expected_hash IS NULL OR catalog.sha256=expected_hash)
        AND knowledge.class_rank(catalog.classification)<=cap AND(catalog.provenance_state NOT IN('pending','blocked') OR legacy_checklist)
        AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=app.current_organization_id() AND tomb.target_type='artifact' AND tomb.target_id=target);
      SELECT * INTO header FROM knowledge.artifact_lineage actual WHERE actual.organization_id=app.current_organization_id() AND actual.artifact_id=target;
      IF FOUND THEN
        IF legacy_checklist THEN
          -- Its one input is its own Work record, which must stay readable at no more than the file's class.
          allowed:=allowed AND header.physical_purged_at IS NULL AND header.artifact_sha256=catalog.sha256;
          children:=children||jsonb_build_array(jsonb_build_object('alternative',false,'node',knowledge.retained_scope_node('work_unit',header.work_unit_id,
            NULL,NULL,NULL,NULL,NULL,least(cap,knowledge.class_rank(catalog.classification)))));
        ELSE
        allowed:=allowed AND header.inventory_complete AND header.state='bound' AND header.write_state='settled' AND header.physical_purged_at IS NULL
          AND header.artifact_sha256=catalog.sha256;
        IF header.execution_kind IN('agent_run','system') THEN
          allowed:=allowed AND header.structured_inventory_complete AND knowledge.artifact_authority_bindings_complete(target);
          IF allowed THEN
          FOR record_ref IN SELECT ref.* FROM knowledge.artifact_authority_refs ref WHERE ref.organization_id=app.current_organization_id() AND ref.artifact_id=target LOOP
            children:=children||jsonb_build_array(jsonb_build_object('alternative',false,'node',knowledge.retained_scope_node(record_ref.ref_kind,record_ref.ref_id,
              record_ref.content_sha256,record_ref.classification,record_ref.source_id,record_ref.document_id,record_ref.fact_package_id,least(cap,knowledge.class_rank(catalog.classification)))));
          END LOOP;
          END IF;
        ELSIF header.execution_kind<>'manual' THEN allowed:=false;END IF;
        END IF;
      ELSIF catalog.provenance_state='bound' OR legacy_checklist THEN allowed:=false;END IF;
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
        live_class:=knowledge.work_scope_class(link.work_unit_id);
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
      allowed:=allowed AND FOUND AND knowledge.fact_authority_receipt_live(node_package_id,target,expected_hash,CASE cap WHEN 4 THEN 'restricted' WHEN 3 THEN 'confidential' WHEN 2 THEN 'internal' ELSE 'public' END);
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
