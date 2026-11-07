-- Personal preferences never let a delegated/background actor impersonate a person. Keep the existing
-- permissive tenant policy and narrow its restrictive companion to this exact active native member.
-- No new table, grant, session input or MFA action. Requires 0401's actual table/policy to exist.
DROP POLICY pulse_signal_states_own ON experience.pulse_signal_states;
--> statement-breakpoint
CREATE POLICY pulse_signal_states_own ON experience.pulse_signal_states AS RESTRICTIVE
  FOR ALL TO ensemus_app
  USING (
    app.current_actor_type() = 'user'
    AND membership_id = app.current_membership_id()
    AND EXISTS (
      SELECT 1 FROM org.memberships m
      WHERE m.organization_id = app.current_organization_id()
        AND m.id = membership_id
        AND m.id = app.current_membership_id()
        AND m.user_id = app.current_user_id()
        AND m.status = 'active'
    )
  )
  WITH CHECK (
    app.current_actor_type() = 'user'
    AND membership_id = app.current_membership_id()
    AND EXISTS (
      SELECT 1 FROM org.memberships m
      WHERE m.organization_id = app.current_organization_id()
        AND m.id = membership_id
        AND m.id = app.current_membership_id()
        AND m.user_id = app.current_user_id()
        AND m.status = 'active'
    )
  );
