// The real adapters, through the real guard, against the fake model server, on loopback and with no outbound
// access. The same contract the scripted double passes, so the double cannot drift, then the full conformance
// list. No hosted row is qualified by this: it proves the documented wire format, not a live provider.
import {
  createEndpointGuard,
  createModelAdapter,
  type AdapterCall,
  type ModelAdapter,
} from '@ensemus/intelligence';
import type { ProviderKind } from '@ensemus/domain/ai';
import { afterAll, beforeAll } from 'vitest';
import { describeAdapterConformance } from '../conformance/adapter-conformance.suite';
import { describeCredentialLenderOverRealSealing } from '../conformance/credential-lender.suite';
import { startFakeModel, type FakeModel, type FakeScenario } from '../conformance/fake-model';
import { throwawayModelKey } from '../helpers/ai/canaries';
import { describeModelAdapterContract, type AdapterScenario } from './model-adapter.contract';

const SCENARIO: Record<AdapterScenario, FakeScenario> = {
  answers_text: 'text',
  proposes_tool: 'tool_call',
  hangs_until_aborted: 'hang',
  fails_rate_limited: 'rate_limited',
};

const KINDS: readonly ProviderKind[] = [
  'openai_hosted',
  'anthropic_hosted',
  'openai_compatible',
  'local_openai_compatible',
];

let fake: FakeModel;

beforeAll(async () => {
  fake = await startFakeModel();
});
afterAll(() => fake.close());

for (const kind of KINDS) {
  describeModelAdapterContract(`real adapter, ${kind}`, (scenario): ModelAdapter => {
    fake.reset();
    fake.setScenario(SCENARIO[scenario]);
    const real = createModelAdapter();
    const guard = createEndpointGuard();
    // The contract's own call never reaches a network, so this points it at the fake, through the guard.
    const onFake = (call: AdapterCall): AdapterCall => ({
      ...call,
      providerKind: kind,
      endpointUrl: fake.baseUrl,
      tools: [
        {
          id: 'work.read',
          version: '1',
          description: 'Read the work.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
      fetch: guard.fetchFor({
        host: fake.host,
        port: fake.port,
        protocol: 'http:',
        viaPrivateAllowlist: true,
      }),
      apiKey: Buffer.from(throwawayModelKey()),
    });
    return { generate: (call, signal) => real.generate(onFake(call), signal) };
  });
}

describeAdapterConformance();
describeCredentialLenderOverRealSealing();
