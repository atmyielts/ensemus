-- Client names are company material too. Apply the same named-person rule as restricted Work,
-- centrally, so People, project pickers, search, graph and fact subjects cannot disagree.
-- Legacy ownership is unknown: do not invent a creator or make all administrators named readers.
ALTER TABLE work.clients ADD COLUMN owner_membership_id uuid DEFAULT app.current_membership_id();
ALTER TABLE work.clients ADD COLUMN access_version integer NOT NULL DEFAULT 1;
ALTER TABLE work.clients ADD CONSTRAINT clients_owner_tenant_fk FOREIGN KEY(organization_id,owner_membership_id)
  REFERENCES org.memberships(organization_id,id);
ALTER TABLE work.clients ADD CONSTRAINT clients_access_version_positive CHECK(access_version>0);
CREATE TABLE work.client_readers (
  organization_id uuid NOT NULL, client_id uuid NOT NULL, membership_id uuid NOT NULL,
  granted_by_membership_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_readers_pk PRIMARY KEY(organization_id,client_id,membership_id),
  CONSTRAINT client_readers_client_tenant_fk FOREIGN KEY(organization_id,client_id) REFERENCES work.clients(organization_id,id) ON DELETE CASCADE,
  CONSTRAINT client_readers_member_tenant_fk FOREIGN KEY(organization_id,membership_id) REFERENCES org.memberships(organization_id,id) ON DELETE CASCADE,
  CONSTRAINT client_readers_grantor_tenant_fk FOREIGN KEY(organization_id,granted_by_membership_id) REFERENCES org.memberships(organization_id,id)
);
--> statement-breakpoint
ALTER TABLE work.client_readers ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.client_readers FORCE ROW LEVEL SECURITY;
-- Like source_grants, this relation contains only tenant-local IDs. Do not ACL-filter its IDs out
-- of an authorization decision. Names and other client material remain behind clients' policy.
CREATE POLICY tenant_read ON work.client_readers FOR SELECT TO ensemus_app
  USING(organization_id=app.current_organization_id());
CREATE POLICY owner_insert ON work.client_readers FOR INSERT TO ensemus_app WITH CHECK(
  organization_id=app.current_organization_id() AND (knowledge.is_service_actor() OR
    (app.current_actor_type()='user' AND granted_by_membership_id=app.current_membership_id()
      AND EXISTS(SELECT 1 FROM work.clients c WHERE c.organization_id=client_readers.organization_id
        AND c.id=client_readers.client_id AND c.owner_membership_id=app.current_membership_id())
      AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=client_readers.organization_id
        AND m.id=client_readers.membership_id AND m.status='active'))));
CREATE POLICY owner_delete ON work.client_readers FOR DELETE TO ensemus_app USING(
  organization_id=app.current_organization_id() AND (knowledge.is_service_actor() OR
    (app.current_actor_type()='user' AND EXISTS(SELECT 1 FROM work.clients c
      WHERE c.organization_id=client_readers.organization_id AND c.id=client_readers.client_id
        AND c.owner_membership_id=app.current_membership_id()))));
GRANT SELECT,INSERT,DELETE ON work.client_readers TO ensemus_app;
GRANT UPDATE(access_version) ON work.clients TO ensemus_app;
--> statement-breakpoint
CREATE POLICY client_visibility ON work.clients AS RESTRICTIVE FOR SELECT TO ensemus_app USING(
  knowledge.is_service_actor() OR EXISTS(SELECT 1 FROM org.memberships m
    WHERE m.organization_id=clients.organization_id AND m.id=app.current_membership_id() AND m.status='active'
      AND (clients.classification IN ('public','internal') OR clients.owner_membership_id=m.id
        OR EXISTS(SELECT 1 FROM work.client_readers r WHERE r.organization_id=clients.organization_id
          AND r.client_id=clients.id AND r.membership_id=m.id)
        OR (clients.classification='confidential' AND m.role IN ('owner','admin')))));
