// Owned by the model-profiles slice (MODEL-01). See docs/06-delivery/m4-slices.md and ADR-028 FD-23. A
// synthetic conformance prompt through the real adapter, guard and lender. It proves that this address,
// this key and this wire format answer. It says nothing about how good the model is: MODEL-06 does that.
import type { RoutableProfile } from '@ensemus/application/ai-ports';
import { checkEndpoint } from '@ensemus/policy/endpoint';
import type {
  AdapterCall,
  AdapterResult,
  ContextMessage,
  CredentialLender,
  EndpointGuard,
  ModelAdapter,
  ProfileProber,
  VerifiedEndpoint,
} from './types';

/** Fixed text, so a probe can carry nothing of a tenant's: not the alias, not a name, not a document. */
export const PROBE_MESSAGES: readonly ContextMessage[] = Object.freeze([
  {
    role: 'policy',
    partId: 'probe-policy',
    text: 'You are being tested for connectivity. Answer in one short word.',
    classification: 'public',
  },
  {
    role: 'task',
    partId: 'probe-task',
    text: 'Reply with the word: ready',
    classification: 'public',
  },
]);

const PROBE_MAX_OUTPUT_TOKENS = 16;
const PROBE_TIMEOUT_MS = 60_000;

/** Codes for an operator's log. Nothing a provider said can be one of these. */
export type ProbeFailureCode =
  | 'NOT_PROBING'
  | 'ENDPOINT_REFUSED'
  | 'NO_KEY'
  | 'THREW'
  | 'NOT_A_FINAL_ANSWER'
  | 'EMPTY_ANSWER'
  | `ADAPTER_${Uppercase<Extract<AdapterResult, { kind: 'failure' }>['failure']>}`;

/** Only a final answer with words in it is a pass. A tool call with no tools offered is not conformant. */
export function judgeProbeResult(result: AdapterResult): ProbeFailureCode | null {
  if (result.kind === 'failure') {
    return `ADAPTER_${result.failure.toUpperCase()}` as ProbeFailureCode;
  }
  if (result.kind !== 'final') return 'NOT_A_FINAL_ANSWER';
  return result.text.trim() ? null : 'EMPTY_ANSWER';
}

export function createProfileProber(deps: {
  load: (input: { organizationId: string; profileId: string }) => Promise<RoutableProfile | null>;
  adapter: ModelAdapter;
  guard: EndpointGuard;
  credentials: CredentialLender;
  privateEndpoints: readonly string[];
  /** Told why a probe failed, in a code. Optional, so a failure needs no logger to fail closed. */
  onFailed?: (code: ProbeFailureCode) => void;
}): ProfileProber {
  const failed = (code: ProbeFailureCode) => {
    deps.onFailed?.(code);
    return 'failed' as const;
  };

  return {
    async probe(input) {
      try {
        const profile = await deps.load(input);
        if (!profile) return failed('NOT_PROBING');

        // Before any key is opened, and whatever the row says. The web tier checked this address when it
        // was entered, but the operator's list may have changed, and the row may not be what web wrote.
        const check = checkEndpoint(profile.providerKind, profile.endpointUrl, {
          privateEndpoints: deps.privateEndpoints,
        });
        if (!check.ok) return failed('ENDPOINT_REFUSED');
        const needsKey = profile.providerKind !== 'local_openai_compatible';
        if (needsKey && profile.secretRef === null) return failed('NO_KEY');

        const endpoint: VerifiedEndpoint = {
          host: check.host,
          port: check.port,
          protocol: new URL(profile.endpointUrl).protocol as VerifiedEndpoint['protocol'],
          viaPrivateAllowlist: check.viaPrivateAllowlist,
        };
        const call = (apiKey: Buffer | null): Promise<AdapterResult> => {
          const adapterCall: AdapterCall = {
            providerKind: profile.providerKind,
            modelId: profile.modelId,
            endpointUrl: profile.endpointUrl,
            messages: PROBE_MESSAGES,
            tools: [],
            responseSchema: null,
            maxOutputTokens: Math.min(PROBE_MAX_OUTPUT_TOKENS, profile.limits.maxOutputTokens),
            timeoutMs: PROBE_TIMEOUT_MS,
            fetch: deps.guard.fetchFor(endpoint),
            apiKey,
          };
          return deps.adapter.generate(adapterCall, AbortSignal.timeout(PROBE_TIMEOUT_MS));
        };

        const result =
          profile.secretRef === null
            ? await call(null)
            : await deps.credentials.withKey(
                {
                  organizationId: input.organizationId,
                  profileId: profile.id,
                  endpointUrl: profile.endpointUrl,
                  secretRef: profile.secretRef,
                  providerKind: profile.providerKind,
                },
                (key) => call(key),
              );

        const problem = judgeProbeResult(result);
        return problem ? failed(problem) : 'passed';
      } catch {
        // A closed key, a refused guard or a bug. Which one is not worth the risk of reading an error
        // that may quote a provider's answer, and every one of them means this profile is not proven.
        return failed('THREW');
      }
    },
  };
}
