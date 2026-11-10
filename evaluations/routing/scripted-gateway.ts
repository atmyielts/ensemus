// Assurance-only composition. The router, egress rules, endpoint rules, scan and inference gateway are
// production implementations; the stores, entitlement, transport and credential ports are explicit
// in-memory doubles. This module is outside the shipped packages/workers and never opens a socket.
import type { Tx } from '../../packages/application/src/ai/ports';
import type { RoutableProfile } from '../../packages/application/src/ai/ports';
import { createInferenceGateway } from '../../packages/intelligence/src/gateway';
import { createModelRouter } from '../../packages/intelligence/src/router';
import {
  agentContext,
  byomProfile,
  compiled,
  entitlements,
  FakeLedger,
  FakeProfileStore,
  generatedKey,
  guard,
  haltCheck,
  LoggedAdapter,
  LoggedLender,
  RecordingEgress,
  step,
  turnStore,
} from '../../packages/intelligence/src/router/doubles.test-support';
import type { ScriptStep } from '../../packages/intelligence/src/testing';
import type { CompiledTurn } from '../../packages/intelligence/src/types';
import type { TenantPolicyBundle } from '../../packages/policy/src/types';

export function scriptedGateway(input: {
  script: readonly ScriptStep[];
  profiles?: RoutableProfile[];
  canaries?: readonly string[];
  bundle?: TenantPolicyBundle;
  halt?: boolean;
}) {
  const events: string[] = [];
  const profiles = new FakeProfileStore(events, input.profiles ?? [byomProfile()]);
  const egress = new RecordingEgress(events);
  const ledger = new FakeLedger(events);
  const credentials = new LoggedLender(events, generatedKey());
  let openTransactions = 0;
  const adapter = new LoggedAdapter(events, input.script, () => openTransactions);
  const bundle = async () => input.bundle ?? null;
  const router = createModelRouter({ profiles, egress, bundle });
  const gateway = createInferenceGateway({
    router,
    egress,
    ledger,
    credentials,
    adapter,
    bundle,
    entitlements: entitlements(events),
    guard: guard(events),
    turns: turnStore(events),
    halt: haltCheck(events, () => input.halt ?? false),
    privateEndpoints: [],
    canaries: async () => input.canaries ?? [],
    async withTx(_context, fn) {
      openTransactions += 1;
      try {
        return await fn({} as Tx);
      } finally {
        openTransactions -= 1;
      }
    },
  });
  return {
    adapter,
    credentials,
    egress,
    ledger,
    events,
    profiles,
    run: (turn: CompiledTurn = compiled()) =>
      gateway.turn(agentContext(), step, turn, new AbortController().signal),
  };
}
