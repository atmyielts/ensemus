-- REVIEWED SECURITY SQL (ADR-032 D7). Changes here need human review, never agent approval.
-- Additive repair of 0419's own-Work predicate, whose registered SQL stays unchanged. 0419 compared
-- the protection rank as if the scale were 0-3, but knowledge.class_rank (0201) is 1-4:
-- public=1, internal=2, confidential=3, restricted=4. So internal Work became owner/admin-only and
-- confidential Work became owner/assignee-only, denying readers that 0411's ordinary rule admits.
-- The corrected comparisons restore 0411 exactly: public/internal to any active member, confidential
-- to owners/admins, and restricted (4) still only to the Work's owner or an assignee. The protection
-- rank is unchanged: a delegated child keeps the highest class of its inherited receipts, so lowering
-- its raw label still cannot weaken it. Parent, tenant, liveness and tombstone checks are unchanged.
CREATE OR REPLACE FUNCTION knowledge.work_own_scope_readable_0419(p_work uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog own JOIN org.memberships viewer
    ON viewer.organization_id=own.organization_id AND viewer.id=p_viewer AND viewer.status='active'
    CROSS JOIN LATERAL(SELECT greatest(knowledge.class_rank(own.classification),coalesce((SELECT max(knowledge.class_rank(receipt.classification))
      FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=own.organization_id AND receipt.child_work_unit_id=own.record_id),0)) own_rank) protection
    WHERE own.organization_id=app.current_organization_id() AND own.record_kind='work_unit' AND own.record_id=p_work AND own.alive
      AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=own.organization_id AND tomb.target_type='work_unit' AND tomb.target_id=own.record_id)
      AND(protection.own_rank<=2 OR own.owner_membership_id=p_viewer OR(protection.own_rank=3 AND viewer.role IN('owner','admin'))
        OR EXISTS(SELECT 1 FROM knowledge.structured_work_assignments assignment WHERE assignment.organization_id=own.organization_id
          AND assignment.work_unit_id=own.record_id AND assignment.membership_id=p_viewer))
      AND(own.parent_record_id IS NULL OR knowledge.structured_record_readable('project',own.parent_record_id,p_viewer)))
$$;
REVOKE ALL ON FUNCTION knowledge.work_own_scope_readable_0419(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.work_own_scope_readable_0419(uuid,uuid) TO ensemus_app;
