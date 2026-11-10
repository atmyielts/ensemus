-- Preserve positive ordinary provenance after deletion. A dead catalog still cannot serve bytes;
-- retained generated/unknown lineage remains blocked. Existing unknown history is never promoted.
CREATE OR REPLACE FUNCTION knowledge.track_artifact_acl() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE row_org uuid; row_id uuid;
BEGIN
  IF TG_RELID NOT IN ('work.artifacts'::regclass,'work.work_artifacts'::regclass,'knowledge.artifact_lineage'::regclass)
    OR TG_TABLE_SCHEMA NOT IN ('work','knowledge') OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'INVALID_CATALOG_TARGET' USING ERRCODE='42501';
  END IF;
  row_org := CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  IF row_org IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'INVALID_CATALOG_TENANT' USING ERRCODE='42501';
  END IF;
  IF TG_RELID='work.artifacts'::regclass THEN
    row_id := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    IF TG_OP='DELETE' THEN
      UPDATE knowledge.artifact_acl_catalog SET alive=false,provenance_state=CASE
        WHEN OLD.provenance_state='ordinary' AND NOT EXISTS(SELECT 1 FROM knowledge.artifact_lineage l
          WHERE l.organization_id=row_org AND l.artifact_id=row_id) THEN 'ordinary' ELSE 'blocked' END
        WHERE organization_id=row_org AND artifact_id=row_id;
      DELETE FROM knowledge.artifact_work_links WHERE organization_id=row_org AND artifact_id=row_id;
      RETURN OLD;
    END IF;
    INSERT INTO knowledge.artifact_acl_catalog(organization_id,artifact_id,sha256,classification,size_bytes,provenance_state,alive)
      VALUES(row_org,NEW.id,NEW.sha256,NEW.classification,NEW.size_bytes,NEW.provenance_state,true)
      ON CONFLICT(organization_id,artifact_id) DO UPDATE SET sha256=EXCLUDED.sha256,
        classification=EXCLUDED.classification,size_bytes=EXCLUDED.size_bytes,
        provenance_state=CASE WHEN EXISTS(SELECT 1 FROM knowledge.artifact_lineage l
          WHERE l.organization_id=row_org AND l.artifact_id=row_id AND l.state='blocked')
          THEN 'blocked' ELSE EXCLUDED.provenance_state END,alive=true;
  ELSIF TG_RELID='work.work_artifacts'::regclass THEN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_ARTIFACT_LINK' USING ERRCODE='42501'; END IF;
    IF TG_OP='DELETE' THEN
      DELETE FROM knowledge.artifact_work_links WHERE organization_id=row_org
        AND artifact_id=OLD.artifact_id AND work_unit_id=OLD.work_unit_id;
      RETURN OLD;
    END IF;
    INSERT INTO knowledge.artifact_work_links(organization_id,artifact_id,work_unit_id)
      VALUES(row_org,NEW.artifact_id,NEW.work_unit_id) ON CONFLICT DO NOTHING;
  ELSE
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'RETAIN_ARTIFACT_LINEAGE' USING ERRCODE='42501'; END IF;
    INSERT INTO knowledge.artifact_acl_catalog(organization_id,artifact_id,sha256,classification,size_bytes,provenance_state,alive)
      VALUES(row_org,NEW.artifact_id,NEW.artifact_sha256,NEW.classification,NEW.size_bytes,
        CASE WHEN NEW.execution_kind='manual' THEN 'ordinary' ELSE NEW.state END,false) ON CONFLICT DO NOTHING;
    IF TG_OP='UPDATE' AND NEW.state='blocked' THEN
      UPDATE knowledge.artifact_acl_catalog SET provenance_state='blocked'
        WHERE organization_id=row_org AND artifact_id=NEW.artifact_id;
    END IF;
    IF NEW.physical_purged_at IS NOT NULL THEN
      UPDATE knowledge.artifact_acl_catalog SET physical_purged_at=NEW.physical_purged_at
        WHERE organization_id=row_org AND artifact_id=NEW.artifact_id AND physical_purged_at IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Metadata-only ordinary-file restore maintenance. Serving RLS and generated-input gates stay closed.
