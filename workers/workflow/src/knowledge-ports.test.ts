import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createKnowledgeRuntimePorts } from './knowledge-ports';

describe('knowledge ingestion secret scan composition', () => {
  it('keeps ordinary text at its existing protection level', () => {
    const { ingest } = createKnowledgeRuntimePorts({});
    expect(ingest.contentScan.scan('A project brief with a Tuesday deadline.')).toEqual({
      raiseTo: null,
      codes: [],
    });
  });

  it('raises key material and returns codes without its bytes', () => {
    const { ingest } = createKnowledgeRuntimePorts({});
    const key = 'sk-' + 'a'.repeat(30);
    const result = ingest.contentScan.scan(`A copied key ${key}; repeated ${key}`);
    expect(result).toEqual({ raiseTo: 'restricted', codes: ['API_KEY_SHAPE'] });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(ingest.contentScan.scan('-----BEGIN PRIVATE KEY-----')).toEqual({
      raiseTo: 'restricted',
      codes: ['PEM_BLOCK'],
    });
  });

  it('uses configured canaries and refuses unreadable configuration', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ensemus-knowledge-canary-'));
    const file = path.join(directory, 'canaries.json');
    try {
      writeFileSync(file, JSON.stringify(['synthetic-project-marker']));
      const env = { ENSEMUS_SECRET_CANARIES_FILE: file };
      expect(
        createKnowledgeRuntimePorts(env).ingest.contentScan.scan('SYNTHETIC-PROJECT-MARKER'),
      ).toEqual({ raiseTo: 'restricted', codes: ['TENANT_CANARY'] });
      writeFileSync(file, '{}');
      expect(() => createKnowledgeRuntimePorts(env)).toThrow('INVALID_AGENT_CANARIES');
    } finally {
      unlinkSync(file);
      // The test removes only its known file and now-empty, uniquely created directory.
      rmdirSync(directory);
    }
  });
});
