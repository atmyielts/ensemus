import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentCanaries, loadAgentContextLimits } from './agent-settings';

describe('agent process limits', () => {
  it('accepts explicit positive caps and keeps a bounded default without model budgets', () => {
    expect(loadAgentContextLimits({})).toEqual({
      maxInputChars: 1_048_576,
      maxArtifactBytes: 1_048_576,
    });
    expect(
      loadAgentContextLimits({
        ENSEMUS_AGENT_CONTEXT_MAX_CHARS: '42',
        ENSEMUS_AGENT_ARTIFACT_MAX_BYTES: '17',
      }),
    ).toEqual({ maxInputChars: 42, maxArtifactBytes: 17 });
  });

  it.each(['0', '-1', '1.2', 'Infinity', '9007199254740992', ' 5', ''])(
    'refuses invalid cap %s',
    (value) => {
      expect(() => loadAgentContextLimits({ ENSEMUS_AGENT_CONTEXT_MAX_CHARS: value })).toThrow(
        'INVALID_AGENT_CONTEXT_LIMIT',
      );
    },
  );

  it('has no canary value unless an operator supplies it', () => {
    expect(loadAgentCanaries({})).toEqual([]);
  });

  it('loads only a bounded list of literal deployment markers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ensemus-agent-settings-'));
    const path = join(directory, 'markers.json');
    try {
      writeFileSync(path, JSON.stringify(['generated-marker']));
      expect(loadAgentCanaries({ ENSEMUS_SECRET_CANARIES_FILE: path })).toEqual([
        'generated-marker',
      ]);
      for (const invalid of [null, {}, [''], [5], ['x'.repeat(4097)]]) {
        writeFileSync(path, JSON.stringify(invalid));
        expect(() => loadAgentCanaries({ ENSEMUS_SECRET_CANARIES_FILE: path })).toThrow(
          'INVALID_AGENT_CANARIES',
        );
      }
      writeFileSync(path, ' '.repeat(1_048_577));
      expect(() => loadAgentCanaries({ ENSEMUS_SECRET_CANARIES_FILE: path })).toThrow(
        'INVALID_AGENT_CANARIES',
      );
    } finally {
      rmSync(path, { force: true });
      rmdirSync(directory);
    }
  });
});