CREATE FUNCTION knowledge.restore_ordinary_artifact_metadata(p_artifact uuid,p_apply boolean DEFAULT false,p_expected_works uuid[] DEFAULT NULL)
RETURNS TABLE(object_key text,work_unit_ids uuid[],removed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE row_org uuid:=app.current_organization_id(); deleted_count integer; expected uuid[];
BEGIN
  IF row_org IS NULL OR NOT knowledge.is_service_actor() THEN
    RAISE EXCEPTION 'ORDINARY_RESTORE_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF p_apply THEN
    PERFORM 1 FROM knowledge.artifact_acl_catalog c WHERE c.organization_id=row_org AND c.artifact_id=p_artifact FOR UPDATE;
  END IF;
  SELECT a.object_key INTO object_key FROM work.artifacts a WHERE a.organization_id=row_org AND a.id=p_artifact;
  IF NOT FOUND THEN RETURN; END IF;
  IF object_key<>row_org::text||'/artifacts/'||p_artifact::text
    OR NOT EXISTS(SELECT 1 FROM knowledge.artifact_acl_catalog c WHERE c.organization_id=row_org AND c.artifact_id=p_artifact AND c.alive AND c.provenance_state='ordinary')
    OR EXISTS(SELECT 1 FROM knowledge.artifact_lineage l WHERE l.organization_id=row_org AND l.artifact_id=p_artifact) THEN
    RAISE EXCEPTION 'ORDINARY_RESTORE_PROVENANCE_UNKNOWN' USING ERRCODE='EN118'; END IF;
  SELECT coalesce(array_agg(l.work_unit_id ORDER BY l.work_unit_id),'{}'::uuid[]) INTO work_unit_ids
    FROM work.work_artifacts l WHERE l.organization_id=row_org AND l.artifact_id=p_artifact;
  removed:=false;
  IF p_apply THEN
    SELECT array_agg(value ORDER BY value) INTO expected FROM (SELECT DISTINCT unnest(p_expected_works) AS value) keys;
    IF p_expected_works IS NULL OR work_unit_ids IS DISTINCT FROM coalesce(expected,'{}'::uuid[])
      OR NOT EXISTS(SELECT 1 FROM platform.tombstones t WHERE t.organization_id=row_org AND t.target_type='artifact' AND t.target_id=p_artifact)
      OR NOT EXISTS(SELECT 1 FROM platform.blob_lifecycle b WHERE b.organization_id=row_org AND b.artifact_id=p_artifact
        AND b.object_key=restore_ordinary_artifact_metadata.object_key AND b.state='deleting') THEN
      RAISE EXCEPTION 'ORDINARY_RESTORE_CHANGED' USING ERRCODE='EN118'; END IF;
    DELETE FROM work.artifacts a WHERE a.organization_id=row_org AND a.id=p_artifact;
    GET DIAGNOSTICS deleted_count=ROW_COUNT;
    removed:=deleted_count=1;
  END IF;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION knowledge.restore_ordinary_artifact_metadata(uuid,boolean,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.restore_ordinary_artifact_metadata(uuid,boolean,uuid[]) TO ensemus_app;

--> statement-breakpoint
-- Bind the actual onboarding run and serialize its publication and reviewer authority.
CREATE POLICY onboarding_0215_preflight ON work.client_onboardings FOR SELECT TO ensemus_migrator USING(true);
CREATE POLICY onboarding_0215_runs ON ai.agent_runs FOR SELECT TO ensemus_migrator USING(true);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM work.client_onboardings o WHERE o.agent_run_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM ai.agent_runs r WHERE r.organization_id=o.organization_id AND r.id=o.agent_run_id
      AND r.work_unit_id=o.brief_work_unit_id AND r.initiator_membership_id=o.requested_by_membership_id
      AND r.parent_run_id IS NULL)) THEN
    RAISE EXCEPTION 'ONBOARDING_RUN_REFERENCE_REPAIR_REQUIRED' USING ERRCODE='EN215';
  END IF;
END $$;
DROP POLICY onboarding_0215_preflight ON work.client_onboardings;
DROP POLICY onboarding_0215_runs ON ai.agent_runs;
--> statement-breakpoint
ALTER TABLE work.client_onboardings ADD CONSTRAINT client_onboarding_run_fk
  FOREIGN KEY(organization_id,agent_run_id) REFERENCES ai.agent_runs(organization_id,id);
--> statement-breakpoint
-- A row lock cannot exclude a new finite-duration publication. Serialize that exact definition's
-- publication set as well, without granting UPDATE on immutable agent definitions or versions.
CREATE FUNCTION ai.serialize_agent_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_org uuid; definition_key uuid;
BEGIN
  IF TG_RELID<>'ai.agent_publications'::regclass OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'PUBLICATION_LOCK_TARGET_INVALID' USING ERRCODE='42501'; END IF;
  row_org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  definition_key:=CASE WHEN TG_OP='DELETE' THEN OLD.definition_id ELSE NEW.definition_id END;
  IF row_org IS DISTINCT FROM app.current_organization_id() OR (TG_OP='UPDATE' AND
    ROW(NEW.organization_id,NEW.definition_id) IS DISTINCT FROM ROW(OLD.organization_id,OLD.definition_id)) THEN
    RAISE EXCEPTION 'PUBLICATION_LOCK_TENANT_INVALID' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ensemus:agent-publication:'||row_org::text||':'||definition_key::text,0));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ai.serialize_agent_publication() FROM PUBLIC;
