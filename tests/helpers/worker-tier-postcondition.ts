// Historical migration proofs compare native role spelling. 0700 intentionally maps the three
// worker logins onto that tier. Compare their source/policy projections in the original spelling,
// retaining every guard, statement order, grant, RLS and ownership check in the historical proof.
// tests/integration/worker-login-roles.test.ts independently proves the real mapping on native roles.
export function workerTierPostcondition(statement: string): string {
  const source = `replace(replace(p.prosrc,'app.tier_session_user()','session_user'),'app.tier_current_user()','current_user')`;
  return statement
    .replace(/\bp\.prosrc\b/g, source)
    .replace(
      /\bpg_get_expr\(p\.(polqual|polwithcheck),p\.polrelid\)/g,
      (expression) =>
        `replace(replace(${expression},'app.tier_session_user()','SESSION_USER'),'app.tier_current_user()','CURRENT_USER')`,
    );
}
