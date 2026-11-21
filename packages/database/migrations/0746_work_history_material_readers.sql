-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-027 D1, ADR-039 D2). Human review remains pending.
-- Free-text transition and decision reasons follow the same native Work reader as their parent.
-- Existing tenant, immutable history and process-completion guards are retained.
CREATE POLICY transition_work_material_read ON work.work_transitions AS RESTRICTIVE FOR SELECT TO ensemus_app
 USING(work.material_reader(work_unit_id));
CREATE POLICY decision_work_material_read ON work.approval_decisions AS RESTRICTIVE FOR SELECT TO ensemus_app
 USING(EXISTS(SELECT 1 FROM work.approvals parent WHERE parent.organization_id=approval_decisions.organization_id
   AND parent.id=approval_decisions.approval_id));
