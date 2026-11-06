-- AGENT-12: durable classified company state. No contact, brief or email text crosses Temporal.
-- Nullable additions keep legacy rows as history; the service refuses to advance an incomplete row.
ALTER TABLE work.client_onboardings
  ADD COLUMN owner_membership_id uuid,
  ADD COLUMN reviewer_membership_id uuid,
  ADD COLUMN email_connection_id uuid,
  ADD COLUMN contact_email text,
  ADD COLUMN brief_work_unit_id uuid,
  ADD COLUMN review_work_unit_id uuid,
  ADD COLUMN send_work_unit_id uuid,
  ADD COLUMN parent_objective_sha256 text,
  ADD COLUMN brief_objective_sha256 text,
  ADD COLUMN review_objective_sha256 text,
  ADD COLUMN send_objective_sha256 text,
  ADD COLUMN agent_run_id uuid,
  ADD COLUMN brief_artifact_id uuid,
  ADD COLUMN accepted_verification_id uuid,
  ADD COLUMN email_external_action_id uuid,
  ADD COLUMN email_approval_id uuid;
--> statement-breakpoint
ALTER TABLE work.client_onboardings
  ADD FOREIGN KEY(organization_id,owner_membership_id) REFERENCES org.memberships(organization_id,id),
  ADD FOREIGN KEY(organization_id,reviewer_membership_id) REFERENCES org.memberships(organization_id,id),
  ADD FOREIGN KEY(organization_id,email_connection_id) REFERENCES integrations.connections(organization_id,id),
  ADD FOREIGN KEY(organization_id,brief_work_unit_id) REFERENCES work.work_units(organization_id,id),
  ADD FOREIGN KEY(organization_id,review_work_unit_id) REFERENCES work.work_units(organization_id,id),
  ADD FOREIGN KEY(organization_id,send_work_unit_id) REFERENCES work.work_units(organization_id,id),
  ADD FOREIGN KEY(organization_id,accepted_verification_id) REFERENCES knowledge.artifact_verifications(organization_id,id),
  ADD FOREIGN KEY(organization_id,email_external_action_id) REFERENCES integrations.external_actions(organization_id,id),
  ADD FOREIGN KEY(organization_id,email_approval_id) REFERENCES work.approvals(organization_id,id);
-- agent_run_id gets its tenant FK at the M4 join. brief_artifact_id is an immutable provenance ID,
-- like artifact_verifications.artifact_id: retaining this workflow cannot prevent a privacy purge.
--> statement-breakpoint
ALTER TABLE work.client_onboardings ADD CONSTRAINT client_onboarding_contact_bounds
  CHECK(contact_email IS NULL OR (length(contact_email) BETWEEN 3 AND 254 AND contact_email !~ '[[:space:]]'));
--> statement-breakpoint
GRANT UPDATE(agent_run_id,brief_artifact_id,accepted_verification_id,email_external_action_id,email_approval_id)
  ON work.client_onboardings TO ensemus_app;
