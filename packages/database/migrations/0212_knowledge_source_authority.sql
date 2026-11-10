-- Enforce human source mutation authority without restricting SELECT FOR SHARE/UPDATE visibility.
-- Row-lock reads remain governed by the existing read policies. Actual mutation needs a fresh actor.
CREATE FUNCTION knowledge.assert_human_source_authority(p_source uuid,p_readable boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE source knowledge.sources%ROWTYPE; actor org.memberships%ROWTYPE;
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'SOURCE_HUMAN_AUTHORITY_REQUIRED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO source FROM knowledge.sources s WHERE s.organization_id=app.current_organization_id()
    AND s.id=p_source FOR SHARE;
  SELECT * INTO actor FROM org.memberships m WHERE m.organization_id=app.current_organization_id()
    AND m.id=app.current_membership_id() AND m.status='active' FOR SHARE;
  IF source.id IS NULL OR actor.id IS NULL OR actor.role NOT IN ('owner','admin','member') OR
    (source.owner_membership_id IS DISTINCT FROM actor.id AND actor.role NOT IN ('owner','admin')) THEN
    RAISE EXCEPTION 'SOURCE_HUMAN_AUTHORITY_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF p_readable AND (source.state<>'active' OR source.kind<>'upload' OR source.id NOT IN
    (SELECT knowledge.readable_source_ids(actor.id))) THEN
    RAISE EXCEPTION 'SOURCE_READABLE_UPLOAD_REQUIRED' USING ERRCODE='42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION knowledge.assert_human_source_authority(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.assert_human_source_authority(uuid,boolean) TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION knowledge.guard_human_source_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor org.memberships%ROWTYPE;
BEGIN
  -- Only the explicit worker context owns provider ingestion and lifecycle repair. Agent/delegated
  -- actors are not a system bypass. Existing class/lifecycle/tenant checks continue to apply.
  IF knowledge.is_service_actor() THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO actor FROM org.memberships m WHERE m.organization_id=NEW.organization_id
      AND m.id=app.current_membership_id() AND m.status='active' FOR SHARE;
    IF app.current_actor_type() IS DISTINCT FROM 'user' OR NEW.kind<>'upload' OR NEW.state<>'active'
      OR NEW.connection_id IS NOT NULL OR NEW.external_resource_id IS NOT NULL
      OR NEW.owner_membership_id IS DISTINCT FROM app.current_membership_id()
      OR actor.id IS NULL OR actor.role NOT IN ('owner','admin','member') THEN
      RAISE EXCEPTION 'SOURCE_SELF_OWNED_UPLOAD_REQUIRED' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id THEN
    RAISE EXCEPTION 'SOURCE_OWNER_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  PERFORM knowledge.assert_human_source_authority(OLD.id,false);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_human_source_change() FROM PUBLIC;
CREATE TRIGGER sources_human_authority BEFORE INSERT OR UPDATE ON knowledge.sources
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_human_source_change();
--> statement-breakpoint
CREATE FUNCTION knowledge.guard_human_source_grant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF knowledge.is_service_actor() THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP='DELETE' THEN
    PERFORM knowledge.assert_human_source_authority(OLD.source_id,false);
    RETURN OLD;
  END IF;
  PERFORM knowledge.assert_human_source_authority(NEW.source_id,false);
  IF NEW.granted_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'SOURCE_ACTUAL_GRANTOR_REQUIRED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_human_source_grant() FROM PUBLIC;
CREATE TRIGGER source_grants_human_authority BEFORE INSERT OR DELETE ON knowledge.source_grants
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_human_source_grant();
--> statement-breakpoint
CREATE FUNCTION knowledge.guard_human_document_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF knowledge.is_service_actor() THEN RETURN NEW; END IF;
  PERFORM knowledge.assert_human_source_authority(NEW.source_id,true);
  IF NEW.state<>'received' OR NEW.created_by_membership_id IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'SOURCE_ACTUAL_UPLOADER_REQUIRED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_human_document_insert() FROM PUBLIC;
CREATE TRIGGER documents_human_authority BEFORE INSERT ON knowledge.documents
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_human_document_insert();
--> statement-breakpoint
CREATE FUNCTION knowledge.guard_human_object_writer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF knowledge.is_service_actor() THEN RETURN NEW; END IF;
  IF app.current_actor_type() IS DISTINCT FROM 'user' THEN
    RAISE EXCEPTION 'SOURCE_ACTUAL_WRITER_REQUIRED' USING ERRCODE='42501';
  END IF;
  -- The original writer may settle its unchanged token after its fulfilled put was cleaned up,
  -- even after role/grant loss. The 0205 trigger checks the exact actor, generation and token.
  IF TG_OP='UPDATE' AND OLD.state='active' AND NEW.state='settled' THEN RETURN NEW; END IF;
  PERFORM knowledge.assert_human_source_authority(NEW.source_id,true);
  IF NEW.started_by_membership_id IS DISTINCT FROM app.current_membership_id() OR NEW.state<>'active'
    OR NOT EXISTS(SELECT 1 FROM knowledge.documents d WHERE d.organization_id=NEW.organization_id
      AND d.id=NEW.document_id AND d.source_id=NEW.source_id AND d.state IN ('received','failed','parsing')) THEN
    RAISE EXCEPTION 'SOURCE_ACTUAL_WRITER_REQUIRED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.guard_human_object_writer() FROM PUBLIC;
CREATE TRIGGER object_writers_human_authority BEFORE INSERT OR UPDATE ON knowledge.object_writers
  FOR EACH ROW EXECUTE FUNCTION knowledge.guard_human_object_writer();