CREATE TRIGGER agent_publications_00_serial BEFORE INSERT OR UPDATE OR DELETE ON ai.agent_publications
  FOR EACH ROW EXECUTE FUNCTION ai.serialize_agent_publication();
--> statement-breakpoint
CREATE FUNCTION work.guard_onboarding_run_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_role text; person_id uuid; work_id uuid; item work.work_units%ROWTYPE;
  expected_owner uuid; expected_parent uuid; expected_hash text; definition_key uuid; version_key uuid; active_count integer;
BEGIN
  IF TG_RELID<>'work.client_onboardings'::regclass OR TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'ONBOARDING_BIND_TARGET_INVALID' USING ERRCODE='42501'; END IF;
  IF OLD.agent_run_id IS NOT NULL OR NEW.agent_run_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id()
    OR app.current_actor_type() IS DISTINCT FROM 'delegated'
    OR NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id()
    OR OLD.state<>'started' OR NEW.state<>'waiting_for_brief' THEN
    RAISE EXCEPTION 'ONBOARDING_BIND_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  SELECT role INTO actor_role FROM org.memberships WHERE organization_id=NEW.organization_id
    AND id=NEW.requested_by_membership_id AND status='active' FOR SHARE NOWAIT;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'ONBOARDING_BIND_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  FOR person_id IN SELECT DISTINCT unnest(ARRAY[NEW.owner_membership_id,NEW.reviewer_membership_id,NEW.requested_by_membership_id]) ORDER BY 1 LOOP
    PERFORM 1 FROM org.memberships WHERE organization_id=NEW.organization_id AND id=person_id AND status='active' FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'ONBOARDING_BIND_PARTICIPANT_CLOSED' USING ERRCODE='EN215'; END IF;
  END LOOP;
  IF NEW.reviewer_membership_id IN (NEW.owner_membership_id,NEW.requested_by_membership_id)
    OR (SELECT count(DISTINCT value) FROM unnest(ARRAY[NEW.work_unit_id,NEW.brief_work_unit_id,NEW.review_work_unit_id,NEW.send_work_unit_id]) value)<>4 THEN
    RAISE EXCEPTION 'ONBOARDING_BIND_IDENTITY_INVALID' USING ERRCODE='EN215'; END IF;
  FOR work_id IN SELECT unnest(ARRAY[NEW.work_unit_id,NEW.brief_work_unit_id,NEW.review_work_unit_id,NEW.send_work_unit_id]) ORDER BY 1 LOOP
    SELECT * INTO item FROM work.work_units WHERE organization_id=NEW.organization_id AND id=work_id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'ONBOARDING_BIND_WORK_CLOSED' USING ERRCODE='EN215'; END IF;
    expected_owner:=CASE WHEN work_id IN (NEW.brief_work_unit_id,NEW.review_work_unit_id) THEN NEW.reviewer_membership_id ELSE NEW.owner_membership_id END;
    expected_parent:=CASE WHEN work_id=NEW.work_unit_id THEN NULL ELSE NEW.work_unit_id END;
    expected_hash:=CASE work_id WHEN NEW.work_unit_id THEN NEW.parent_objective_sha256 WHEN NEW.brief_work_unit_id THEN NEW.brief_objective_sha256
      WHEN NEW.review_work_unit_id THEN NEW.review_objective_sha256 ELSE NEW.send_objective_sha256 END;
    IF item.owner_membership_id IS DISTINCT FROM expected_owner OR item.parent_id IS DISTINCT FROM expected_parent
      OR item.project_id IS DISTINCT FROM NEW.project_id OR item.status NOT IN ('queued','ready','running')
      OR expected_hash IS NULL OR expected_hash<>encode(sha256(convert_to(coalesce(item.objective,''),'UTF8')),'hex') THEN
      RAISE EXCEPTION 'ONBOARDING_BIND_WORK_CHANGED' USING ERRCODE='EN215'; END IF;
  END LOOP;
  PERFORM 1 FROM work.projects WHERE organization_id=NEW.organization_id AND id=NEW.project_id AND client_id=NEW.client_id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'ONBOARDING_BIND_PROJECT_CHANGED' USING ERRCODE='EN215'; END IF;
  FOR work_id IN SELECT unnest(ARRAY[NEW.brief_work_unit_id,NEW.review_work_unit_id]) LOOP
    IF NOT EXISTS(SELECT 1 FROM work.work_assignments a WHERE a.organization_id=NEW.organization_id AND a.work_unit_id=work_id
      AND a.membership_id=NEW.reviewer_membership_id AND a.actor_type='human' AND a.responsibility='reviewer') THEN
      RAISE EXCEPTION 'ONBOARDING_BIND_REVIEWER_CHANGED' USING ERRCODE='EN215'; END IF;
  END LOOP;
  SELECT d.id,v.id INTO definition_key,version_key FROM ai.agent_runs r JOIN ai.agent_versions v
    ON v.organization_id=r.organization_id AND v.id=r.agent_version_id JOIN ai.agent_definitions d
    ON d.organization_id=v.organization_id AND d.id=v.definition_id JOIN org.service_identities i
    ON i.organization_id=d.organization_id AND i.id=d.service_identity_id
    WHERE r.organization_id=NEW.organization_id AND r.id=NEW.agent_run_id AND r.parent_run_id IS NULL AND r.depth=0 AND r.status='queued'
      AND r.work_unit_id=NEW.brief_work_unit_id AND r.initiator_membership_id=NEW.requested_by_membership_id
      AND d.slug='client-brief' AND v.spec->>'id'='client-brief' AND i.status='active' AND (i.expires_at IS NULL OR i.expires_at>now())
    FOR SHARE OF r,i NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'ONBOARDING_BIND_RUN_INVALID' USING ERRCODE='EN215'; END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ensemus:agent-publication:'||NEW.organization_id::text||':'||definition_key::text,0)) THEN
    RAISE EXCEPTION 'ONBOARDING_PUBLICATION_BUSY' USING ERRCODE='55P03'; END IF;
  SELECT count(*) INTO active_count FROM ai.agent_publications p WHERE p.organization_id=NEW.organization_id AND p.definition_id=definition_key
    AND p.active_from<=now() AND (p.active_until IS NULL OR p.active_until>now());
  IF active_count<>1 OR NOT EXISTS(SELECT 1 FROM ai.agent_publications p WHERE p.organization_id=NEW.organization_id
    AND p.definition_id=definition_key AND p.version_id=version_key AND p.active_from<=now() AND (p.active_until IS NULL OR p.active_until>now())) THEN
    RAISE EXCEPTION 'ONBOARDING_BIND_PUBLICATION_CHANGED' USING ERRCODE='EN215'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION work.guard_onboarding_run_binding() FROM PUBLIC;
