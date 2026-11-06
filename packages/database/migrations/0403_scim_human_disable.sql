-- A human explicitly disabling an already SCIM-disabled membership revokes SCIM's authority to
-- reactivate it. No new role grant or definer capability: the existing tenant/column grants apply.
-- Application callers use member_changes:<org> advisory -> membership -> matching provider links.
CREATE FUNCTION org.invalidate_scim_reactivation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor org.memberships%ROWTYPE;
BEGIN
  IF NEW.status<>'disabled' OR app.current_actor_type() IS DISTINCT FROM 'user' THEN RETURN NEW; END IF;
  SELECT * INTO actor FROM org.memberships m WHERE m.organization_id=NEW.organization_id
    AND m.organization_id=app.current_organization_id() AND m.id=app.current_membership_id()
    AND m.user_id=app.current_user_id() AND m.status='active' FOR SHARE;
  IF actor.id IS NULL OR actor.role NOT IN ('owner','admin') OR
    (OLD.role='owner' AND actor.role<>'owner') THEN
    RAISE EXCEPTION 'MEMBER_DISABLE_AUTHORITY_REQUIRED' USING ERRCODE='42501';
  END IF;
  UPDATE org.sso_member_links l SET deprovisioned_at=NULL,updated_at=clock_timestamp()
    WHERE l.organization_id=NEW.organization_id AND l.membership_id=NEW.id
      AND l.state='deprovisioned' AND l.deprovisioned_at IS NOT NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION org.invalidate_scim_reactivation() FROM PUBLIC;
CREATE TRIGGER memberships_human_disable BEFORE UPDATE OF status ON org.memberships
  FOR EACH ROW EXECUTE FUNCTION org.invalidate_scim_reactivation();
