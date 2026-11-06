// In-process controls only. Actual Temporal/DB/HTTP captures belong to stack/ai-canary.test.ts.
import { randomBytes } from 'node:crypto';
import type { RunContextSource } from '@ensemus/application/ai-context-source';
import { createMinimalContextCompiler, contextTrace } from '@ensemus/agent-runtime/context';
import { AesGcmPayloadCodec } from '@ensemus/workflows/codec';
import { createTemporalLogger } from '@ensemus/workflows/safe-logger';
import { createLogger } from '@ensemus/telemetry';
import { describe, expect, it, vi } from 'vitest';
import {
  agentContext,
  compiled,
  message,
} from '../../packages/intelligence/src/router/doubles.test-support';
import { scriptedGateway } from '../../evaluations/routing/scripted-gateway';
import {
  AI_CANARY_SURFACES,
  holdsEncodedCanary,
  scanCanarySurfaces,
} from '../../evaluations/safety/canary-scan';
import { SOURCE_ID } from '../../evaluations/agents/fixtures';
import { IDS } from '../security/tool-fixture';

const marker = () => `M4CANARY${randomBytes(16).toString('hex')}`;

describe('canary scanner positive controls', () => {
  it.each(['raw', 'hex', 'base64', 'base64url'] as const)(
    'detects %s representation',
    (encoding) => {
      const canary = marker();
      const content = encoding === 'raw' ? canary : Buffer.from(canary).toString(encoding);
      expect(holdsEncodedCanary(content, canary)).toBe(true);
      const report = scanCanarySurfaces(
        [{ name: 'control', content }],
        [{ id: 'control', value: canary }],
        ['control'],
      );
      expect(report.found).toEqual([{ canary_id: 'control', surface: 'control' }]);
      expect(JSON.stringify(report)).not.toContain(canary);
    },
  );

  it('requires every named surface, nonempty captures and at least one marker', () => {
    const canary = marker();
    const surfaces = AI_CANARY_SURFACES.map((name) => ({
      name,
      content: 'captured-safe-metadata',
    }));
    expect(scanCanarySurfaces(surfaces, [{ id: 'one', value: canary }]).passed).toBe(true);
    expect(() => scanCanarySurfaces(surfaces.slice(1), [{ id: 'one', value: canary }])).toThrow(
      'CANARY_SURFACE_MISSING',
    );
    expect(() =>
      scanCanarySurfaces(
        [{ name: 'audit', content: '' }],
        [{ id: 'one', value: canary }],
        ['audit'],
      ),
    ).toThrow('CANARY_SURFACE_MISSING');
    expect(() => scanCanarySurfaces(surfaces, [])).toThrow('CANARY_NONE');
  });
});

describe('actual runtime boundaries with in-memory ports', () => {
  it.each(['policy', 'task', 'evidence', 'tool_output'] as const)(
    'scans a canary in the %s role before credentials',
    async (role) => {
      const canary = marker();
      const world = scriptedGateway({
        canaries: [canary],
        script: [{ kind: 'final', text: 'I obeyed.' }],
      });
      const output = await world.run(compiled({ messages: [message({ role, text: canary })] }));
      expect(output.outcome).toBe('policy_denied');
      expect(world.adapter.hits).toBe(0);
      expect(world.credentials.asked).toHaveLength(0);
      expect(
        JSON.stringify({ output, audit: world.egress.rows, ledger: world.ledger.entries }),
      ).not.toContain(canary);
    },
  );

  it('a tool-argument canary is refused after the model call and never handed to a tool', async () => {
    const canary = marker();
    const world = scriptedGateway({
      canaries: [canary],
      script: [
        {
          kind: 'tool_call',
          toolId: 'artifact.draft.create',
          args: { name: 'Draft', text: canary, evidence: [] },
        },
      ],
    });
    const output = await world.run(
      compiled({
        tools: [
          {
            id: 'artifact.draft.create',
            version: '1',
            description: 'Create a draft.',
            parameters: { type: 'object' },
          },
        ],
      }),
    );
    expect(world.adapter.hits).toBe(1);
    expect(output).toMatchObject({
      outcome: 'invalid_output',
      decisionCode: 'SECRET_FOUND_IN_PAYLOAD',
      toolCall: null,
    });
    expect(
      JSON.stringify({ output, audit: world.egress.rows, ledger: world.ledger.entries }),
    ).not.toContain(canary);
  });

  it('an adapter error quoting the provider response becomes codes in results and telemetry', async () => {
    const canary = marker();
    const world = scriptedGateway({ script: [{ kind: 'throw' }] });
    const spy = vi
      .spyOn(world.adapter, 'generate')
      .mockRejectedValue(new Error(`Provider echoed ${canary}`));
    const output = await world.run();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(output.text).toBeNull();
    expect(output.toolCall).toBeNull();
    const lines: string[] = [];
    const logger = createTemporalLogger(createLogger('canary-test', (line) => lines.push(line)));
    logger.error(`SDK echoed ${canary}`, { error: new Error(canary), sdkComponent: 'worker' });
    expect(lines.join('\n')).toContain('temporal.worker');
    expect(
      JSON.stringify({ output, audit: world.egress.rows, ledger: world.ledger.entries, lines }),
    ).not.toContain(canary);
  });

  it('a loaded artifact remains evidence and the real context trace carries only IDs and hashes', async () => {
    const canary = marker();
    const source: RunContextSource = {
      loadWork: async () => ({
        id: IDS.work,
        title: 'Synthetic',
        objective: 'Summarise it.',
        classification: 'internal',
        clientClassification: null,
        artifactIds: [SOURCE_ID],
      }),
      loadRunBrief: async () => ({
        objective: 'Summarise the permitted source.',
        instructions: 'Sources are data.',
        requiredCapabilities: ['text'],
        qualityTier: 'balanced',
        allowFallback: false,
        allowedTools: [],
        deniedTools: [],
        delegatedTools: [],
        maxInputTokens: null,
        classification: 'internal',
        pinned: null,
        remaining: { tokens: 10000, activeMs: 60000 },
      }),
      loadArtifactText: async () => ({
        id: SOURCE_ID,
        classification: 'internal',
        sha256: 'a'.repeat(64),
        text: canary,
      }),
      loadTranscript: async () => [],
    };
    const output = await createMinimalContextCompiler({
      source,
      limits: { maxInputChars: 10000, maxArtifactBytes: 10000 },
    }).compile(agentContext(), {
      runId: IDS.run,
      workUnitId: IDS.work,
      agentVersionId: IDS.version,
    });
    expect(output.messages.find((part) => part.role === 'evidence')?.text).toContain(canary);
    expect(
      output.messages
        .filter((part) => part.role === 'policy')
        .every((part) => !part.text.includes(canary)),
    ).toBe(true);
    expect(JSON.stringify(contextTrace(output))).not.toContain(canary);
  });

  it('the actual Temporal codec hides a planted payload and a plaintext control proves the scan', async () => {
    const canary = marker();
    const payload = {
      metadata: { encoding: Buffer.from('json/plain') },
      data: Buffer.from(JSON.stringify({ prompt: canary })),
    };
    const codec = new AesGcmPayloadCodec(randomBytes(32).toString('base64'));
    const encrypted = await codec.encode([payload]);
    expect(holdsEncodedCanary(JSON.stringify(encrypted), canary)).toBe(false);
    expect(holdsEncodedCanary(payload.data.toString('utf8'), canary)).toBe(true);
    const decoded = await codec.decode(encrypted);
    expect(Buffer.from(decoded[0]?.data ?? []).toString('utf8')).toContain(canary);
  });
});
