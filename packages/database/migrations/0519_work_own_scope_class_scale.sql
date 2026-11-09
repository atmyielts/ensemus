-- REVIEWED SECURITY SQL (ADR-024 D4, ADR-029). Changes here need human review, never agent approval.
-- Additive repair of 0419's knowledge.work_own_scope_readable_0419. 0419 compared its own_rank
-- against a 0-based scale, but knowledge.class_rank (0201) is 1-based: public=1, internal=2,
-- confidential=3, restricted=4. So 0419 hid internal Work from ordinary members and confidential
-- Work from owners and admins, which 0411's work_scope_readable allowed. This restores 0411's
-- exact rule on the registered scale: public and internal to any active member; confidential to
-- owners and admins; restricted only to the owner of the Work or an assignee. Every other clause
-- is unchanged: tenant, liveness, tombstone, the delegated-input receipt floor, the parent chain,
-- and the active-membership join. An unranked label (rank 0 or NULL) is no longer open to every
-- member, as it was under 0419's <=1; like 0411, it needs ownership or assignment.
-- 0419 is pushed, so it is not edited.
DO $$ BEGIN
  IF current_user<>'ensemus_migrator' THEN
    RAISE EXCEPTION 'WORK_SCOPE_CLASS_SCALE_REVIEW_REQUIRED' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION knowledge.work_own_scope_readable_0419(p_work uuid,p_viewer uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM knowledge.structured_record_catalog own JOIN org.memberships viewer
    ON viewer.organization_id=own.organization_id AND viewer.id=p_viewer AND viewer.status='active'
    CROSS JOIN LATERAL(SELECT greatest(knowledge.class_rank(own.classification),coalesce((SELECT max(knowledge.class_rank(receipt.classification))
      FROM ai.delegated_input_receipts receipt WHERE receipt.organization_id=own.organization_id AND receipt.child_work_unit_id=own.record_id),0)) own_rank) protection
    WHERE own.organization_id=app.current_organization_id() AND own.record_kind='work_unit' AND own.record_id=p_work AND own.alive
      AND NOT EXISTS(SELECT 1 FROM platform.tombstones tomb WHERE tomb.organization_id=own.organization_id AND tomb.target_type='work_unit' AND tomb.target_id=own.record_id)
      AND(protection.own_rank IN(1,2) OR own.owner_membership_id=p_viewer OR(protection.own_rank=3 AND viewer.role IN('owner','admin'))
        OR EXISTS(SELECT 1 FROM knowledge.structured_work_assignments assignment WHERE assignment.organization_id=own.organization_id
          AND assignment.work_unit_id=own.record_id AND assignment.membership_id=p_viewer))
      AND(own.parent_record_id IS NULL OR knowledge.structured_record_readable('project',own.parent_record_id,p_viewer)))
$$;
REVOKE ALL ON FUNCTION knowledge.work_own_scope_readable_0419(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.work_own_scope_readable_0419(uuid,uuid) TO ensemus_app;
