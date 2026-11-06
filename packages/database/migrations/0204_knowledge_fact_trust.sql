-- Facts must not reveal an unreadable subject through a readable source, even via a page cursor.
-- This restrictive policy composes with the existing all-evidence ACL policy before LIMIT is applied.
CREATE FUNCTION knowledge.can_read_fact_subject(p_ref text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT knowledge.is_service_actor() OR CASE split_part(p_ref, ':', 1)
    WHEN 'client' THEN EXISTS (
      SELECT 1 FROM work.clients c WHERE c.id::text = split_part(p_ref, ':', 2)
        AND (c.classification IN ('public','internal') OR
          (c.classification = 'confidential' AND EXISTS (
            SELECT 1 FROM org.memberships m WHERE m.id = app.current_membership_id()
              AND m.organization_id = app.current_organization_id() AND m.status = 'active'
              AND m.role IN ('owner','admin')))))
    WHEN 'project' THEN EXISTS (
      SELECT 1 FROM work.projects p WHERE p.id::text = split_part(p_ref, ':', 2)
        AND (p.client_id IS NULL OR knowledge.can_read_fact_subject('client:' || p.client_id::text)))
    WHEN 'work_unit' THEN EXISTS (
      SELECT 1 FROM work.work_units w WHERE w.id::text = split_part(p_ref, ':', 2)
        AND knowledge.can_read_work(w.id, app.current_membership_id()))
    WHEN 'knowledge_source' THEN EXISTS (
      SELECT 1 FROM knowledge.sources s WHERE s.id::text = split_part(p_ref, ':', 2)
        AND s.state = 'active' AND s.id IN (SELECT knowledge.readable_source_ids(app.current_membership_id())))
    WHEN 'membership' THEN EXISTS (
      SELECT 1 FROM org.memberships m WHERE m.organization_id = app.current_organization_id()
        AND m.id::text = split_part(p_ref, ':', 2))
    WHEN 'team' THEN EXISTS (SELECT 1 FROM org.teams t WHERE t.id::text = split_part(p_ref, ':', 2))
    ELSE false END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION knowledge.can_read_fact_subject(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.can_read_fact_subject(text) TO ensemus_app;
--> statement-breakpoint
CREATE POLICY subject_read ON knowledge.facts AS RESTRICTIVE FOR SELECT TO ensemus_app
  USING (knowledge.can_read_fact_subject(subject_ref));
--> statement-breakpoint

-- A proposer cannot impersonate a different person to evade independent review. Every proposal has
-- one active initiating membership; a worker acting for them must identify its actual model run.
CREATE OR REPLACE FUNCTION knowledge.check_new_fact() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.trust_state <> 'proposed' OR NEW.version <> 1
     OR NEW.reviewed_by_membership_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL
     OR NEW.superseded_by_id IS NOT NULL OR NEW.conflict_ref IS NOT NULL
     OR NEW.review_reason IS NOT NULL THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_START' USING ERRCODE = 'EN107';
  END IF;
  IF app.current_actor_type() NOT IN ('user','delegated','agent')
     OR NEW.proposed_by_membership_id IS DISTINCT FROM app.current_membership_id()
     OR NOT EXISTS (SELECT 1 FROM org.memberships m
         WHERE m.organization_id = NEW.organization_id AND m.id = app.current_membership_id()
           AND m.status = 'active')
     OR (NEW.origin = 'person' AND app.current_actor_type() IS DISTINCT FROM 'user')
     OR (app.current_actor_type() IN ('delegated','agent') AND
         (NEW.origin <> 'model' OR NEW.proposed_by_run_id IS NULL)) THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_PERSON' USING ERRCODE = 'EN109';
  END IF;
  IF NEW.proposed_by_run_id IS NOT NULL THEN
    IF current_user <> 'ensemus_agent' OR app.current_actor_type() IS DISTINCT FROM 'agent'
       OR NEW.origin <> 'model' THEN
      RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_PERSON' USING ERRCODE = 'EN109';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ai.agent_runs r WHERE r.organization_id = NEW.organization_id
        AND r.id = NEW.proposed_by_run_id AND r.initiator_membership_id = app.current_membership_id()
        AND r.status = 'running' AND r.ended_at IS NULL) THEN
      RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_PERSON' USING ERRCODE = 'EN109';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Keep the original transition/evidence checks, and enforce reviewer authority in the database too.
CREATE OR REPLACE FUNCTION knowledge.check_fact_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed boolean; backed boolean; reviewer boolean;
BEGIN
  IF NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR (NEW.valid_until IS DISTINCT FROM OLD.valid_until AND
         NOT (knowledge.is_service_actor() AND NEW.valid_until IS NOT NULL
           AND (OLD.valid_until IS NULL OR NEW.valid_until <= OLD.valid_until))) THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_TRANSITION' USING ERRCODE = 'EN108';
  END IF;
  IF NEW.conflict_ref IS DISTINCT FROM OLD.conflict_ref
     AND NOT (NEW.trust_state = 'disputed' AND
       (NEW.trust_state IS DISTINCT FROM OLD.trust_state OR knowledge.is_service_actor())) THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_TRANSITION' USING ERRCODE = 'EN108';
  END IF;
  IF NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id AND NOT (
       (NEW.trust_state = 'superseded' AND OLD.trust_state <> 'superseded') OR
       (knowledge.is_service_actor() AND OLD.trust_state = 'superseded'
        AND NEW.trust_state = 'superseded' AND NEW.superseded_by_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM knowledge.fact_evidence e
          WHERE e.organization_id = OLD.organization_id AND e.fact_id = OLD.superseded_by_id))) THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_TRANSITION' USING ERRCODE = 'EN108';
  END IF;
  IF NEW.trust_state = OLD.trust_state THEN
    IF ROW(NEW.reviewed_by_membership_id, NEW.reviewed_at, NEW.review_reason)
         IS DISTINCT FROM ROW(OLD.reviewed_by_membership_id, OLD.reviewed_at, OLD.review_reason) THEN
      RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_PERSON' USING ERRCODE = 'EN109';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_TRANSITION' USING ERRCODE = 'EN108';
  END IF;
  allowed := CASE OLD.trust_state
    WHEN 'proposed' THEN NEW.trust_state IN ('verified','disputed','rejected','superseded')
    WHEN 'disputed' THEN NEW.trust_state IN ('verified','rejected','superseded')
    WHEN 'verified' THEN NEW.trust_state IN ('disputed','superseded') ELSE false END;
  IF NOT allowed OR (NEW.trust_state = 'disputed' AND NEW.conflict_ref IS NULL)
     OR (NEW.trust_state = 'superseded' AND NEW.superseded_by_id IS NULL) THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_INVALID_TRANSITION' USING ERRCODE = 'EN108';
  END IF;
  SELECT app.current_actor_type() = 'user' AND EXISTS (
    SELECT 1 FROM org.memberships m WHERE m.organization_id = NEW.organization_id
      AND m.id = app.current_membership_id() AND m.status = 'active' AND m.role IN ('owner','admin'))
    INTO reviewer;
  IF NEW.trust_state IN ('verified','rejected','superseded') AND NOT coalesce(reviewer, false) THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_PERSON' USING ERRCODE = 'EN109';
  END IF;
  IF NEW.trust_state NOT IN ('verified','rejected') AND
     ROW(NEW.reviewed_by_membership_id, NEW.reviewed_at, NEW.review_reason)
       IS DISTINCT FROM ROW(OLD.reviewed_by_membership_id, OLD.reviewed_at, OLD.review_reason) THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_PERSON' USING ERRCODE = 'EN109';
  END IF;
  IF NEW.trust_state = 'disputed' AND NOT knowledge.is_service_actor() AND NOT coalesce(reviewer, false)
     AND NOT (OLD.trust_state = 'proposed'
       AND OLD.proposed_by_membership_id = app.current_membership_id()) THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_PERSON' USING ERRCODE = 'EN109';
  END IF;
  IF NEW.trust_state IN ('verified','rejected') THEN
    IF NEW.reviewed_by_membership_id IS DISTINCT FROM app.current_membership_id()
       OR NEW.reviewed_by_membership_id IS NULL OR NEW.reviewed_at IS NULL
       OR NEW.reviewed_by_membership_id = OLD.proposed_by_membership_id
       OR nullif(btrim(NEW.review_reason), '') IS NULL THEN
      RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_PERSON' USING ERRCODE = 'EN109';
    END IF;
  END IF;
  IF NEW.trust_state = 'verified' THEN
    SELECT EXISTS (SELECT 1 FROM knowledge.fact_evidence e
        WHERE e.organization_id = NEW.organization_id AND e.fact_id = NEW.id)
      AND NOT EXISTS (SELECT 1 FROM knowledge.fact_evidence e JOIN knowledge.sources s
        ON s.organization_id = e.organization_id AND s.id = e.source_id
        WHERE e.organization_id = NEW.organization_id AND e.fact_id = NEW.id AND s.state <> 'active')
      INTO backed;
    IF NOT backed THEN
      RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_EVIDENCE' USING ERRCODE = 'EN110';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Evidence may be added only before review. Its parent lock serializes addition against verification.