--> statement-breakpoint
CREATE FUNCTION work.check_client_onboarding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF app.current_actor_type()<>'user' OR NEW.requested_by_membership_id IS DISTINCT FROM app.current_membership_id()
      OR NOT EXISTS(SELECT 1 FROM org.memberships m WHERE m.organization_id=NEW.organization_id AND m.id=NEW.requested_by_membership_id AND m.status='active' AND m.role IN ('owner','admin'))
      OR NEW.state<>'started' OR NEW.version<>1 OR NEW.finished_at IS NOT NULL OR NEW.cost_micros IS NOT NULL
      OR NEW.owner_membership_id IS NULL OR NEW.reviewer_membership_id IS NULL OR NEW.email_connection_id IS NULL OR NEW.contact_email IS NULL
      OR NEW.brief_work_unit_id IS NULL OR NEW.review_work_unit_id IS NULL OR NEW.send_work_unit_id IS NULL
      OR NEW.parent_objective_sha256 IS NULL OR NEW.brief_objective_sha256 IS NULL OR NEW.review_objective_sha256 IS NULL OR NEW.send_objective_sha256 IS NULL
      OR NEW.parent_objective_sha256 !~ '^[0-9a-f]{64}$' OR NEW.brief_objective_sha256 !~ '^[0-9a-f]{64}$'
      OR NEW.review_objective_sha256 !~ '^[0-9a-f]{64}$' OR NEW.send_objective_sha256 !~ '^[0-9a-f]{64}$'
      OR NEW.reviewer_membership_id IN (NEW.owner_membership_id,NEW.requested_by_membership_id)
      OR NEW.agent_run_id IS NOT NULL OR NEW.brief_artifact_id IS NOT NULL OR NEW.accepted_verification_id IS NOT NULL
      OR NEW.email_external_action_id IS NOT NULL OR NEW.email_approval_id IS NOT NULL THEN
      RAISE EXCEPTION 'ONBOARDING_INVALID_START' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT knowledge.is_service_actor() AND NOT (app.current_actor_type()='delegated'
    AND app.current_membership_id()=OLD.requested_by_membership_id AND EXISTS(SELECT 1 FROM org.memberships m
      WHERE m.organization_id=OLD.organization_id AND m.id=OLD.requested_by_membership_id AND m.status='active')) THEN
    RAISE EXCEPTION 'ONBOARDING_NEEDS_WORKER' USING ERRCODE='42501';
  END IF;
  IF ROW(NEW.organization_id,NEW.id,NEW.deal_ref,NEW.client_id,NEW.project_id,NEW.work_unit_id,
      NEW.owner_membership_id,NEW.reviewer_membership_id,NEW.email_connection_id,NEW.contact_email,
      NEW.brief_work_unit_id,NEW.review_work_unit_id,NEW.send_work_unit_id,NEW.requested_by_membership_id)
    IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.deal_ref,OLD.client_id,OLD.project_id,OLD.work_unit_id,
      OLD.owner_membership_id,OLD.reviewer_membership_id,OLD.email_connection_id,OLD.contact_email,
      OLD.brief_work_unit_id,OLD.review_work_unit_id,OLD.send_work_unit_id,OLD.requested_by_membership_id)
    OR ROW(NEW.parent_objective_sha256,NEW.brief_objective_sha256,NEW.review_objective_sha256,NEW.send_objective_sha256)
      IS DISTINCT FROM ROW(OLD.parent_objective_sha256,OLD.brief_objective_sha256,OLD.review_objective_sha256,OLD.send_objective_sha256)
    OR (OLD.agent_run_id IS NOT NULL AND NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id)
    OR (OLD.brief_artifact_id IS NOT NULL AND NEW.brief_artifact_id IS DISTINCT FROM OLD.brief_artifact_id)
    OR (OLD.accepted_verification_id IS NOT NULL AND NEW.accepted_verification_id IS DISTINCT FROM OLD.accepted_verification_id)
    OR (OLD.email_external_action_id IS NOT NULL AND NEW.email_external_action_id IS DISTINCT FROM OLD.email_external_action_id)
    OR (OLD.email_approval_id IS NOT NULL AND NEW.email_approval_id IS DISTINCT FROM OLD.email_approval_id)
    OR (NEW.cost_micros IS NOT NULL AND NEW.cost_micros<0) THEN
    RAISE EXCEPTION 'ONBOARDING_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  allowed:=NEW.state=OLD.state OR CASE OLD.state
    WHEN 'started' THEN NEW.state IN ('waiting_for_brief','failed')
    WHEN 'waiting_for_brief' THEN NEW.state IN ('waiting_for_acceptance','failed')
    WHEN 'waiting_for_acceptance' THEN NEW.state IN ('waiting_for_send','failed')
    WHEN 'waiting_for_send' THEN NEW.state IN ('completed','failed','unknown') ELSE false END;
  IF NOT allowed OR NEW.version<>OLD.version+1
    OR (NEW.state IN ('completed','failed','unknown'))<>(NEW.finished_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ONBOARDING_INVALID_TRANSITION' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER client_onboardings_check BEFORE INSERT OR UPDATE ON work.client_onboardings
  FOR EACH ROW EXECUTE FUNCTION work.check_client_onboarding();
--> statement-breakpoint
-- An explicit workflow adoption bridge, not generic cross-work proof reuse. Each target keeps its OWN
-- pinned objective. The exact acceptance of the actual brief must still be current and live. PL/pgSQL
-- defers resolving artifact_acceptance_id until execution, after its definition in migration 0208.
CREATE FUNCTION knowledge.onboarding_artifact_evidence(p_artifact uuid,p_work uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
DECLARE found boolean;
BEGIN
  SELECT true INTO found FROM work.client_onboardings o
    JOIN work.work_units target ON target.organization_id=o.organization_id AND target.id=p_work
    JOIN work.work_units brief ON brief.organization_id=o.organization_id AND brief.id=o.brief_work_unit_id
    JOIN knowledge.artifact_verifications v ON v.organization_id=o.organization_id AND v.id=o.accepted_verification_id
    WHERE o.organization_id=app.current_organization_id() AND o.brief_artifact_id=p_artifact
      AND p_work IN (o.work_unit_id,o.brief_work_unit_id,o.review_work_unit_id)
      AND o.reviewer_membership_id<>o.owner_membership_id AND o.reviewer_membership_id<>o.requested_by_membership_id
      AND o.state IN ('waiting_for_acceptance','waiting_for_send','completed')
      AND v.artifact_id=p_artifact AND v.work_unit_id=o.brief_work_unit_id
      AND v.decided_by_membership_id=o.reviewer_membership_id AND v.kind='human' AND v.verdict='accepted'
      AND v.objective_sha256=o.brief_objective_sha256
      AND encode(sha256(convert_to(coalesce(brief.objective,''),'UTF8')),'hex')=o.brief_objective_sha256
      AND encode(sha256(convert_to(coalesce(target.objective,''),'UTF8')),'hex')=CASE p_work
        WHEN o.work_unit_id THEN o.parent_objective_sha256 WHEN o.brief_work_unit_id THEN o.brief_objective_sha256
        WHEN o.review_work_unit_id THEN o.review_objective_sha256 END
      AND EXISTS(SELECT 1 FROM knowledge.artifact_work_links wa WHERE wa.organization_id=o.organization_id AND wa.work_unit_id=p_work AND wa.artifact_id=p_artifact)
      AND knowledge.artifact_acceptance_id(p_artifact,o.brief_work_unit_id)=o.accepted_verification_id
    LIMIT 1;
  RETURN coalesce(found,false);
END $$;
REVOKE ALL ON FUNCTION knowledge.onboarding_artifact_evidence(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.onboarding_artifact_evidence(uuid,uuid) TO ensemus_app;