CREATE POLICY client_creator ON work.clients AS RESTRICTIVE FOR INSERT TO ensemus_app WITH CHECK(
  knowledge.is_service_actor() OR (app.current_actor_type()='user' AND owner_membership_id=app.current_membership_id()
    AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=clients.organization_id
      AND m.id=app.current_membership_id() AND m.status='active')));
CREATE POLICY client_owner_change ON work.clients AS RESTRICTIVE FOR UPDATE TO ensemus_app
  -- UPDATE USING also filters SELECT FOR SHARE/UPDATE. Permit every current readable row to be
  -- locked for evidence checks, but keep actual changed rows owner-only in WITH CHECK.
  USING(knowledge.is_service_actor() OR EXISTS(SELECT 1 FROM org.memberships m
    WHERE m.organization_id=clients.organization_id AND m.id=app.current_membership_id() AND m.status='active'
      AND (clients.classification IN ('public','internal') OR clients.owner_membership_id=m.id
        OR EXISTS(SELECT 1 FROM work.client_readers r WHERE r.organization_id=clients.organization_id
          AND r.client_id=clients.id AND r.membership_id=m.id)
        OR (clients.classification='confidential' AND m.role IN ('owner','admin')))))
  WITH CHECK(knowledge.is_service_actor() OR (app.current_actor_type()='user' AND owner_membership_id=app.current_membership_id()
    AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=clients.organization_id AND m.id=app.current_membership_id() AND m.status='active')));
CREATE POLICY client_owner_delete ON work.clients AS RESTRICTIVE FOR DELETE TO ensemus_app
  USING(knowledge.is_service_actor() OR (app.current_actor_type()='user' AND owner_membership_id=app.current_membership_id()
    AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=clients.organization_id AND m.id=app.current_membership_id() AND m.status='active')));
--> statement-breakpoint
CREATE POLICY project_client_visibility ON work.projects AS RESTRICTIVE FOR SELECT TO ensemus_app USING(
  knowledge.is_service_actor() OR (EXISTS(SELECT 1 FROM org.memberships m
    WHERE m.organization_id=projects.organization_id AND m.id=app.current_membership_id() AND m.status='active')
    AND (client_id IS NULL OR EXISTS(SELECT 1 FROM work.clients c WHERE c.organization_id=projects.organization_id AND c.id=projects.client_id))));
CREATE POLICY project_client_insert ON work.projects AS RESTRICTIVE FOR INSERT TO ensemus_app WITH CHECK(
  knowledge.is_service_actor() OR (EXISTS(SELECT 1 FROM org.memberships m
    WHERE m.organization_id=projects.organization_id AND m.id=app.current_membership_id() AND m.status='active')
    AND (client_id IS NULL OR EXISTS(SELECT 1 FROM work.clients c WHERE c.organization_id=projects.organization_id AND c.id=projects.client_id))));
CREATE POLICY project_client_update ON work.projects AS RESTRICTIVE FOR UPDATE TO ensemus_app
  USING(knowledge.is_service_actor() OR (EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=projects.organization_id AND m.id=app.current_membership_id() AND m.status='active')
    AND (client_id IS NULL OR EXISTS(SELECT 1 FROM work.clients c WHERE c.organization_id=projects.organization_id AND c.id=projects.client_id))))
  WITH CHECK(knowledge.is_service_actor() OR (EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=projects.organization_id AND m.id=app.current_membership_id() AND m.status='active')
    AND (client_id IS NULL OR EXISTS(SELECT 1 FROM work.clients c WHERE c.organization_id=projects.organization_id AND c.id=projects.client_id))));
CREATE POLICY project_client_delete ON work.projects AS RESTRICTIVE FOR DELETE TO ensemus_app
  USING(knowledge.is_service_actor() OR (EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=projects.organization_id AND m.id=app.current_membership_id() AND m.status='active')
    AND (client_id IS NULL OR EXISTS(SELECT 1 FROM work.clients c WHERE c.organization_id=projects.organization_id AND c.id=projects.client_id))));