-- Only source purge may remove evidence, and it must invalidate or delete the affected fact atomically.
CREATE FUNCTION knowledge.preserve_fact_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_state text; proposer uuid; source_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT knowledge.is_service_actor() THEN
      RAISE EXCEPTION 'KNOWLEDGE_EVIDENCE_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  SELECT state INTO source_state FROM knowledge.sources
    WHERE organization_id = NEW.organization_id AND id = NEW.source_id FOR SHARE;
  IF source_state IS DISTINCT FROM 'active' OR NEW.source_id NOT IN (
      SELECT knowledge.readable_source_ids(app.current_membership_id())) THEN
    RAISE EXCEPTION 'KNOWLEDGE_EVIDENCE_IMMUTABLE' USING ERRCODE = 'EN111';
  END IF;
  SELECT trust_state, proposed_by_membership_id INTO parent_state, proposer FROM knowledge.facts
    WHERE organization_id = NEW.organization_id AND id = NEW.fact_id FOR SHARE;
  IF parent_state IS DISTINCT FROM 'proposed' OR proposer IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'KNOWLEDGE_EVIDENCE_IMMUTABLE' USING ERRCODE = 'EN111';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fact_evidence_preserve_review BEFORE INSERT OR DELETE ON knowledge.fact_evidence
  FOR EACH ROW EXECUTE FUNCTION knowledge.preserve_fact_evidence();
--> statement-breakpoint
CREATE FUNCTION knowledge.check_removed_fact_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_state text;
BEGIN
  SELECT trust_state INTO parent_state FROM knowledge.facts
    WHERE organization_id = OLD.organization_id AND id = OLD.fact_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF parent_state = 'verified' OR NOT EXISTS (SELECT 1 FROM knowledge.fact_evidence
      WHERE organization_id = OLD.organization_id AND fact_id = OLD.fact_id) THEN
    RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_EVIDENCE' USING ERRCODE = 'EN110';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER fact_evidence_removed AFTER DELETE ON knowledge.fact_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION knowledge.check_removed_fact_evidence();
