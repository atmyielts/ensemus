-- FLAGGED FOR HUMAN SECURITY REVIEW
-- REVIEWED SECURITY SQL (ADR-024 D4, API-12). Human review remains pending.
-- A replay result can contain private content. Neither company administration nor native worker
-- credentials confer access to another caller's response. Keep erasure metadata/delete paths intact.
CREATE POLICY idempotency_person_read ON platform.idempotency_keys AS RESTRICTIVE FOR SELECT TO ensemus_app
 USING(app.is_web_login() AND app.current_actor_type()='user'
   AND membership_id=app.current_membership_id()
   AND EXISTS(SELECT 1 FROM org.memberships person
     WHERE person.organization_id=app.current_organization_id()
       AND person.organization_id=idempotency_keys.organization_id
       AND person.id=app.current_membership_id()
       AND person.user_id=app.current_user_id() AND person.status='active'));
--> statement-breakpoint
CREATE POLICY idempotency_person_insert ON platform.idempotency_keys AS RESTRICTIVE FOR INSERT TO ensemus_app
 WITH CHECK(app.is_web_login() AND app.current_actor_type()='user'
   AND membership_id=app.current_membership_id()
   AND EXISTS(SELECT 1 FROM org.memberships person
     WHERE person.organization_id=app.current_organization_id()
       AND person.organization_id=idempotency_keys.organization_id
       AND person.id=app.current_membership_id()
       AND person.user_id=app.current_user_id() AND person.status='active'));