--> statement-breakpoint
-- A locking read is not consent to remove a private relationship. Keep the broad visible UPDATE
-- USING above for SELECT FOR SHARE; require the old private client's actual owner on real reparenting.
CREATE FUNCTION work.guard_private_project_reparent() RETURNS trigger
  LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE old_class text; old_owner uuid;
BEGIN
  IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_OP<>'UPDATE'
     OR TG_TABLE_SCHEMA<>'work' OR TG_TABLE_NAME<>'projects'
     OR TG_RELID<>'work.projects'::regclass THEN
    RAISE EXCEPTION 'PROJECT_REPARENT_GUARD_INVALID' USING ERRCODE='42501';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'PROJECT_TENANT_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  IF NEW.client_id IS NOT DISTINCT FROM OLD.client_id THEN RETURN NEW; END IF;
  -- Existing tenant RLS and the destination WITH CHECK still constrain explicit service imports.
  -- Delegated/agent contexts with an initiating membership do not meet this service predicate.
  IF knowledge.is_service_actor() THEN RETURN NEW; END IF;
  IF OLD.client_id IS NULL THEN RETURN NEW; END IF;
  BEGIN
    -- UPDATE already owns the project row. Do not wait in the inverse project -> client order if
    -- another operation owns the client first. A caller may retry explicitly; this guard never does.
    SELECT c.classification,c.owner_membership_id INTO old_class,old_owner FROM work.clients c
      WHERE c.organization_id=OLD.organization_id AND c.id=OLD.client_id FOR SHARE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'PROJECT_CLIENT_ACCESS_BUSY' USING ERRCODE='55P03';
  END;
  IF old_class IS NULL OR old_class NOT IN ('public','internal','confidential','restricted') THEN
    RAISE EXCEPTION 'PROJECT_REPARENT_REQUIRES_CLIENT_OWNER' USING ERRCODE='42501';
  END IF;
  IF old_class IN ('confidential','restricted') AND NOT coalesce((
    app.current_actor_type()='user' AND old_owner IS NOT NULL
    AND old_owner=app.current_membership_id()
    AND EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=OLD.organization_id
      AND m.id=app.current_membership_id() AND m.status='active')),false) THEN
    RAISE EXCEPTION 'PROJECT_REPARENT_REQUIRES_CLIENT_OWNER' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION work.guard_private_project_reparent() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER projects_private_reparent BEFORE UPDATE OF client_id ON work.projects
  FOR EACH ROW EXECUTE FUNCTION work.guard_private_project_reparent();
--> statement-breakpoint
-- Clients/projects now enforce their own fresh ACL before returning a row. Reuse that single
-- decision instead of the earlier conservative check that made even a restricted client's owner invisible.
CREATE OR REPLACE FUNCTION knowledge.can_read_fact_subject(p_ref text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT knowledge.is_service_actor() OR CASE split_part(p_ref,':',1)
    WHEN 'client' THEN EXISTS(SELECT 1 FROM work.clients c WHERE c.id::text=split_part(p_ref,':',2))
    WHEN 'project' THEN EXISTS(SELECT 1 FROM work.projects p WHERE p.id::text=split_part(p_ref,':',2))
    WHEN 'work_unit' THEN EXISTS(SELECT 1 FROM work.work_units w WHERE w.id::text=split_part(p_ref,':',2)
      AND knowledge.can_read_work(w.id,app.current_membership_id()))
    WHEN 'knowledge_source' THEN EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id::text=split_part(p_ref,':',2)
      AND s.state='active' AND s.id IN(SELECT knowledge.readable_source_ids(app.current_membership_id())))
    WHEN 'membership' THEN EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=app.current_organization_id() AND m.id::text=split_part(p_ref,':',2))
    WHEN 'team' THEN EXISTS(SELECT 1 FROM org.teams t WHERE t.id::text=split_part(p_ref,':',2)) ELSE false END
$$;
