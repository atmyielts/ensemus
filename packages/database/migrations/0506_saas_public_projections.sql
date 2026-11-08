-- Human review required. Public status and coverage expose only approved public fields.
-- Keep operator and support grants unchanged; these are column restrictions on ensemus_app.
REVOKE SELECT ON operations.incident_updates FROM ensemus_app;
--> statement-breakpoint
GRANT SELECT (id, incident_id, state, public_message, occurred_at)
  ON operations.incident_updates TO ensemus_app;
--> statement-breakpoint
REVOKE SELECT ON support.coverage_schedules FROM ensemus_app;
--> statement-breakpoint
GRANT SELECT (id, version, timezone, schedule, status, created_at)
  ON support.coverage_schedules TO ensemus_app;
