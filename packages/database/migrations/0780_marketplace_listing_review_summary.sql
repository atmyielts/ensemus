-- FLAGGED FOR HUMAN SECURITY REVIEW
-- A listing publishes the reviewer's label and the decision time. The rest of the
-- review remains governed by the existing publisher and installer policies.
CREATE POLICY marketplace_review_summary_member ON org.memberships
  FOR SELECT TO ensemus_migrator
  USING (app.is_web_login() AND app.current_actor_type()='user'
    AND nullif(current_setting('marketplace.review_listing_id',true),'') IS NOT NULL
    AND organization_id=app.current_organization_id()
    AND id=app.current_membership_id() AND user_id=app.current_user_id());
CREATE POLICY marketplace_review_summary_listing ON marketplace.listings
  FOR SELECT TO ensemus_migrator
  USING (app.is_web_login() AND app.current_actor_type()='user'
    AND id::text=current_setting('marketplace.review_listing_id',true)
    AND (state='listed' OR publisher_organization_id=app.current_organization_id()
      OR EXISTS (SELECT 1 FROM marketplace.installations installation
        WHERE installation.organization_id=app.current_organization_id()
          AND installation.listing_id=listings.id)));
CREATE POLICY marketplace_review_summary_receipt ON marketplace.security_reviews
  FOR SELECT TO ensemus_migrator
  USING (app.is_web_login() AND app.current_actor_type()='user' AND EXISTS (
    SELECT 1 FROM marketplace.listings listing
    WHERE listing.review_id=security_reviews.id
      AND listing.id::text=current_setting('marketplace.review_listing_id',true)
  ));
--> statement-breakpoint
CREATE FUNCTION marketplace.listing_review_summary(p_listing_id uuid)
RETURNS TABLE (reviewer_label text, decided_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $function$
DECLARE previous_listing text:=current_setting('marketplace.review_listing_id',true);
BEGIN
  IF current_user<>'ensemus_migrator' OR NOT app.is_web_login()
    OR app.current_actor_type() IS DISTINCT FROM 'user' OR p_listing_id IS NULL
    OR app.current_organization_id() IS NULL THEN RETURN; END IF;
  PERFORM set_config('marketplace.review_listing_id',p_listing_id::text,true);
  IF EXISTS (SELECT 1 FROM org.memberships member
    WHERE member.organization_id=app.current_organization_id()
      AND member.id=app.current_membership_id()
      AND member.user_id=app.current_user_id()
      AND member.status='active') THEN
    RETURN QUERY
      SELECT review.reviewer_label, review.decided_at
      FROM marketplace.listings listing
      JOIN marketplace.security_reviews review ON review.id=listing.review_id
      WHERE listing.id=p_listing_id;
  END IF;
  PERFORM set_config('marketplace.review_listing_id',coalesce(previous_listing,''),true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('marketplace.review_listing_id',coalesce(previous_listing,''),true);
  RAISE;
END;
$function$;
REVOKE ALL ON FUNCTION marketplace.listing_review_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marketplace.listing_review_summary(uuid) TO ensemus_app;
