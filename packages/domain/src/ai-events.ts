// Outbox event names for governed AI (ADR-028). Payloads hold identifiers and enums only. The
// dispatcher reads none of them: it acts on the event type and aggregate ID alone (ADR-024 D4).

export const AGGREGATE_WORK_UNIT = 'work_unit';
export const AGGREGATE_MODEL_PROFILE = 'model_profile';

/** Someone asked an agent to run on a Work Unit. Aggregate: the Work Unit, so the ID is the standard one. */
export const AGENT_RUN_REQUESTED = 'agent_run.requested';
/** A stop, pause or resume was recorded in `ai.run_controls`. A wake-up that carries no payload. */
export const AGENT_RUN_CONTROL_REQUESTED = 'agent_run.control_requested';
/** Someone asked to test a profile. The probe runs on the agent queue, where the key can be opened. */
export const MODEL_PROFILE_PROBE_REQUESTED = 'model_profile.probe_requested';

// Facts for projections. Nothing consumes these from the dispatcher.
export const AGENT_RUN_STARTED = 'agent_run.started';
export const AGENT_RUN_FINISHED = 'agent_run.finished';
export const MODEL_PROFILE_ACTIVATED = 'model_profile.activated';
export const MODEL_PROFILE_DISABLED = 'model_profile.disabled';
export const AGENT_VERSION_PUBLISHED = 'agent_version.published';
export const KILL_SWITCH_ENGAGED = 'kill_switch.engaged';
export const KILL_SWITCH_RELEASED = 'kill_switch.released';