CREATE TRIGGER client_onboardings_00_run_binding BEFORE UPDATE ON work.client_onboardings
  FOR EACH ROW EXECUTE FUNCTION work.guard_onboarding_run_binding();
--> statement-breakpoint
CREATE FUNCTION work.lock_onboarding_reviewer_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_org uuid; target_work uuid;
BEGIN
  IF TG_RELID<>'work.work_assignments'::regclass OR TG_OP NOT IN ('INSERT','DELETE') THEN
    RAISE EXCEPTION 'ONBOARDING_ASSIGNMENT_TARGET_INVALID' USING ERRCODE='42501'; END IF;
  row_org:=CASE WHEN TG_OP='DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
  target_work:=CASE WHEN TG_OP='DELETE' THEN OLD.work_unit_id ELSE NEW.work_unit_id END;
  IF row_org IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'ONBOARDING_ASSIGNMENT_TENANT_INVALID' USING ERRCODE='42501'; END IF;
  -- The restricted whole-tenant eraser has its own closed-tenant RLS/proof path, no UPDATE grant.
  IF current_user<>'ensemus_eraser' AND EXISTS(SELECT 1 FROM work.client_onboardings o WHERE o.organization_id=row_org
    AND target_work IN (o.brief_work_unit_id,o.review_work_unit_id) AND o.state NOT IN ('completed','failed','unknown')) THEN
    PERFORM 1 FROM work.work_units WHERE organization_id=row_org AND id=target_work FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'ONBOARDING_ASSIGNMENT_WORK_CLOSED' USING ERRCODE='EN215'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION work.lock_onboarding_reviewer_assignment() FROM PUBLIC;
CREATE TRIGGER assignment_00_onboarding_lock BEFORE INSERT OR DELETE ON work.work_assignments
  FOR EACH ROW EXECUTE FUNCTION work.lock_onboarding_reviewer_assignment();
