-- Row-lock reads need the same visibility as SELECT. WITH CHECK still confines every actual
-- document mutation to the service actor; no column or body permission is added.
ALTER POLICY service_update ON knowledge.documents
  USING (organization_id=app.current_organization_id() AND
    (knowledge.is_service_actor() OR source_id IN
      (SELECT knowledge.readable_source_ids(app.current_membership_id()))))
  WITH CHECK (organization_id=app.current_organization_id() AND knowledge.is_service_actor());
--> statement-breakpoint

-- Do not silently accept or delete legacy orphan claims. These temporary owner-only policies
-- exist within the migration transaction and are removed before it can commit.
CREATE POLICY fact_integrity_0213_scan ON knowledge.facts FOR SELECT TO ensemus_migrator USING (true);
CREATE POLICY fact_integrity_0213_evidence_scan ON knowledge.fact_evidence FOR SELECT TO ensemus_migrator USING (true);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM knowledge.facts f WHERE NOT EXISTS
      (SELECT 1 FROM knowledge.fact_evidence e WHERE e.organization_id=f.organization_id AND e.fact_id=f.id)) THEN
    RAISE EXCEPTION 'FACT_EVIDENCE_REPAIR_REQUIRED' USING ERRCODE='EN213';
  END IF;
END $$;
DROP POLICY fact_integrity_0213_scan ON knowledge.facts;
DROP POLICY fact_integrity_0213_evidence_scan ON knowledge.fact_evidence;
--> statement-breakpoint

-- A proposal cannot be inserted for a subject its initiating person cannot read. This is an
-- additional guard; the deferred evidence invariant below must survive later ACL revocation too.
CREATE POLICY subject_insert ON knowledge.facts AS RESTRICTIVE FOR INSERT TO ensemus_app
  WITH CHECK (knowledge.can_read_fact_subject(subject_ref));
--> statement-breakpoint

-- The old deferred trigger queried its parent as the caller. Restrictive SELECT policies could
-- hide that parent and make zero evidence look like an already deleted fact. The replacement
-- inspects only exact row IDs under these two trigger-scoped owner policies, never claim bodies.
CREATE POLICY fact_evidence_control_parent ON knowledge.facts FOR SELECT TO ensemus_migrator
  USING (pg_trigger_depth()>0 AND
    organization_id=nullif(current_setting('knowledge.evidence_check_org',true),'')::uuid AND
    id=nullif(current_setting('knowledge.evidence_check_fact',true),'')::uuid);
CREATE POLICY fact_evidence_control_rows ON knowledge.fact_evidence FOR SELECT TO ensemus_migrator
  USING (pg_trigger_depth()>0 AND
    organization_id=nullif(current_setting('knowledge.evidence_check_org',true),'')::uuid AND
    fact_id=nullif(current_setting('knowledge.evidence_check_fact',true),'')::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION knowledge.check_fact_has_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_org text; previous_fact text;
BEGIN
  IF TG_RELID<>'knowledge.facts'::regclass OR TG_OP<>'INSERT' OR TG_WHEN<>'AFTER'
      OR TG_LEVEL<>'ROW' OR pg_trigger_depth()<1 OR
      NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'FACT_EVIDENCE_TRIGGER_SCOPE' USING ERRCODE='42501';
  END IF;
  previous_org := current_setting('knowledge.evidence_check_org',true);
  previous_fact := current_setting('knowledge.evidence_check_fact',true);
  PERFORM set_config('knowledge.evidence_check_org',NEW.organization_id::text,true);
  PERFORM set_config('knowledge.evidence_check_fact',NEW.id::text,true);
  BEGIN
    IF EXISTS (SELECT 1 FROM knowledge.facts f
        WHERE f.organization_id=NEW.organization_id AND f.id=NEW.id)
      AND NOT EXISTS (SELECT 1 FROM knowledge.fact_evidence e
        WHERE e.organization_id=NEW.organization_id AND e.fact_id=NEW.id) THEN
      RAISE EXCEPTION 'KNOWLEDGE_FACT_NEEDS_EVIDENCE' USING ERRCODE='EN110';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('knowledge.evidence_check_org',coalesce(previous_org,''),true);
    PERFORM set_config('knowledge.evidence_check_fact',coalesce(previous_fact,''),true);
    RAISE;
  END;
  PERFORM set_config('knowledge.evidence_check_org',coalesce(previous_org,''),true);
  PERFORM set_config('knowledge.evidence_check_fact',coalesce(previous_fact,''),true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION knowledge.check_fact_has_evidence() FROM PUBLIC;
